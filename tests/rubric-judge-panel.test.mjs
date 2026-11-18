// Unit tests for rubric-judge-panel.mjs
// Tests: weighted-overall, hard-fail logic, z-normalization, kappa gate
// No live LLM — all fixture scores.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  TIER_WEIGHTS,
  DIMS,
  weightedOverall,
  passFailRules,
  zNormalizeJudgeRows,
  cohensKappaGate,
  crossJudgeKappa,
} from '../src/rubric-judge-panel.mjs';

// ─────────────────────────── Helpers ─────────────────────────

function approx(a, b, tol = 1e-6) {
  return Math.abs(a - b) < tol;
}

// ─────────────────────────── 1. Tier weight structure ─────────

describe('TIER_WEIGHTS', () => {
  test('each tier weights sum to 1.0', () => {
    for (const [tier, W] of Object.entries(TIER_WEIGHTS)) {
      const sum = Object.values(W).reduce((a, b) => a + b, 0);
      assert.ok(
        approx(sum, 1.0, 1e-9),
        `${tier} weights sum to ${sum}, expected 1.0`,
      );
    }
  });

  test('T1 D1 and D2 both have weight 0.30', () => {
    assert.equal(TIER_WEIGHTS.T1.D1, 0.30);
    assert.equal(TIER_WEIGHTS.T1.D2, 0.30);
  });

  test('T2 D3 has highest weight (register is primary for T2)', () => {
    const T2 = TIER_WEIGHTS.T2;
    const maxW = Math.max(...Object.values(T2));
    assert.equal(T2.D3, maxW, 'D3 should have highest weight in T2');
  });

  test('revoice D3 has highest weight', () => {
    const R = TIER_WEIGHTS.revoice;
    const maxW = Math.max(...Object.values(R));
    assert.equal(R.D3, maxW, 'D3 should have highest weight in revoice');
  });
});

// ─────────────────────────── 2. weightedOverall ───────────────

describe('weightedOverall', () => {
  test('all-5 scores give overall = 5 for any tier', () => {
    const scores = { D1: 5, D2: 5, D3: 5, D4: 5, D5: 5 };
    for (const tier of ['T1', 'T2', 'T3', 'revoice']) {
      const overall = weightedOverall(scores, tier);
      assert.ok(approx(overall, 5.0), `${tier}: expected 5.0, got ${overall}`);
    }
  });

  test('all-1 scores give overall = 1 for any tier', () => {
    const scores = { D1: 1, D2: 1, D3: 1, D4: 1, D5: 1 };
    for (const tier of ['T1', 'T2', 'T3', 'revoice']) {
      const overall = weightedOverall(scores, tier);
      assert.ok(approx(overall, 1.0), `${tier}: expected 1.0, got ${overall}`);
    }
  });

  test('T1 D1=5 D2=5 D3=5 D4=5 D5=1 = 4.6', () => {
    // T1 weights: D1=0.30, D2=0.30, D3=0.10, D4=0.20, D5=0.10
    // = 0.30*5 + 0.30*5 + 0.10*5 + 0.20*5 + 0.10*1
    // = 1.5 + 1.5 + 0.5 + 1.0 + 0.1 = 4.6
    const scores = { D1: 5, D2: 5, D3: 5, D4: 5, D5: 1 };
    const overall = weightedOverall(scores, 'T1');
    assert.ok(approx(overall, 4.6), `expected 4.6, got ${overall}`);
  });

  test('T1 identity output (D1=5, D5=1, rest=3): overall matches formula', () => {
    // 0.30*5 + 0.30*3 + 0.10*3 + 0.20*3 + 0.10*1 = 1.5 + 0.9 + 0.3 + 0.6 + 0.1 = 3.4
    const scores = { D1: 5, D2: 3, D3: 3, D4: 3, D5: 1 };
    const overall = weightedOverall(scores, 'T1');
    assert.ok(approx(overall, 3.4), `expected 3.4, got ${overall}`);
  });

  test('unknown tier falls back to T1 weights', () => {
    const scores = { D1: 4, D2: 4, D3: 4, D4: 4, D5: 4 };
    const actual = weightedOverall(scores, 'UNKNOWN');
    const expected = weightedOverall(scores, 'T1');
    assert.ok(approx(actual, expected), `expected T1 fallback ${expected}, got ${actual}`);
  });

  test('missing dim is excluded from weighted average', () => {
    // D5 missing → weights re-normalised automatically (wSum = 0.90)
    const scores = { D1: 4, D2: 4, D3: 4, D4: 4 }; // no D5
    const overall = weightedOverall(scores, 'T1');
    // sum = 0.30*4 + 0.30*4 + 0.10*4 + 0.20*4 = 3.6 / 0.90 = 4.0
    assert.ok(approx(overall, 4.0), `expected 4.0, got ${overall}`);
  });
});

