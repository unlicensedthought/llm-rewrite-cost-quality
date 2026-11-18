#!/usr/bin/env node
// Writes a small SYNTHETIC run (made-up text, made-up costs, made-up scores) in the layout
// src/analyze.mjs reads. It exists to exercise the code and to show the report shape.
// None of its numbers are measurements.
//   node scripts/make-synthetic-run.mjs <outDir>
import fs from 'node:fs';
import path from 'node:path';
import { mulberry32 } from '../src/select-corpus.mjs';

const out = process.argv[2];
if (!out) {
  console.error('usage: node scripts/make-synthetic-run.mjs <outDir>');
  process.exit(2);
}
fs.mkdirSync(out, { recursive: true });
const rnd = mulberry32(7);
const pick = (lo, hi) => lo + (hi - lo) * rnd();
const clamp = (v) => Math.max(1, Math.min(5, Math.round(v)));

// tier, requested model, base quality, base cost per call, cache-on cost multiplier
const MODELS = [
  { tier: 'T2', model: 'big-latest', q: 4.7, cost: 0.00012, mult: 2 },
  { tier: 'T2', model: 'small-latest', q: 4.3, cost: 0.00004, mult: 2.5 },
  { tier: 'T3', model: 'big-latest', q: 4.4, cost: 0.00004, mult: 2.7 },
];
const SEGMENTS = 24;
const candidates = [];
const units = [];
let seed = 1000;
for (let s = 0; s < SEGMENTS; s++) {
  const segment_id = `s${s}`;
  const original = `Synthetic segment ${s}: the keeper climbed the stairs, lit the lamp, and logged the tide.`;
  for (const m of MODELS) {
    for (const cache of [false, true]) {
      const fail = rnd() < (cache ? 0.18 : 0.03);
      // Some calls on the "small" model fall back to a different backend.
      const fallback = m.model === 'small-latest' && rnd() < 0.3;
      const rewritten = `Rewrite (${m.tier}/${m.model}/${cache ? 'on' : 'off'}) of segment ${s}: the keeper lit the lamp.`;
      candidates.push({
        segment_id, tier: m.tier, requested_model: m.model, cache_requested: cache, seed: seed++,
        ok: !fail, verifier_passes: fail ? null : rnd() < (cache ? 0.8 : 0.97),
        model_version: fail ? null : `${fallback ? 'vendor-b' : 'vendor-a'}:model-x:seed=${seed}`,
        usage: fail ? null : {
          inputTokens: cache ? 2400 : 290, cachedTokens: cache ? 2300 : 0, outputTokens: 120,
          estimatedCostUsd: m.cost * (cache ? m.mult : 1) * (fallback ? 4 : 1) * pick(0.9, 1.1),
        },
        original_text: original, rewritten_text: fail ? null : rewritten,
      });
    }
  }
}
// Judge one candidate per (segment, tier, model): the cache-off one when it succeeded.
const judged = [];
for (const m of MODELS) {
  for (let s = 0; s < SEGMENTS; s++) {
    const c = candidates.filter((r) => r.segment_id === `s${s}` && r.tier === m.tier && r.requested_model === m.model && r.ok)
      .sort((a, b) => Number(a.cache_requested) - Number(b.cache_requested))[0];
    if (c) judged.push(c);
  }
}
judged.forEach((c, i) => units.push({
  uid: `u${i}`, segment_id: c.segment_id, tier: c.tier, requested_model: c.requested_model,
  edge_set: [], original_text: c.original_text, rewritten_text: c.rewritten_text,
}));
const batches = [];
for (let i = 0; i < units.length; i += 6) batches.push(units.slice(i, i + 6));

const base = Object.fromEntries(MODELS.map((m) => [`${m.tier}|${m.model}`, m.q]));
const DIMS = ['faithfulness', 'causal_preservation', 'style_adherence', 'fluency', 'conciseness'];
const JUDGES = [
  ['vendor-c:lens0', 0], ['vendor-c:lens1', -0.05], ['vendor-b-judge', 0.1],
];
const latent = new Map(units.map((u) => [u.uid, base[`${u.tier}|${u.requested_model}`] + pick(-0.6, 0.4)]));
const scoreRows = new Map(JUDGES.map(([j]) => [j, []]));
for (const u of units) {
  for (const [j, off] of JUDGES) {
    const noise = j === 'vendor-b-judge' ? 0.45 : 0.15;
    const dims = Object.fromEntries(DIMS.map((d) => [d, clamp(latent.get(u.uid) + off + pick(-noise, noise))]));
    scoreRows.get(j).push({ uid: u.uid, judge: j, dims });
  }
}
const wr = (f, rows) => fs.writeFileSync(path.join(out, f), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
wr('candidates.jsonl', candidates);
fs.writeFileSync(path.join(out, 'judge-batches.json'), JSON.stringify({ n_units: units.length, batches }));
wr('scores-vendor-c.jsonl', [...scoreRows.get('vendor-c:lens0'), ...scoreRows.get('vendor-c:lens1')]);
wr('scores-vendor-b.jsonl', scoreRows.get('vendor-b-judge'));
console.log(`wrote ${candidates.length} candidates, ${units.length} judged units to ${out}`);
