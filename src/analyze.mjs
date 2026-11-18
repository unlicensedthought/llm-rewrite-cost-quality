#!/usr/bin/env node
// Cost-vs-quality analysis for a rewrite pipeline.
//   node src/analyze.mjs <runDir>
// A run directory holds:
//   candidates.jsonl    one row per generated candidate (config, usage, texts, model_version)
//   judge-batches.json  { batches: [[unit, ...], ...] } - the units that were sent to the judges
//   scores-*.jsonl      one row per (uid, judge): { uid, judge, dims: { ... } }
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mean, pearson, meanAbsDiff, markPareto } from './stats.mjs';

export const WEIGHTS = { faithfulness: 0.35, causal_preservation: 0.25, style_adherence: 0.15, fluency: 0.15, conciseness: 0.1 };
const DIMS = Object.keys(WEIGHTS);

const readJsonl = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

export function composite(dims) {
  let s = 0;
  let w = 0;
  for (const k of DIMS) {
    if (typeof dims[k] === 'number') {
      s += WEIGHTS[k] * dims[k];
      w += WEIGHTS[k];
    }
  }
  return w ? s / w : null;
}

/** Which backend served the call: the prefix of model_version ("vendor:model:..."), or "none" when the call failed. */
export function servedBy(r) {
  const mv = r.model_version;
  if (!mv) return 'none';
  return String(mv).split(':')[0];
}

export function loadRun(dir) {
  const candidates = readJsonl(path.join(dir, 'candidates.jsonl'));
  const batchDoc = JSON.parse(fs.readFileSync(path.join(dir, 'judge-batches.json'), 'utf8'));
  const units = new Map();
  for (const batch of batchDoc.batches) for (const u of batch) units.set(u.uid, u);
  const scoreFiles = fs.readdirSync(dir).filter((f) => /^scores-.*\.jsonl$/.test(f)).sort();
  if (scoreFiles.length === 0) throw new Error(`no scores-*.jsonl in ${dir}`);
  const scores = scoreFiles.flatMap((f) => readJsonl(path.join(dir, f)));
  return { candidates, units, scores };
}

// Quality is keyed by (segment, tier, model). Cache setting is not part of the key:
// one candidate per key is judged, so cache-on and cache-off cells share a Q by construction.
const qKey = (u) => `${u.segment_id}|${u.tier}|${u.requested_model}`;