// ─────────────────────────── 3. passFailRules ────────────────

describe('passFailRules', () => {
  test('all dims >= 3 and overall >= 3.5 → pass', () => {
    const scores = { D1: 4, D2: 4, D3: 4, D4: 4, D5: 4 };
    const overall = weightedOverall(scores, 'T1');
    const { pass, hard_fail_dimension, p0 } = passFailRules(scores, overall);
    assert.equal(pass, true);
    assert.equal(hard_fail_dimension, null);
    assert.equal(p0, false);
  });

  test('D3=2 → hard fail even if overall >= 3.5', () => {
    // High D1/D2 can push overall above 3.5 but D3=2 fails
    const scores = { D1: 5, D2: 5, D3: 2, D4: 5, D5: 5 };
    const overall = weightedOverall(scores, 'T1');
    // = 0.30*5 + 0.30*5 + 0.10*2 + 0.20*5 + 0.10*5 = 1.5+1.5+0.2+1.0+0.5 = 4.7
    assert.ok(overall > 3.5, `overall ${overall} should be > 3.5`);
    const { pass, hard_fail_dimension, p0 } = passFailRules(scores, overall);
    assert.equal(pass, false, 'D3=2 should hard-fail');
    assert.equal(hard_fail_dimension, 'D3');
    assert.equal(p0, false, 'D3 <3 is not a P0 (only D1/D2 are P0)');
  });

  test('D1=2 → P0 hard fail', () => {
    const scores = { D1: 2, D2: 4, D3: 4, D4: 4, D5: 4 };
    const overall = weightedOverall(scores, 'T1');
    const { pass, hard_fail_dimension, p0 } = passFailRules(scores, overall);
    assert.equal(pass, false);
    assert.equal(hard_fail_dimension, 'D1');
    assert.equal(p0, true, 'D1 < 3 must be P0');
  });

  test('D2=1 → P0 hard fail', () => {
    const scores = { D1: 4, D2: 1, D3: 4, D4: 4, D5: 4 };
    const overall = weightedOverall(scores, 'T1');
    const { pass, hard_fail_dimension, p0 } = passFailRules(scores, overall);
    assert.equal(pass, false);
    assert.equal(hard_fail_dimension, 'D2');
    assert.equal(p0, true, 'D2 < 3 must be P0');
  });

  test('overall = 3.4 with all dims >= 3 → fail (below 3.5 threshold)', () => {
    // T1 identity output: D1=5 D2=3 D3=3 D4=3 D5=1 → overall=3.4, but D5=1 < 3 → hard fail
    const scores = { D1: 5, D2: 3, D3: 3, D4: 3, D5: 1 };
    const overall = weightedOverall(scores, 'T1');
    const { pass } = passFailRules(scores, overall);
    assert.equal(pass, false, 'D5=1 is a hard fail');
  });

  test('borderline pass: overall=3.5 exactly and all dims=3 or above', () => {
    // Need scores where weighted overall is exactly 3.5 and all dims >= 3
    // T1: 0.30*a + 0.30*b + 0.10*c + 0.20*d + 0.10*e = 3.5, all >= 3
    // Try all-3 except D1=5: 0.30*5+0.30*3+0.10*3+0.20*3+0.10*3 = 1.5+0.9+0.3+0.6+0.3 = 3.6 > 3.5
    // all-3: 3.0 overall → fail
    // Try D1=4,D2=4,rest=3: 0.30*4+0.30*4+0.10*3+0.20*3+0.10*3 = 1.2+1.2+0.3+0.6+0.3 = 3.6
    // Try D1=3,D2=4,D3=3,D4=4,D5=3: 0.30*3+0.30*4+0.10*3+0.20*4+0.10*3 = 0.9+1.2+0.3+0.8+0.3 = 3.5
    const scores = { D1: 3, D2: 4, D3: 3, D4: 4, D5: 3 };
    const overall = weightedOverall(scores, 'T1');
    assert.ok(approx(overall, 3.5), `expected 3.5, got ${overall}`);
    const { pass } = passFailRules(scores, overall);
    assert.equal(pass, true, 'overall=3.5 exactly with all dims>=3 should pass');
  });

  test('D1 and D2 both < 3 → P0, hard_fail_dimension = D1 (first)', () => {
    const scores = { D1: 2, D2: 2, D3: 4, D4: 4, D5: 4 };
    const overall = weightedOverall(scores, 'T1');
    const { pass, hard_fail_dimension, p0 } = passFailRules(scores, overall);
    assert.equal(pass, false);
    assert.equal(hard_fail_dimension, 'D1');
    assert.equal(p0, true);
  });
});

