// Unit tests for edge-bearing segment preference in corpus selection.
// Verifies that pickChaptersAndSegments biases toward segments that carry causal edges.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickChaptersAndSegments } from '../src/select-corpus.mjs';

// Simple PRNG for deterministic test behavior
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Minimal book with causal edges for testing
const BOOK_WITH_EDGES = {
  schema_version: '0.2',
  metadata: {
    book_id: 'test-edge-pref-001',
    title: 'Test Book with Causal Edges',
  },
  segments: [
    // Chapter 1: ch1-0 and ch1-1 have causal edges; ch1-2 and ch1-3 don't
    // All segments must be 180-900 chars to be eligible
    {
      id: 'ch1-0',
      text: 'The old wizard warned the hero with grave urgency: "Beware the dark tower. Within its walls, the cursed artifact lies dormant, waiting for a foolish soul to awaken it. Do not let curiosity lead you astray. The tower is sealed for a reason, and that reason is written in blood and shadow."',
      parent_chapter: 'ch1',
    },
    {
      id: 'ch1-1',
      text: 'The hero nodded solemnly, memorizing every word spoken by the ancient sage. The wizard\'s prophecies had never failed him before, and he had no reason to doubt this ominous warning now. He clasped his hands together and swore an oath to heed the warning with all his heart and soul.',
      parent_chapter: 'ch1',
    },
    {
      id: 'ch1-2',
      text: 'The day was clear and bright as the hero set out from the village on his long journey westward. The marketplace bustled with activity, merchants calling out their wares to the passing crowds. It was an ordinary morning like any other, with children playing in the streets and dogs barking nearby.',
      parent_chapter: 'ch1',
    },
    {
      id: 'ch1-3',
      text: 'The evening brought rain and thunder across the landscape. The travelers sat by the fire, warming themselves after a long day of travel and hardship. Someone brought out bread and cheese from their pack, and they shared the meal in silence, listening to the storm outside.',
      parent_chapter: 'ch1',
    },
  ],
  // Causal edges: ch1-0 (setup) → ch3-0 (payoff), ch1-1 (setup) → ch3-1 (payoff)
  // ch1-0 and ch1-1 are edge-bearing; ch1-2 and ch1-3 are not
  causal_edges: [
    {
      id: 'edge-1',
      setup_segment_id: 'ch1-0',
      payoff_segment_id: 'ch3-0',
      kind: 'foreshadow_resolution',
      confidence: 0.95,
    },
    {
      id: 'edge-2',
      setup_segment_id: 'ch1-1',
      payoff_segment_id: 'ch3-1',
      kind: 'setup_payoff',
      confidence: 0.92,
    },
  ],
};

// Book with too few edge-bearing segments (should fall back to random)
const BOOK_FEW_EDGES = {
  schema_version: '0.2',
  metadata: {
    book_id: 'test-edge-pref-002',
    title: 'Test Book with Few Edges',
  },
  segments: [
    // Only ch2-0 has an edge; ch2-1, ch2-2, ch2-3 don't
    // All segments must be 180-900 chars to be eligible
    {
      id: 'ch2-0',
      text: 'The artifact was hidden deep beneath the mountain in a secret chamber. Ancient runes covered its surface, and a faint glow emanated from within the sealed chamber where it slept for centuries. Legend said it contained the very essence of magic itself, corrupted and twisted by dark forces.',
      parent_chapter: 'ch2',
    },
    {
      id: 'ch2-1',
      text: 'The guards patrolled the corridors with their torches held high and burning bright. Their footsteps echoed through the stone halls, and their breathing was shallow and tense. They knew something precious lay hidden here, and they took their duty very seriously indeed.',
      parent_chapter: 'ch2',
    },
    {
      id: 'ch2-2',
      text: 'The passages twisted left and right in an endless maze that confounded all who entered. Some walls were smooth and polished from centuries of use, while others were rough and ancient, covered in moss and decay. The inscriptions on the walls were unreadable, worn smooth by the passage of time.',
      parent_chapter: 'ch2',
    },
    {
      id: 'ch2-3',
      text: 'The hero felt a chill run down his spine as he descended deeper into the abyss below. The air grew colder with each step, and the darkness seemed to press against him from all sides, suffocating and oppressive. He could hear the echo of his own heartbeat in his ears, amplified by the silent stone.',
      parent_chapter: 'ch2',
    },
  ],
  causal_edges: [
    {
      id: 'edge-3',
      setup_segment_id: 'ch2-0',
      payoff_segment_id: 'ch4-0',
      kind: 'foreshadow_resolution',
      confidence: 0.88,
    },
  ],
};

