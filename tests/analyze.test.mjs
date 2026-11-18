import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { composite, servedBy, loadRun, analyze, render } from '../src/analyze.mjs';
import { pearson, meanAbsDiff, markPareto } from '../src/stats.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.join(here, '..');

test('composite weights sum to one and renormalize over missing dims', () => {
  assert.equal(composite({ faithfulness: 5, causal_preservation: 5, style_adherence: 5, fluency: 5, conciseness: 5 }), 5);
  assert.ok(Math.abs(composite({ faithfulness: 4, causal_preservation: 4 }) - 4) < 1e-12);
  assert.equal(composite({}), null);
});

test('pearson: perfect line is 1, inverse is -1, too few points is null', () => {
  assert.ok(Math.abs(pearson([1, 2, 3, 4], [2, 4, 6, 8]) - 1) < 1e-12);
  assert.ok(Math.abs(pearson([1, 2, 3, 4], [8, 6, 4, 2]) + 1) < 1e-12);
  assert.equal(pearson([1, 2], [1, 2]), null);
  assert.equal(pearson([1, 1, 1], [1, 2, 3]), null);
});

test('pearson and meanAbsDiff skip pairs with a null side', () => {
  assert.ok(Math.abs(pearson([1, null, 2, 3], [1, 9, 2, 3]) - 1) < 1e-12);
  assert.equal(meanAbsDiff([1, null, 3], [2, 5, 3]), 0.5);
});

test('markPareto: dominated cell is not on the frontier, ties are kept', () => {
  const rows = markPareto([
    { id: 'a', q: 4.7, cost: 0.0004 },
    { id: 'b', q: 4.6, cost: 0.0001 },
    { id: 'c', q: 4.5, cost: 0.0003 }, // dominated by b
    { id: 'd', q: 4.6, cost: 0.0001 }, // tie with b
  ]);
  const on = rows.filter((r) => r.pareto).map((r) => r.id).sort();
  assert.deepEqual(on, ['a', 'b', 'd']);
});

test('servedBy reads the backend prefix and reports failed calls as none', () => {
  assert.equal(servedBy({ model_version: 'vendor-a:model-x:seed=1' }), 'vendor-a');
  assert.equal(servedBy({ model_version: null }), 'none');
});

function tinyRun() {
  const mk = (id, cache, cost, text, mv = 'vendor-a:m') => ({
    segment_id: 's1', tier: 'T2', requested_model: 'm-latest', cache_requested: cache, ok: true,
    verifier_passes: true, model_version: mv, usage: { inputTokens: 100, outputTokens: 10, estimatedCostUsd: cost }, rewritten_text: text, id,
  });
  const candidates = [mk('off', false, 0.0001, 'text-off'), mk('on', true, 0.0003, 'text-on')];
  const units = new Map([['u0', { uid: 'u0', segment_id: 's1', tier: 'T2', requested_model: 'm-latest', rewritten_text: 'text-off' }]]);
  const d = { faithfulness: 4, causal_preservation: 4, style_adherence: 4, fluency: 4, conciseness: 4 };
  const scores = [{ uid: 'u0', judge: 'j1', dims: d }, { uid: 'u0', judge: 'j2', dims: d }];
  return { candidates, units, scores };
}

test('cache-on and cache-off cells share one quality score; cost differs', () => {
  const a = analyze(tinyRun());
  const off = a.rows.find((r) => r.cache === 'cacheOFF');
  const on = a.rows.find((r) => r.cache === 'cacheON');
  assert.equal(off.q, on.q);
  assert.ok(on.cost > off.cost);
  assert.equal(on.pareto, false);
  assert.equal(off.pareto, true);
});

test('a judge whose name contains the serving backend is counted as judging itself', () => {
  const run = tinyRun();
  run.candidates[0].model_version = 'vendor-b:m';
  run.scores = run.scores.map((s) => ({ ...s, judge: s.judge === 'j1' ? 'vendor-b-judge' : 'other' }));
  const a = analyze(run);
  assert.equal(a.overlap.find((o) => o.judge === 'vendor-b-judge').selfJudged, 1);
  assert.equal(a.overlap.find((o) => o.judge === 'other').selfJudged, 0);
});

test('failed calls count against n but not against cost', () => {
  const run = tinyRun();
  run.candidates.push({ segment_id: 's9', tier: 'T2', requested_model: 'm-latest', cache_requested: false, ok: false, verifier_passes: null, model_version: null, usage: null, rewritten_text: null });
  const a = analyze(run);
  const off = a.rows.find((r) => r.cache === 'cacheOFF');
  assert.equal(off.n, 2);
  assert.equal(off.vpass, 0.5);
  assert.ok(Math.abs(off.cost - 0.0001) < 1e-12);
});

test('loadRun fails loudly when there are no score files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-'));
  fs.writeFileSync(path.join(dir, 'candidates.jsonl'), '');
  fs.writeFileSync(path.join(dir, 'judge-batches.json'), '{"batches":[]}');
  assert.throws(() => loadRun(dir), /no scores-\*\.jsonl/);
});

test('end to end on the synthetic fixture: report renders and the cheap cell is on the frontier', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synth-'));
  execFileSync('node', [path.join(root, 'scripts/make-synthetic-run.mjs'), dir], { stdio: 'pipe' });
  const a = analyze(loadRun(dir));
  const md = render(a);
  assert.match(md, /## Judge agreement/);
  assert.match(md, /Quality by serving backend/);
  for (const r of a.rows.filter((r) => r.cache === 'cacheON')) {
    const twin = a.rows.find((o) => o.tier === r.tier && o.model === r.model && o.cache === 'cacheOFF');
    assert.ok(r.cost > twin.cost, `${r.tier} ${r.model}: cache-on should cost more in the fixture`);
    assert.equal(r.q, twin.q);
  }
});
