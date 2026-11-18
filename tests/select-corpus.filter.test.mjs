// Unit tests for the pure non-prose corpus filter. Run: node --test "tests/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNonProse } from '../src/select-corpus.mjs';

// A table-of-contents block: chapter enumeration, no sentences.
const TOC = 'Chapter I. The Harbour Chapter II. The Salt Road ' +
  'Chapter III. The Lamp Keeper Chapter IV. Who Kept the Light ' +
  'Chapter V. The Toil of Net and Line Chapter VI. For the Love of a Boat ' +
  'Chapter VII. The Sounding of the Bell';

const PROSE_A = 'I am sorry, exceedingly sorry, said the keeper, in a tone of surprise ' +
  'and sudden feeling, that you were ever told of what may, in a poor light, ' +
  'have given you some uneasiness.';
const PROSE_B = 'The lamp-keeper (for so it will be convenient to speak of him) ' +
  'was mending a net for us. His pale grey eyes shone and twinkled, ' +
  'and his weathered face was flushed and animated.';

const TITLE_FRAG = 'The Lantern at Low Tide By Anna Marsh';

test('table-of-contents block is flagged as non-prose', () => {
  assert.equal(isNonProse(TOC), true);
});

test('dialogue paragraph is genuine prose', () => {
  assert.equal(isNonProse(PROSE_A), false);
});

test('narrative sentence is genuine prose', () => {
  assert.equal(isNonProse(PROSE_B), false);
});

test('short title front-matter fragment is flagged as non-prose', () => {
  assert.equal(isNonProse(TITLE_FRAG), true);
});

test('empty / nullish input is non-prose', () => {
  assert.equal(isNonProse(''), true);
  assert.equal(isNonProse(null), true);
  assert.equal(isNonProse(undefined), true);
});
