/**
 * Rubric judge panel for rewrite quality: five weighted dimensions, a pass rule,
 * a hallucination flagger that caps faithfulness, per-judge z-normalization and a
 * Cohen's kappa gate. The model call is injected, so nothing here touches a network.
 *
 * callJudge(systemPrompt, userContent) must resolve to the parsed JSON object the
 * prompt asks for, or null when the call failed.
 */

import fs from 'node:fs';
import path from 'node:path';

// ─────────────────────────── Tier weights ──────────────────────
/** Per-tier dimension weights from the rubric doc (rows sum to 1.0). */
export const TIER_WEIGHTS = {
  T1:      { D1: 0.30, D2: 0.30, D3: 0.10, D4: 0.20, D5: 0.10 },
  T2:      { D1: 0.25, D2: 0.20, D3: 0.30, D4: 0.15, D5: 0.10 },
  T3:      { D1: 0.35, D2: 0.30, D3: 0.10, D4: 0.15, D5: 0.10 },
  revoice: { D1: 0.25, D2: 0.20, D3: 0.35, D4: 0.15, D5: 0.05 },
};

export const DIMS = ['D1', 'D2', 'D3', 'D4', 'D5'];

// ─────────────────────────── Scoring helpers ───────────────────

/**
 * Compute the weighted overall score for a set of dimension scores and a tier.
 * @param {{ D1:number, D2:number, D3:number, D4:number, D5:number }} scores
 * @param {'T1'|'T2'|'T3'|'revoice'} tier
 * @returns {number}
 */
export function weightedOverall(scores, tier) {
  const W = TIER_WEIGHTS[tier] ?? TIER_WEIGHTS.T1;
  let sum = 0;
  let wSum = 0;
  for (const d of DIMS) {
    if (typeof scores[d] === 'number') {
      sum += W[d] * scores[d];
      wSum += W[d];
    }
  }
  return wSum > 0 ? sum / wSum : 0;
}

/**
 * Apply pass/fail rules from the rubric.
 * Pass requires overall >= 3.5 AND every dim >= 3.
 * D1 < 3 or D2 < 3 is P0 (also a hard fail).
 * @param {{ D1:number, D2:number, D3:number, D4:number, D5:number }} scores
 * @param {number} overall
 * @returns {{ pass: boolean, hard_fail_dimension: string|null, p0: boolean }}
 */
export function passFailRules(scores, overall) {
  let hardFailDim = null;
  let p0 = false;

  for (const d of DIMS) {
    if (typeof scores[d] === 'number' && scores[d] < 3) {
      if (!hardFailDim) hardFailDim = d;
      if (d === 'D1' || d === 'D2') p0 = true;
    }
  }

  // 1e-9 epsilon handles floating-point imprecision in weighted sums
  const pass = overall >= 3.5 - 1e-9 && hardFailDim === null;
  return { pass, hard_fail_dimension: hardFailDim, p0 };
}

// ─────────────────────────── Z-normalization ──────────────────

/**
 * Z-normalize a flat array of per-judge score rows across the batch.
 * Each row has { uid, dims: { D1..D5 } }.
 * Returns new rows with z-normalized dims (mean=0, sigma=1 per dim).
 * If sigma==0 for a dim, scores are left unchanged.
 *
 * This removes a model's constant leniency bias (e.g. one judge scoring +0.15 higher on average).
 *
 * @param {Array<{uid:string, dims:{D1:number,D2:number,D3:number,D4:number,D5:number}}>} rows
 * @returns {Array}
 */
export function zNormalizeJudgeRows(rows) {
  if (!rows || rows.length === 0) return rows;

  const stats = {};
  for (const d of DIMS) {
    const vals = rows.map((r) => r.dims[d]).filter((v) => typeof v === 'number');
    const n = vals.length;
    if (n === 0) { stats[d] = { mean: 0, std: 1 }; continue; }
    const mean = vals.reduce((a, b) => a + b, 0) / n;
    const variance = vals.reduce((a, v) => a + (v - mean) ** 2, 0) / n;
    const std = Math.sqrt(variance);
    stats[d] = { mean, std: std > 0 ? std : 1 };
  }

  return rows.map((r) => ({
    ...r,
    dims: Object.fromEntries(
      DIMS.map((d) => [
        d,
        typeof r.dims[d] === 'number' ? (r.dims[d] - stats[d].mean) / stats[d].std : r.dims[d],
      ]),
    ),
    _znorm: true,
    _znorm_stats: stats,
  }));
}

