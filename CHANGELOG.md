# Changelog

## 0.1.0 - 2026-11-18

- Harness that reads candidates, judged units and scores for an LLM rewrite pipeline and prints one report.
- Report: judge agreement, cost and quality per config cell, the Pareto-optimal cells, and a check on which backend served each call.
- `npm run report` writes and reports a synthetic run, whose numbers are not measurements; `npm test` runs 56 tests with no network.
- No dependencies; Node 20 or newer.
