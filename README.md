# llm-rewrite-cost-quality

A small harness for answering one question about an LLM rewrite pipeline: which model and cache setting gives the best quality per dollar, and can you trust the quality number?

You feed it three things: the candidates your pipeline generated (with token usage and cost per call), the units a judge panel scored, and the scores. It prints one report: judge agreement, a table of cost and quality per config cell, the Pareto-optimal cells, and a check on which backend actually served each call.

The last part exists because a pooled table hides it when a fallback path answers some calls from a different, pricier backend under the requested model's name. See the backend check under "How it works".

## Quick start

Needs Node 20 or newer. No dependencies.

```bash
npm run report        # writes a synthetic run to .tmp/ and prints the report
npm test              # 56 tests, no network
scripts/verify.sh     # gate: syntax, tests, fixture, report. Last line is the verdict
```

The synthetic run is made up. Its costs and scores are not measurements of anything.

## Using it on your own run

A run directory holds:

| file | one row per | fields used |
|---|---|---|
| `candidates.jsonl` | generated candidate | `segment_id`, `tier`, `requested_model`, `cache_requested`, `ok`, `verifier_passes`, `model_version`, `usage.{inputTokens,cachedTokens,outputTokens,estimatedCostUsd}`, `rewritten_text` |
| `judge-batches.json` | `{ "batches": [[unit, ...], ...] }` | unit: `uid`, `segment_id`, `tier`, `requested_model`, `rewritten_text` |
| `scores-*.jsonl` | (uid, judge) | `uid`, `judge`, `dims.{faithfulness,causal_preservation,style_adherence,fluency,conciseness}` |

```bash
node src/analyze.mjs path/to/run > report.md
```

`model_version` should start with the backend that served the call, followed by a colon (`vendor:model:...`). A failed call has none.

## How it works

- **Quality key.** A judged unit is keyed by `(segment, tier, requested model)`. The cache setting is not in the key, so cache-on and cache-off cells share one quality score. That is an assumption (a cache should not change the text), not a measurement. If your cache can change output, judge both.
- **Composite.** Five dimensions, weights 0.35 / 0.25 / 0.15 / 0.15 / 0.10 (faithfulness, causal preservation, style, fluency, conciseness), renormalized if a dimension is missing.
- **Agreement.** Pearson r and mean absolute difference between every pair of judges on the per-key composite.
- **Cost.** Mean `estimatedCostUsd` over calls that returned usage. Failed calls have no cost row, so they lower `n` and the verifier rate but not the $/call. Read the two together.
- **Pareto.** A cell is on the frontier if no other cell is at least as good on both axes and better on one.
- **Backend check.** Each judged unit is matched back to the candidate it came from by exact text, so the report can say which backend served it, split quality and cost by backend, and count units a judge scored when that judge's name contains the serving backend (a judge grading its own vendor's output).

`src/rubric-judge-panel.mjs` is a second, stricter scorer: five rubric dimensions with per-tier weights, a pass rule (overall >= 3.5 and every dimension >= 3), a hallucination flagger that caps faithfulness at 2, per-judge z-normalization, and a Cohen's kappa gate on pass/fail agreement. The model call is injected as a function, so it runs against any provider and the tests run with stubs.

`src/select-corpus.mjs` picks a seeded, reproducible sample of books, chapters and segments from a directory of JSON books, drops table-of-contents and title fragments, and prefers segments that carry causal edges.

## Limits

- It does not call any model. You bring the candidates and the scores.
- Judge scores are LLM scores. Agreement between judges is not agreement with a human reader. There is no human anchor in this repo.
- The pass/fail kappa gate and the z-normalization live in the rubric panel. `analyze.mjs` reports Pearson r, not kappa.
- Self-preference is only detected by name matching on the judge id and the backend prefix. If your ids don't line up, the overlap count will be zero for the wrong reason.
- Small cells give noisy Q. The report prints `judged n` next to every quality figure; read it.

## Tests

```bash
npm test
```

Covers the composite and Pareto math, judge agreement, the backend split, the self-judging count, the rubric scoring rules (weights, hard-fail, z-normalization, kappa), the judge flow with stub models, and seeded corpus selection.