// ─────────────────────────── 4. zNormalizeJudgeRows ──────────

describe('zNormalizeJudgeRows', () => {
  test('empty input returns empty array', () => {
    assert.deepEqual(zNormalizeJudgeRows([]), []);
  });

  test('null/undefined input returns as-is', () => {
    assert.equal(zNormalizeJudgeRows(null), null);
    assert.equal(zNormalizeJudgeRows(undefined), undefined);
  });

  test('z-normalized values have mean ≈ 0 across rows', () => {
    const rows = [
      { uid: 'u0', dims: { D1: 3, D2: 3, D3: 3, D4: 3, D5: 3 } },
      { uid: 'u1', dims: { D1: 4, D2: 4, D3: 4, D4: 4, D5: 4 } },
      { uid: 'u2', dims: { D1: 5, D2: 5, D3: 5, D4: 5, D5: 5 } },
      { uid: 'u3', dims: { D1: 2, D2: 2, D3: 2, D4: 2, D5: 2 } },
    ];
    const norm = zNormalizeJudgeRows(rows);
    for (const d of DIMS) {
      const vals = norm.map((r) => r.dims[d]);
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      assert.ok(approx(mean, 0, 1e-9), `${d} mean after z-norm = ${mean}, expected ≈ 0`);
    }
  });

  test('z-normalized values have std ≈ 1 across rows', () => {
    const rows = [
      { uid: 'u0', dims: { D1: 1, D2: 2, D3: 3, D4: 4, D5: 5 } },
      { uid: 'u1', dims: { D1: 3, D2: 3, D3: 3, D4: 3, D5: 3 } },
      { uid: 'u2', dims: { D1: 5, D2: 4, D3: 3, D4: 2, D5: 1 } },
      { uid: 'u3', dims: { D1: 2, D2: 2, D3: 2, D4: 5, D5: 4 } },
    ];
    const norm = zNormalizeJudgeRows(rows);
    for (const d of DIMS) {
      const vals = norm.map((r) => r.dims[d]);
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const std = Math.sqrt(vals.reduce((a, v) => a + (v - mean) ** 2, 0) / vals.length);
      assert.ok(approx(std, 1.0, 1e-9), `${d} std after z-norm = ${std}, expected ≈ 1`);
    }
  });

  test('constant dim (all same score) is left unchanged', () => {
    const rows = [
      { uid: 'u0', dims: { D1: 4, D2: 4, D3: 4, D4: 4, D5: 4 } },
      { uid: 'u1', dims: { D1: 4, D2: 4, D3: 4, D4: 4, D5: 4 } },
    ];
    const norm = zNormalizeJudgeRows(rows);
    // std=0 → left unchanged (no divide-by-zero)
    for (const r of norm) {
      for (const d of DIMS) {
        assert.ok(typeof r.dims[d] === 'number', `${d} should still be a number`);
        assert.ok(isFinite(r.dims[d]), `${d} should not be NaN/Infinity`);
      }
    }
  });

  test('sets _znorm flag on output rows', () => {
    const rows = [
      { uid: 'u0', dims: { D1: 3, D2: 4, D3: 3, D4: 4, D5: 3 } },
      { uid: 'u1', dims: { D1: 4, D2: 3, D3: 4, D4: 3, D5: 4 } },
    ];
    const norm = zNormalizeJudgeRows(rows);
    for (const r of norm) {
      assert.equal(r._znorm, true);
    }
  });

  test('removes leniency bias: all scores +0.15 offset normalizes to same shape', () => {
    // Judge A gives [3.15, 4.15, 5.0] while judge B gives [3.0, 4.0, 4.85]
    // After z-norm both should have identical relative positions
    const rowsA = [
      { uid: 'u0', dims: { D1: 3.15, D2: 3.15, D3: 3.15, D4: 3.15, D5: 3.15 } },
      { uid: 'u1', dims: { D1: 4.15, D2: 4.15, D3: 4.15, D4: 4.15, D5: 4.15 } },
      { uid: 'u2', dims: { D1: 5.00, D2: 5.00, D3: 5.00, D4: 5.00, D5: 5.00 } },
    ];
    const rowsB = [
      { uid: 'u0', dims: { D1: 3.00, D2: 3.00, D3: 3.00, D4: 3.00, D5: 3.00 } },
      { uid: 'u1', dims: { D1: 4.00, D2: 4.00, D3: 4.00, D4: 4.00, D5: 4.00 } },
      { uid: 'u2', dims: { D1: 4.85, D2: 4.85, D3: 4.85, D4: 4.85, D5: 4.85 } },
    ];
    const normA = zNormalizeJudgeRows(rowsA);
    const normB = zNormalizeJudgeRows(rowsB);

    // After z-norm, u0 D1 for both judges should be approximately equal
    for (const d of DIMS) {
      for (let i = 0; i < 3; i++) {
        assert.ok(
          approx(normA[i].dims[d], normB[i].dims[d], 0.01),
          `z-norm failed to align judges at u${i} ${d}: A=${normA[i].dims[d]}, B=${normB[i].dims[d]}`,
        );
      }
    }
  });
});