// ─────────────────────────── Cohen's kappa ────────────────────

/**
 * Compute Cohen's kappa for inter-rater agreement.
 * Scores are binarized at the pass threshold (overall >= 3.5) to produce two-class labels.
 * Loud-flags if kappa < 0.6.
 *
 * @param {Array<{uid:string, overall:number}>} judgeA
 * @param {Array<{uid:string, overall:number}>} judgeB
 * @param {number} [sliceSize=20]
 * @returns {{ kappa: number|null, flagged: boolean, n: number }}
 */
export function cohensKappaGate(judgeA, judgeB, sliceSize = 20) {
  const mapA = new Map(judgeA.map((r) => [r.uid, r.overall]));
  const mapB = new Map(judgeB.map((r) => [r.uid, r.overall]));

  const sharedUids = [...mapA.keys()].filter((uid) => mapB.has(uid));
  const slice = sharedUids.slice(0, sliceSize);

  if (slice.length < 2) {
    return { kappa: null, flagged: false, n: slice.length };
  }

  // Binarize: 1 = pass (overall >= 3.5), 0 = fail
  const labelsA = slice.map((uid) => (mapA.get(uid) >= 3.5 ? 1 : 0));
  const labelsB = slice.map((uid) => (mapB.get(uid) >= 3.5 ? 1 : 0));

  const n = slice.length;
  let a00 = 0, a01 = 0, a10 = 0, a11 = 0;
  for (let i = 0; i < n; i++) {
    const la = labelsA[i], lb = labelsB[i];
    if (la === 0 && lb === 0) a00++;
    else if (la === 0 && lb === 1) a01++;
    else if (la === 1 && lb === 0) a10++;
    else a11++;
  }

  const po = (a00 + a11) / n;
  const pA1 = (a10 + a11) / n;
  const pB1 = (a01 + a11) / n;
  const pe = pA1 * pB1 + (1 - pA1) * (1 - pB1);

  const kappa = pe === 1 ? 1 : (po - pe) / (1 - pe);
  const flagged = kappa < 0.6;

  if (flagged) {
    console.error(
      `[rubric-judge] KAPPA GATE FAIL — Cohen's kappa=${kappa.toFixed(3)} < 0.6 on ${n}-candidate slice. ` +
      'Absolute scores LOW-CONFIDENCE. Revise few-shot anchors.',
    );
  } else {
    console.log(`[rubric-judge] Kappa gate OK — kappa=${kappa.toFixed(3)} (n=${n})`);
  }

  return { kappa, flagged, n };
}

/**
 * Cross-judge kappa: compare pass/fail agreement between two judge row arrays.
 * Convenience wrapper around cohensKappaGate.
 */
export function crossJudgeKappa(rowsA, rowsB, sliceSize = 20) {
  const a = rowsA.map((r) => ({ uid: r.uid, overall: r.overall }));
  const b = rowsB.map((r) => ({ uid: r.uid, overall: r.overall }));
  return cohensKappaGate(a, b, sliceSize);
}

// ─────────────────────────── Prompts ─────────────────────────

