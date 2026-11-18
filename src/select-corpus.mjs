// Seeded corpus selection for the cost-vs-quality eval.
//   node src/select-corpus.mjs <booksDir> <seed> <nBooks> <nChapters> <nSegsPerChapter> [out.json]
// booksDir holds one JSON file per book: { metadata: { title }, segments: [{ id, text, parent_chapter }],
// causal_edges: [{ setup_segment_id, payoff_segment_id, ... }] }. Books are de-duplicated by title,
// N are picked with a seeded PRNG, then N chapters per book and M segments per chapter.
// Selection is reproducible for a given seed and input.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const N_SEGS = 2;
const N_CHAPTERS = 3;

// Reject degenerate / non-narrative segments (TOC, front-matter, title-fragment
// blocks). These are not rewritable prose and pollute rewrite evals (a TOC block
// like ch2-872 even drove a live 500 in the rewrite-engine). PURE + exported so
// it is unit-testable without any I/O. Heuristic: combine >=2 independent signals
// so a single chapter-mention inside real prose is NOT flagged.
//   S1 — chapter/roman/numeral token density: many "Chapter"/roman-numeral/leading
//        numeral tokens relative to word count (TOC enumeration).
//   S2 — sentence-punctuation scarcity: (near-)absence of sentence-ending
//        punctuation (.?!) relative to length.
//   S3 — very low average words-per-sentence (enumerated fragments, not prose).
//   S4 — mostly Title-Case fragment lines (headings / titles, no lowercase flow).
export function isNonProse(text) {
  if (!text || typeof text !== 'string') return true;
  const t = text.trim();
  if (t.length < 12) return true; // too short to be a rewrite unit

  const words = t.split(/\s+/).filter(Boolean);
  const nWords = words.length;
  if (nWords < 4) return true;

  // sentence-ending punctuation count
  const sentenceEnders = (t.match(/[.?!]/g) || []).length;
  const sentences = Math.max(sentenceEnders, 1);
  const avgWordsPerSentence = nWords / sentences;

  // S1 — chapter / roman-numeral / leading-numeral token density
  const chapterTokens = (t.match(/\bchapter\b/gi) || []).length;
  // standalone roman numerals (I, II, III, IV, ... ) as whole tokens
  const romanTokens = (t.match(/\b(?=[MDCLXVI]+\b)M{0,4}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})\b/g) || [])
    .filter((m) => m.length > 0).length;
  const numeralTokens = (t.match(/\b\d{1,3}[.)]?\b/g) || []).length;
  const enumDensity = (chapterTokens + romanTokens + numeralTokens) / nWords;
  const S1 = chapterTokens >= 2 && enumDensity >= 0.1;

  // S2 — sentence-punctuation scarcity. Either a long block with no sentence
  // breaks, or any block with zero sentence-enders at all (title/heading fragment).
  const S2 = (sentenceEnders <= 1 && t.length >= 120) || sentenceEnders === 0;

  // S3 — very low average words-per-sentence (enumerated fragments)
  const S3 = sentenceEnders >= 2 && avgWordsPerSentence <= 4;

  // S4 — mostly Title-Case fragment lines (headings, no prose flow)
  const titleCaseWords = words.filter((w) => /^[A-Z][a-z'’-]+$/.test(w)).length;
  const lowercaseWords = words.filter((w) => /^[a-z]/.test(w)).length;
  const S4 = nWords >= 6 && titleCaseWords / nWords >= 0.55 && lowercaseWords / nWords <= 0.25;

  // combine: flag only when >= 2 independent signals fire
  const signals = [S1, S2, S3, S4].filter(Boolean).length;
  return signals >= 2;
}

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function shuffle(arr, rnd) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

export function pickChaptersAndSegments(rp, rnd, opts = {}) {
  // Allow test-time parameter override
  const nSegs = opts.nSegs ?? N_SEGS;
  const nChapters = opts.nChapters ?? N_CHAPTERS;
  const segs = rp.segments || [];
  // Identify edge-bearing segment IDs from the causal map (setup or payoff anchors)
  const edgeBearingSegmentIds = new Set();
  const causalEdges = rp.causal_edges || [];
  for (const e of causalEdges) {
    if (e.setup_segment_id) edgeBearingSegmentIds.add(e.setup_segment_id);
    if (e.payoff_segment_id) edgeBearingSegmentIds.add(e.payoff_segment_id);
  }

  // group by chapter id (parent_chapter preferred, else chapter)
  const byChap = new Map();
  for (const s of segs) {
    const c = s.parent_chapter ?? s.chapter ?? 'c?';
    if (!byChap.has(c)) byChap.set(c, []);
    byChap.get(c).push(s);
  }
  // eligible chapters: >= nSegs mid-length narrative segments (180-900 chars)
  const eligible = [...byChap.entries()]
    .map(([c, ss]) => [c, ss.filter((s) => s.text && s.text.length >= 180 && s.text.length <= 900)])
    .filter(([, ss]) => ss.length >= nSegs);
  const chosenChaps = shuffle(eligible, rnd).slice(0, nChapters);
  const out = [];
  let dropped = 0;
  for (const [chap, ss] of chosenChaps) {
    // exclude degenerate / non-narrative segments (TOC, front-matter) BEFORE picking
    const prose = ss.filter((s) => {
      if (isNonProse(s.text)) { dropped++; return false; }
      return true;
    });
    // Bias toward segments that carry causal edges (setup/payoff anchors).
    // If a chapter has enough edge-bearing segments, prefer them; otherwise fall back to random.
    const edgeBearing = prose.filter((s) => edgeBearingSegmentIds.has(s.id));
    const picks = edgeBearing.length >= nSegs ? shuffle(edgeBearing, rnd).slice(0, nSegs) : shuffle(prose, rnd).slice(0, nSegs);
    for (const s of picks) {
      // edges anchored on this segment from the book's causal map
      const edges = (rp.causal_edges || [])
        .filter((e) => e.setup_segment_id === s.id || e.payoff_segment_id === s.id)
        .map((e) => ({
          setup_segment_id: e.setup_segment_id, payoff_segment_id: e.payoff_segment_id,
          kind: e.kind ?? 'setup_payoff', confidence: e.confidence ?? 0.5,
          verbatim_anchor: {
            setup_quote: e.verbatim_anchor?.setup_quote ?? e.setup_quote ?? '',
            payoff_quote: e.verbatim_anchor?.payoff_quote ?? e.payoff_quote ?? '',
          },
        }));
      out.push({ chapter: String(chap), segment_id: s.id, text: s.text, char_len: s.text.length, edge_set: edges });
    }
  }
  if (dropped > 0) console.log(`  [filter] dropped ${dropped} non-prose segment(s) (TOC/front-matter)`);
  return out;
}


export function selectCorpus(books, { seed, nBooks, nChapters, nSegs }) {
  const rnd = mulberry32(seed);
  const seen = new Map();
  for (const rp of books) {
    const title = rp.metadata?.title ?? rp.id;
    if ((rp.segments || []).length < 30) continue; // too small to sample chapters from
    if (!seen.has(title)) seen.set(title, rp);
  }
  const picked = shuffle([...seen.values()], rnd).slice(0, nBooks);
  return {
    seed, n_books: picked.length, n_chapters: nChapters, n_segs_per_chapter: nSegs,
    books: picked.map((rp) => ({
      book_id: rp.metadata?.book_id ?? rp.id,
      title: rp.metadata?.title ?? rp.id,
      total_segments: (rp.segments || []).length,
      total_edges: (rp.causal_edges || []).length,
      units: pickChaptersAndSegments(rp, rnd, { nChapters, nSegs }),
    })),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [dir, seed = '42', nBooks = '15', nChapters = String(N_CHAPTERS), nSegs = String(N_SEGS), out = 'corpus-sample.json'] = process.argv.slice(2);
  if (!dir) {
    console.error('usage: node src/select-corpus.mjs <booksDir> [seed] [nBooks] [nChapters] [nSegs] [out.json]');
    process.exit(2);
  }
  const books = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  const sample = selectCorpus(books, { seed: Number(seed), nBooks: Number(nBooks), nChapters: Number(nChapters), nSegs: Number(nSegs) });
  fs.writeFileSync(out, JSON.stringify(sample, null, 2));
  console.log(`selected ${sample.n_books} books, ${sample.books.reduce((a, b) => a + b.units.length, 0)} segments -> ${out}`);
}
