import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectCorpus } from '../src/select-corpus.mjs';

function book(title, nChapters = 6) {
  const segments = [];
  for (let c = 0; c < nChapters; c++) {
    for (let i = 0; i < 6; i++) {
      segments.push({
        id: `${title}-c${c}-${i}`, parent_chapter: `c${c}`,
        text: `In chapter ${c} of ${title}, the keeper walked the cliff path at dusk, counted the boats coming in, and wrote each one into the log by lamplight. Segment ${i} ended when the wind turned and the tide began to run against the harbour wall.`,
      });
    }
  }
  return { metadata: { title, book_id: title }, segments, causal_edges: [] };
}

const books = ['A', 'B', 'C', 'D'].map((t) => book(`Book ${t}`));

test('same seed gives the same selection; another seed gives another', () => {
  const opts = { seed: 42, nBooks: 3, nChapters: 2, nSegs: 2 };
  const a = JSON.stringify(selectCorpus(books, opts));
  assert.equal(a, JSON.stringify(selectCorpus(books, opts)));
  const other = JSON.stringify(selectCorpus(books, { ...opts, seed: 43 }));
  assert.notEqual(a, other);
});

test('books are de-duplicated by title and tiny books are skipped', () => {
  const dup = [...books, book('Book A'), book('Tiny', 1)];
  const s = selectCorpus(dup, { seed: 1, nBooks: 10, nChapters: 2, nSegs: 2 });
  assert.equal(s.n_books, 4);
  assert.equal(new Set(s.books.map((b) => b.title)).size, 4);
});

test('each book yields nChapters x nSegs units', () => {
  const s = selectCorpus(books, { seed: 5, nBooks: 2, nChapters: 3, nSegs: 2 });
  for (const b of s.books) assert.equal(b.units.length, 6);
});
