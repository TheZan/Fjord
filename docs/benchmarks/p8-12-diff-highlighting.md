# P8-12 Visible-Window Diff Highlighting

Date: 2026-08-12

Host: Windows, development Node runtime. Fixture:
`target/fjord-bench/diff-giant/huge/long.txt`, first 120 lines representing a
virtualized visible window. Three warmups were discarded and 20 samples were
measured with the same tokenizer used by `diffHighlight.worker.ts`.

| Metric | Value |
| --- | ---: |
| Visible lines | 120 |
| Input characters | 2,052 |
| P50 | 0.073 ms |
| P95 | 0.403 ms |
| Max | 0.417 ms |

This isolates worker computation rather than packaged WebView scheduling; the
scripted shipped-artifact viewport measurement remains part of the Phase 11
driver gate. The Phase 8 ordering contract is covered separately by the hook
trace test: `fjord:diff:plain-paint` is recorded before worker construction,
and `fjord:diff:highlight-commit` only after the asynchronous response commits.

Windows larger than 240 lines or 120,000 characters are intentionally not
tokenized. Unknown extensions also remain plain. Both fallbacks preserve first
paint and bound worker CPU/memory rather than attempting a late upgrade.