const FEW_SHOT_EXEMPLARS = `
## Calibration exemplars (internalize before judging — these are your score anchors)

### D1 Faithfulness
- SCORE 1: Rewrite introduces a character "Elena" not present in the source. Score: 1.
- SCORE 3: Rewrite says "he crossed the bridge in the afternoon" when source says "at dusk" — minor imprecision, plot intact. Score: 3.
- SCORE 5: Every detail in the rewrite maps directly to the source; nothing invented. Score: 5.

### D2 Causal preservation
- SCORE 1: Setup "he hid the key under the mat" omitted entirely — payoff ("she found the spare key") incoherent. Score: 1.
- SCORE 3: All setup→payoff edges present but minor reordering buries cause before effect on same page. Score: 3.
- SCORE 5: Both anchor quotes for every edge are paraphraseable from the rewrite; no causal link severed. Score: 5.

### D3 Register / tone fidelity
- SCORE 1: Source is breezy comic banter; rewrite is formal academic prose. Score: 1.
- SCORE 3: Some tonal drift — a few lines land in different register, overall voice still recognizable. Score: 3.
- SCORE 5: T2 conversational rewrite reads naturally conversational throughout; T1/T3 indistinguishable from source author. Score: 5.

### D4 Narrative transportation / immersion
- SCORE 1: Dry Wikipedia synopsis — list of events with no narrative flow or emotional texture. Score: 1.
- SCORE 3: Flows smoothly but emotionally flat; reader follows without being pulled in. Score: 3.
- SCORE 5: Despite compression, scene is vivid and immediate; reader would not notice the seams. Score: 5.

### D5 Readability / mechanics
- SCORE 1: Multiple grammatical errors, dangling modifier, truncated sentence mid-thought. Score: 1.
- SCORE 3: Readable; one slightly awkward phrase, no structural issues. Score: 3.
- SCORE 5: Flawless grammar, clean clause structure, no artifacts or meta-commentary. Score: 5.
`;

export const PRIMARY_JUDGE_PROMPT = `You are a STRICT literary-rewrite quality judge. Candidates were produced by an AI rewrite engine for a reader-engagement system that compresses/transforms long-form fiction.

Score each candidate on FIVE dimensions (1–5 integer):
- D1 Faithfulness: no hallucination, no dropped load-bearing content
- D2 Causal-dependency preservation: setup→payoff edges intact per the edge_set
- D3 Register/tone fidelity: original voice for T1/T3; target register for T2/revoice
- D4 Narrative transportation/immersion: absorbing despite transform
- D5 Readability/mechanics: grammar, flow, no artifacts

TIER INTENT:
- T1 = sentence-level compression 15–25% shorter. Identity output (rewritten==original) → D1=5 but D5≈1.
- T2 = register/voice shift to conversational. SAME content, different prose register.
- T3 = narrative summary preserving causal elements. Must NOT invent or drop load-bearing facts.
- revoice = author-voice style transfer; D3 fidelity is to the TARGET author, not source.

MANDATORY SCORING PROTOCOL:
1. For EACH dimension, write one sentence of chain-of-thought reasoning.
2. THEN emit the integer score (1–5).
3. Do NOT cluster at 4. Reserve 5 for genuinely excellent. Use 1–2 for real failures.

${FEW_SHOT_EXEMPLARS}

Return ONLY this JSON (no markdown wrapper):
{
  "candidates": [
    {
      "uid": "<uid>",
      "reasoning": { "D1": "...", "D2": "...", "D3": "...", "D4": "...", "D5": "..." },
      "scores": { "D1": 1-5, "D2": 1-5, "D3": 1-5, "D4": 1-5, "D5": 1-5 },
      "flagged_claims": []
    }
  ]
}`;

export const ADVERSARIAL_FLAGGER_PROMPT = `You are a HALLUCINATION DETECTOR reviewing literary rewrites against their source text.

Your ONLY job: identify claims in the rewrite that are NOT supported by the source text.
A "claim" is any fact, event, character, object, or causal relationship stated in the rewrite.

Return ONLY this JSON:
{
  "candidates": [
    {
      "uid": "<uid>",
      "flagged_claims": ["<verbatim unsupported claim>", ...]
    }
  ]
}

Rules:
- flagged_claims = [] if nothing is invented.
- Only flag genuine inventions, not paraphrases of the same fact.
- Be precise: quote the exact phrase from the rewrite.`;

// ─────────────────────────── Core judge logic ─────────────────

/**
 * Judge a single batch of candidate units.
 * Returns an array of rubric score rows conforming to the JSON output contract.
 *
 * @param {Array<{uid:string, tier:string, edge_set:Array, original_text:string, rewritten_text:string}>} units
 * @param {string} judgeId
 * @param {(system:string,user:string)=>Promise<object|null>} callJudge
 * @returns {Promise<Array>}
 */