export function analyze({ candidates, units, scores }) {
  const byKey = new Map();
  for (const r of scores) {
    const u = units.get(r.uid);
    if (!u) continue;
    const k = qKey(u);
    if (!byKey.has(k)) byKey.set(k, { unit: u, judgeRows: [] });
    byKey.get(k).judgeRows.push({ judge: r.judge, dims: r.dims, uid: r.uid });
  }

  const judges = [...new Set(scores.map((s) => s.judge))].sort();
  const keys = [...byKey.keys()];
  const perJudge = Object.fromEntries(judges.map((j) => [j, []]));
  for (const k of keys) {
    const jr = byKey.get(k).judgeRows;
    for (const j of judges) {
      const comps = jr.filter((x) => x.judge === j).map((x) => composite(x.dims)).filter((c) => c != null);
      perJudge[j].push(comps.length ? mean(comps) : null);
    }
  }
  const agreement = [];
  for (let i = 0; i < judges.length; i++) {
    for (let j = i + 1; j < judges.length; j++) {
      agreement.push({
        a: judges[i],
        b: judges[j],
        r: pearson(perJudge[judges[i]], perJudge[judges[j]]),
        mad: meanAbsDiff(perJudge[judges[i]], perJudge[judges[j]]),
      });
    }
  }

  // Which backend served the judged unit? Match unit to candidate on key + exact rewritten text.
  const candByText = new Map();
  for (const r of candidates) if (r.ok) candByText.set(`${qKey(r)}|${r.rewritten_text}`, r);
  const unitBackend = new Map();
  for (const [uid, u] of units) {
    const c = candByText.get(`${qKey(u)}|${u.rewritten_text}`);
    unitBackend.set(uid, c ? servedBy(c) : 'unmatched');
  }
  const overlap = judges.map((j) => {
    const needle = j.toLowerCase();
    const hits = new Set();
    for (const { judgeRows } of byKey.values()) {
      for (const row of judgeRows) {
        if (row.judge !== j) continue;
        const be = unitBackend.get(row.uid);
        if (be && be !== 'none' && be !== 'unmatched' && needle.includes(be.toLowerCase())) hits.add(row.uid);
      }
    }
    return { judge: j, selfJudged: hits.size };
  });

  const cellOf = (r, split) => {
    const cache = r.cache_requested ? 'cacheON' : 'cacheOFF';
    const model = String(r.requested_model).replace(/-latest$/, '');
    return `${r.tier}|${model}|${cache}${split ? `|${servedBy(r)}` : ''}`;
  };
  const bump = (split) => {
    const m = new Map();
    for (const r of candidates) {
      const id = cellOf(r, split);
      if (!m.has(id)) m.set(id, { n: 0, ok: 0, vpass: 0, costs: [], inTok: [], cachedTok: [], outTok: [], q: [], dims: {} });
      const o = m.get(id);
      o.n++;
      if (r.ok) o.ok++;
      if (r.verifier_passes === true) o.vpass++;
      if (r.usage) {
        o.costs.push(r.usage.estimatedCostUsd || 0);
        o.inTok.push(r.usage.inputTokens || 0);
        o.cachedTok.push(r.usage.cachedTokens || 0);
        o.outTok.push(r.usage.outputTokens || 0);
      }
      const entry = byKey.get(qKey(r));
      if (!entry) continue;
      // Without the split, every cell in a key shares its Q. With the split, only the judged candidate counts.
      if (split && candByText.get(`${qKey(r)}|${entry.unit.rewritten_text}`) !== r) continue;
      const c = mean(entry.judgeRows.map((x) => composite(x.dims)).filter((v) => v != null));
      if (c != null) o.q.push(c);
      for (const d of DIMS) {
        const dv = mean(entry.judgeRows.map((x) => x.dims[d]).filter((v) => typeof v === 'number'));
        if (dv != null) (o.dims[d] ||= []).push(dv);
      }
    }
    return m;
  };
  const toRows = (m, split) =>
    [...m.entries()].map(([id, o]) => {
      const [tier, model, cache, backend] = id.split('|');
      return {
        tier, model, cache, backend: split ? backend : undefined,
        n: o.n, ok: o.ok, vpass: o.n ? o.vpass / o.n : null,
        cost: mean(o.costs), inTok: mean(o.inTok), cachedTok: mean(o.cachedTok), outTok: mean(o.outTok),
        q: mean(o.q), nQ: o.q.length,
        dims: Object.fromEntries(DIMS.map((d) => [d, mean(o.dims[d] || [])])),
      };
    });
  const qBy = new Map();
  for (const [, { unit, judgeRows }] of byKey) {
    const id = `${unit.tier}|${String(unit.requested_model).replace(/-latest$/, '')}|${unitBackend.get(judgeRows[0].uid)}`;
    const c = mean(judgeRows.map((x) => composite(x.dims)).filter((v) => v != null));
    if (c != null) {
      if (!qBy.has(id)) qBy.set(id, []);
      qBy.get(id).push(c);
    }
  }
  const qualityByBackend = [...qBy.entries()].map(([id, v]) => {
    const [tier, model, backend] = id.split('|');
    return { tier, model, backend, nQ: v.length, q: mean(v) };
  });
  const rows = markPareto(toRows(bump(false), false));
  const bySplit = toRows(bump(true), true);

  return {
    nCandidates: candidates.length,
    nOk: candidates.filter((r) => r.ok).length,
    nKeys: byKey.size,
    nJudgeRows: scores.length,
    totalCost: candidates.reduce((a, r) => a + (r.usage?.estimatedCostUsd || 0), 0),
    judges, agreement, overlap,
    judgeMeans: Object.fromEntries(judges.map((j) => [j, mean(perJudge[j].filter((v) => v != null))])),
    rows, bySplit, qualityByBackend,
  };
}