// ─────────────────────────── 5. cohensKappaGate ──────────────

describe('cohensKappaGate', () => {
  test('perfect agreement → kappa = 1', () => {
    const judgeA = Array.from({ length: 20 }, (_, i) => ({ uid: `u${i}`, overall: i < 10 ? 4.0 : 2.0 }));
    const judgeB = Array.from({ length: 20 }, (_, i) => ({ uid: `u${i}`, overall: i < 10 ? 4.0 : 2.0 }));
    const { kappa, flagged } = cohensKappaGate(judgeA, judgeB, 20);
    assert.ok(approx(kappa, 1.0), `expected kappa=1, got ${kappa}`);
    assert.equal(flagged, false);
  });

  test('complete disagreement → kappa ≈ -1', () => {
    // 10 pass / 10 fail, but perfectly reversed
    const judgeA = [
      ...Array.from({ length: 10 }, (_, i) => ({ uid: `u${i}`, overall: 4.0 })),   // pass
      ...Array.from({ length: 10 }, (_, i) => ({ uid: `u${10 + i}`, overall: 2.0 })), // fail
    ];
    const judgeB = [
      ...Array.from({ length: 10 }, (_, i) => ({ uid: `u${i}`, overall: 2.0 })),   // fail
      ...Array.from({ length: 10 }, (_, i) => ({ uid: `u${10 + i}`, overall: 4.0 })), // pass
    ];
    const { kappa } = cohensKappaGate(judgeA, judgeB, 20);
    assert.ok(kappa < 0, `expected negative kappa, got ${kappa}`);
  });

  test('kappa < 0.6 → flagged=true', () => {
    // Approximately 60% agreement on 20 candidates with uniform distribution
    // Make: 8 agree-pass, 4 agree-fail, 4 A-pass/B-fail, 4 A-fail/B-pass
    const judgeA = [
      ...Array.from({ length: 12 }, (_, i) => ({ uid: `u${i}`, overall: 4.0 })),
      ...Array.from({ length: 8 }, (_, i) => ({ uid: `u${12 + i}`, overall: 2.0 })),
    ];
    const judgeB = [
      ...Array.from({ length: 8 }, (_, i) => ({ uid: `u${i}`, overall: 4.0 })),  // agree-pass
      ...Array.from({ length: 4 }, (_, i) => ({ uid: `u${8 + i}`, overall: 2.0 })), // A-pass B-fail
      ...Array.from({ length: 4 }, (_, i) => ({ uid: `u${12 + i}`, overall: 4.0 })), // A-fail B-pass
      ...Array.from({ length: 4 }, (_, i) => ({ uid: `u${16 + i}`, overall: 2.0 })), // agree-fail
    ];
    const { kappa, flagged } = cohensKappaGate(judgeA, judgeB, 20);
    // po = (8+4)/20 = 0.6; pA1 = 12/20=0.6, pB1 = 12/20=0.6; pe=0.6*0.6+0.4*0.4=0.52
    // kappa = (0.6-0.52)/(1-0.52) = 0.08/0.48 ≈ 0.167
    assert.ok(kappa < 0.6, `expected kappa < 0.6, got ${kappa}`);
    assert.equal(flagged, true);
  });

  test('kappa >= 0.6 → flagged=false', () => {
    // 18 agree, 2 disagree → high agreement
    const judgeA = [
      ...Array.from({ length: 10 }, (_, i) => ({ uid: `u${i}`, overall: 4.0 })),
      ...Array.from({ length: 10 }, (_, i) => ({ uid: `u${10 + i}`, overall: 2.0 })),
    ];
    const judgeB = [
      ...Array.from({ length: 9 }, (_, i) => ({ uid: `u${i}`, overall: 4.0 })),   // agree 9
      { uid: 'u9', overall: 2.0 },                                                  // disagree
      ...Array.from({ length: 9 }, (_, i) => ({ uid: `u${10 + i}`, overall: 2.0 })), // agree 9
      { uid: 'u19', overall: 4.0 },                                                 // disagree
    ];
    const { kappa, flagged } = cohensKappaGate(judgeA, judgeB, 20);
    // po=18/20=0.9; pA1=10/20=0.5, pB1=10/20=0.5; pe=0.5*0.5+0.5*0.5=0.5
    // kappa = (0.9-0.5)/(1-0.5) = 0.8
    assert.ok(approx(kappa, 0.8, 1e-9), `expected kappa≈0.8, got ${kappa}`);
    assert.equal(flagged, false);
  });

  test('fewer than 2 shared UIDs → returns kappa=null, not flagged', () => {
    const judgeA = [{ uid: 'u0', overall: 4.0 }];
    const judgeB = [{ uid: 'u1', overall: 2.0 }]; // no shared uid
    const { kappa, flagged, n } = cohensKappaGate(judgeA, judgeB, 20);
    assert.equal(kappa, null);
    assert.equal(flagged, false);
    assert.equal(n, 0);
  });

  test('only sliceSize candidates are used even if more are available', () => {
    // 30 candidates but sliceSize=20 → only first 20 shared UIDs evaluated
    const judgeA = Array.from({ length: 30 }, (_, i) => ({ uid: `u${i}`, overall: 4.0 }));
    const judgeB = Array.from({ length: 30 }, (_, i) => ({ uid: `u${i}`, overall: 4.0 }));
    const { n } = cohensKappaGate(judgeA, judgeB, 20);
    assert.equal(n, 20);
  });
});

// ─────────────────────────── 6. crossJudgeKappa ──────────────

describe('crossJudgeKappa', () => {
  test('wrapper produces same result as direct cohensKappaGate call', () => {
    const rowsA = Array.from({ length: 20 }, (_, i) => ({
      uid: `u${i}`, overall: i % 3 === 0 ? 2.5 : 4.2, pass: i % 3 !== 0,
    }));
    const rowsB = Array.from({ length: 20 }, (_, i) => ({
      uid: `u${i}`, overall: i % 4 === 0 ? 2.5 : 4.0, pass: i % 4 !== 0,
    }));

    const direct = cohensKappaGate(
      rowsA.map((r) => ({ uid: r.uid, overall: r.overall })),
      rowsB.map((r) => ({ uid: r.uid, overall: r.overall })),
      20,
    );
    const via = crossJudgeKappa(rowsA, rowsB, 20);

    assert.ok(approx(direct.kappa, via.kappa, 1e-12), `kappa mismatch: direct=${direct.kappa}, via=${via.kappa}`);
    assert.equal(direct.flagged, via.flagged);
  });
});
