# P6-19 — performance regression reporting

Date: 2026-08-10

Workflow: `.github/workflows/benchmarks.yml`

Reporter: `scripts/report-benchmark-deltas.mjs`

## Result

The weekly/on-demand workflow now writes a schema-2 `fjord-bench` record for
each scenario under `current/`, downloads the newest non-expired
`release-benchmark-results` artifact from the default branch, and produces:

- `report.json`: the complete current record set plus structured comparisons;
- `report.md`: a per-scenario, per-metric current/previous/percentage delta table;
- the unchanged scenario JSON files needed as the next run's baseline.

The directory is uploaded as one 90-day artifact and `report.md` is appended to
the GitHub job summary. This is report-only: benchmark commands have no budget
flags, so a slower result remains visible without failing the workflow.

## Comparability

The reporter follows the harness contract. It compares only records with the
same scenario, fixture hash, OS, architecture, build profile, cache state,
warmup count, and repetition count. A missing baseline is labelled `no previous
baseline`; a mismatch lists the differing fields. Count metrics are context,
not regressions, and are omitted from the delta table. Distributions compare
P95; scalar resource metrics compare their recorded value and unit.

## Verification

`npm run test:benchmark-report` uses Node's built-in test runner. The regression
case supplies otherwise-identical records with P95 values of 100 ms and 125 ms
and asserts that the Markdown report contains `+25.0%`. Separate cases verify
that an absent baseline is reported and that different sampling settings are
refused rather than producing a misleading delta.

Result: **3 passed, 0 failed**.