const f5 = (x) => (x == null ? '-' : x.toFixed(5));
const f2 = (x) => (x == null ? '-' : x.toFixed(2));
const f0 = (x) => (x == null ? '-' : String(Math.round(x)));

export function render(a) {
  let md = '# Cost-vs-quality frontier\n\n';
  md += `- Candidates: ${a.nCandidates} (ok ${a.nOk})\n`;
  md += `- Quality keys scored: ${a.nKeys} | judges: ${a.judges.join(', ')} | judge rows: ${a.nJudgeRows}\n`;
  md += `- Total generation cost: $${a.totalCost.toFixed(5)}\n`;
  md += `- Composite weights: ${JSON.stringify(WEIGHTS)}\n\n`;
  md += '## Judge agreement\n\n| Judge A | Judge B | Pearson r | mean abs diff |\n|---|---|---|---|\n';
  for (const x of a.agreement) md += `| ${x.a} | ${x.b} | ${f2(x.r)} | ${f2(x.mad)} |\n`;
  md += `\nPer-judge mean composite: ${a.judges.map((j) => `${j}=${f2(a.judgeMeans[j])}`).join(', ')}\n\n`;
  md += '## Judge/candidate overlap\n\nJudged units whose serving backend matches the judge:\n\n';
  for (const o of a.overlap) md += `- ${o.judge}: ${o.selfJudged}\n`;
  md += '\n## Config cells (backends pooled)\n\n';
  md += '| tier / model / cache | n | $/call | inTok | cachedTok | outTok | verifier% | Q | Pareto |\n|---|---|---|---|---|---|---|---|---|\n';
  for (const r of [...a.rows].sort((x, y) => (y.q ?? -1) - (x.q ?? -1))) {
    md += `| ${r.tier} ${r.model} ${r.cache} | ${r.n} | ${f5(r.cost)} | ${f0(r.inTok)} | ${f0(r.cachedTok)} | ${f0(r.outTok)} | ${r.vpass != null ? (r.vpass * 100).toFixed(0) + '%' : '-'} | ${f2(r.q)} | ${r.pareto ? 'yes' : ''} |\n`;
  }
  md += '\n## Config cells split by serving backend\n\n';
  md += '| tier / model / cache | served by | n | $/call | judged n | Q |\n|---|---|---|---|---|---|\n';
  for (const r of [...a.bySplit].sort((x, y) => `${x.tier}${x.model}${x.cache}${x.backend}`.localeCompare(`${y.tier}${y.model}${y.cache}${y.backend}`))) {
    md += `| ${r.tier} ${r.model} ${r.cache} | ${r.backend} | ${r.n} | ${f5(r.cost)} | ${r.nQ} | ${f2(r.q)} |\n`;
  }
  md += '\n## Quality by serving backend (cache settings pooled)\n\n| tier / model | served by | judged n | Q |\n|---|---|---|---|\n';
  for (const r of [...a.qualityByBackend].sort((x, y) => `${x.tier}${x.model}${x.backend}`.localeCompare(`${y.tier}${y.model}${y.backend}`))) {
    md += `| ${r.tier} ${r.model} | ${r.backend} | ${r.nQ} | ${f2(r.q)} |\n`;
  }
  md += '\n## Pareto-optimal cells (maximize Q, minimize $/call)\n\n';
  for (const r of a.rows.filter((r) => r.pareto).sort((x, y) => y.q - x.q)) {
    md += `- ${r.tier} ${r.model} ${r.cache}: Q=${f2(r.q)}, $${f5(r.cost)}/call, Q per dollar=${f0(r.q / (r.cost || 1e-9))}\n`;
  }
  return md;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: node src/analyze.mjs <runDir>');
    process.exit(2);
  }
  console.log(render(analyze(loadRun(dir))));
}
