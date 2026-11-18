import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeBatch, PRIMARY_JUDGE_PROMPT, ADVERSARIAL_FLAGGER_PROMPT } from '../src/rubric-judge-panel.mjs';

const units = [{ uid: 'a', tier: 'T2', edge_set: [], original_text: 'o', rewritten_text: 'r' }];
const good = { D1: 5, D2: 5, D3: 5, D4: 5, D5: 5 };

function stub({ scores = good, flagged = [] } = {}) {
  const calls = [];
  const fn = async (system) => {
    calls.push(system);
    if (system === PRIMARY_JUDGE_PROMPT) return { candidates: [{ uid: 'a', scores, reasoning: {} }] };
    if (system === ADVERSARIAL_FLAGGER_PROMPT) return { candidates: [{ uid: 'a', flagged_claims: flagged }] };
    throw new Error('unexpected prompt');
  };
  fn.calls = calls;
  return fn;
}

test('clean candidate passes and uses both prompts', async () => {
  const call = stub();
  const [row] = await judgeBatch(units, 'j', call);
  assert.equal(row.pass, true);
  assert.equal(row.overall, 5);
  assert.equal(call.calls.length, 2);
});

test('flagger finding caps D1 at 2 and turns a pass into a P0 fail', async () => {
  const [row] = await judgeBatch(units, 'j', stub({ flagged: ['an invented claim'] }));
  assert.equal(row.scores.D1, 2);
  assert.equal(row.pass, false);
  assert.equal(row.p0, true);
  assert.deepEqual(row.flagged_claims, ['an invented claim']);
});

test('an unusable primary response yields no rows instead of invented scores', async () => {
  const rows = await judgeBatch(units, 'j', async () => null);
  assert.deepEqual(rows, []);
});

test('a failed flagger call does not cap D1', async () => {
  const call = async (system) => (system === PRIMARY_JUDGE_PROMPT ? { candidates: [{ uid: 'a', scores: good }] } : null);
  const [row] = await judgeBatch(units, 'j', call);
  assert.equal(row.scores.D1, 5);
});