export async function judgeBatch(units, judgeId, callJudge) {
  const payload = units.map((u) => ({
    uid: u.uid,
    tier: u.tier,
    edge_set: u.edge_set,
    original_text: u.original_text,
    rewritten_text: u.rewritten_text,
  }));
  const userContent = `CANDIDATES (${units.length}):\n${JSON.stringify(payload)}`;

  // Step 1: Primary judge with CoT + scores
  const primary = await callJudge(PRIMARY_JUDGE_PROMPT, userContent);
  if (!primary || !Array.isArray(primary.candidates)) {
    console.error(`[rubric-judge:${judgeId}] primary judge null/invalid response`);
    return [];
  }

  // Step 2: Anti-leniency adversarial flagger
  const flagger = await callJudge(ADVERSARIAL_FLAGGER_PROMPT, userContent);
  const flagMap = new Map();
  if (flagger && Array.isArray(flagger.candidates)) {
    for (const c of flagger.candidates) {
      if (Array.isArray(c.flagged_claims) && c.flagged_claims.length > 0) {
        flagMap.set(c.uid, c.flagged_claims);
      }
    }
  }

  // Step 3: Synthesize — cap D1 at 2 if adversarial flagger found hallucinations
  const rows = [];
  for (const c of primary.candidates) {
    const rawScores = c.scores ?? {};
    const scores = {
      D1: rawScores.D1 ?? null,
      D2: rawScores.D2 ?? null,
      D3: rawScores.D3 ?? null,
      D4: rawScores.D4 ?? null,
      D5: rawScores.D5 ?? null,
    };
    const flaggedClaims = flagMap.get(c.uid) ?? [];

    // Anti-leniency cap: adversarial flagger found hallucinations → D1 must be <= 2
    if (flaggedClaims.length > 0 && scores.D1 !== null && scores.D1 > 2) {
      console.warn(`[rubric-judge:${judgeId}] uid=${c.uid}: flagger found ${flaggedClaims.length} claim(s), capping D1 ${scores.D1}→2`);
      scores.D1 = 2;
    }

    const unitTier = units.find((u) => u.uid === c.uid)?.tier ?? 'T1';
    const overall = weightedOverall(scores, unitTier);
    const { pass, hard_fail_dimension, p0 } = passFailRules(scores, overall);

    if (p0) {
      console.error(`[rubric-judge:${judgeId}] P0 FAIL uid=${c.uid} tier=${unitTier} dim=${hard_fail_dimension}`);
    }

    rows.push({
      uid: c.uid,
      judge: judgeId,
      tier: unitTier,
      scores,
      reasoning: c.reasoning ?? {},
      overall: Math.round(overall * 1000) / 1000,
      pass,
      hard_fail_dimension: hard_fail_dimension ?? null,
      flagged_claims: flaggedClaims,
      p0: p0 ?? false,
    });
  }

  return rows;
}

// ─────────────────────────── Panel runner ─────────────────────

/**
 * Run the panel over every batch-N.json in batchesDir and write scores-rubric-<judgeId>.jsonl.
 * Rows carry z-normalized dims next to the raw ones.
 */
export async function runPanel({ batchesDir, outDir, judgeId, callJudge, concurrency = 4 }) {
  if (!fs.existsSync(batchesDir)) throw new Error(`batchesDir not found: ${batchesDir}`);
  const batchFiles = fs.readdirSync(batchesDir)
    .filter((f) => /^batch-\d+\.json$/.test(f))
    .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));
  if (batchFiles.length === 0) throw new Error(`No batch-*.json files in ${batchesDir}`);

  const allRows = [];
  let i = 0;
  async function worker() {
    while (i < batchFiles.length) {
      const batchFile = batchFiles[i++];
      const units = JSON.parse(fs.readFileSync(path.join(batchesDir, batchFile), 'utf8'));
      allRows.push(...(await judgeBatch(units, judgeId, callJudge)));
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  const normalized = zNormalizeJudgeRows(allRows.map((r) => ({ uid: r.uid, dims: r.scores })));
  const znormMap = new Map(normalized.map((r) => [r.uid, r.dims]));
  const outRows = allRows.map((r) => ({ ...r, znorm_dims: znormMap.get(r.uid) ?? r.scores }));
  const outFile = path.join(outDir, `scores-rubric-${judgeId}.jsonl`);
  fs.writeFileSync(outFile, outRows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return outRows;
}