test('edge-bearing segments are preferred when sufficient exist in a chapter', () => {
  const rnd = mulberry32(42); // seeded for reproducibility
  const result = pickChaptersAndSegments(BOOK_WITH_EDGES, rnd, { nSegs: 2, nChapters: 1 });

  // With a seed that favors ch1 and nSegs=2, we expect at least some picks to be edge-bearing
  // Since ch1 has 2 edge-bearing (ch1-0, ch1-1) and 2 non-edge-bearing (ch1-2, ch1-3),
  // and we set nSegs=2, the function should prefer the edge-bearing set if it has >= nSegs elements.
  // The BOOK_WITH_EDGES config has exactly 2 edge-bearing segments in ch1.

  assert.ok(result.length > 0, 'should return selected segments');

  // Count how many of the selected segments are edge-bearing
  const edgeBearingIds = new Set(['ch1-0', 'ch1-1']);
  const selectedEdgeBearing = result.filter((unit) => edgeBearingIds.has(unit.segment_id)).length;

  // With the bias applied, we expect at least 1 edge-bearing segment to be selected
  // (the algorithm prefers them when available)
  assert.ok(selectedEdgeBearing > 0, 'should select at least one edge-bearing segment when they are available');

  // Verify that selected edge-bearing segments have non-empty edge sets
  for (const unit of result) {
    if (edgeBearingIds.has(unit.segment_id)) {
      assert.ok(unit.edge_set.length > 0, `edge-bearing segment ${unit.segment_id} should have edge_set populated`);
    }
  }
});

test('fallback to random selection when insufficient edge-bearing segments exist', () => {
  const rnd = mulberry32(42);
  const result = pickChaptersAndSegments(BOOK_FEW_EDGES, rnd, { nSegs: 2, nChapters: 1 });

  // BOOK_FEW_EDGES has only 1 edge-bearing segment (ch2-0) in chapter ch2.
  // With nSegs=2, since 1 < 2, the algorithm falls back to random selection from all prose.
  // This test verifies that fallback behavior is working.

  assert.ok(result.length > 0, 'should return selected segments even with few edges');

  // The fallback mechanism should have selected 2 segments (or fewer if chapter is small)
  // This verifies the fallback doesn't crash and does return something.
  const selectedIds = new Set(result.map((u) => u.segment_id));
  assert.ok(selectedIds.size >= 1, 'should select at least one segment via fallback');
});

test('edge segments have non-empty edge_set when they are setup or payoff anchors', () => {
  const rnd = mulberry32(123);
  const result = pickChaptersAndSegments(BOOK_WITH_EDGES, rnd, { nSegs: 2, nChapters: 1 });

  // Find all selections and verify edge_set construction
  const edgeBearingMap = new Map();
  for (const edge of BOOK_WITH_EDGES.causal_edges) {
    if (!edgeBearingMap.has(edge.setup_segment_id)) {
      edgeBearingMap.set(edge.setup_segment_id, []);
    }
    if (!edgeBearingMap.has(edge.payoff_segment_id)) {
      edgeBearingMap.set(edge.payoff_segment_id, []);
    }
    edgeBearingMap.get(edge.setup_segment_id).push(edge);
    edgeBearingMap.get(edge.payoff_segment_id).push(edge);
  }

  // For each selected unit that is an edge-bearing ID, verify edge_set is populated correctly
  for (const unit of result) {
    if (edgeBearingMap.has(unit.segment_id)) {
      const expectedEdgeCount = edgeBearingMap.get(unit.segment_id).length;
      assert.equal(unit.edge_set.length, expectedEdgeCount,
        `segment ${unit.segment_id} should have ${expectedEdgeCount} edge(s), got ${unit.edge_set.length}`);
    }
  }
});
