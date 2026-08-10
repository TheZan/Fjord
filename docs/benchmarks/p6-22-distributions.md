# P6-22 — Benchmark distributions

Date: 2026-08-10

Host:

- OS: Windows 11 Pro (26200), x86_64
- CPU: Intel64 Family 6 Model 191 Stepping 2
- Rust profile: `release`
- Cache state: warm (operator asserted)
- Sampling: 3 discarded warmups, 20 measured repetitions

## Verification runs

| Fixture / metric | P50 | P95 | Max | Budget |
| --- | ---: | ---: | ---: | ---: |
| `wt-huge` 150k / `status` | 291.109 ms | **300.701 ms** | 305.045 ms | 800 ms at 300k |
| `hist-deep` 500k / first page | 7.833 ms | **8.416 ms** | 8.820 ms | 200 ms at 1M |
| `hist-deep` 500k / page 10 | 6.266 ms | **6.582 ms** | 6.735 ms | ≤ page 1 |

The three old single `wt-huge` readings were 299, 325, and 568 ms — a 1.9×
range that could not support a gate. In the methodology run, max/P50 is 1.048×
and P95/P50 is 1.033×. This is stable enough to quote as a warm-cache
distribution, while the fixture is still half the SLO-6 target and therefore
does not confirm the 300k budget.

## Harness contract

`fjord-bench` now defaults to `--warmups 3 --repetitions 20`. Every product
duration is emitted as P50/P95/max in text and in JSON schema 2; the legacy
`name_ms` text key and JSON `value` both alias P95. Budget `actualMs` is always
that P95. Result comparison also requires identical sampling settings, so a
five-run exploratory result cannot silently become the baseline for a 20-run
gate.
Supplying a budget with fewer than 20 repetitions is rejected; short runs stay
available for exploratory measurements only.

The generation duration remains a single informational metric: it describes
whether the harness spent time constructing its input and is not a product SLO.

## Reproduction

```text
target/release/fjord-bench.exe --fixture wt-huge --cache-state warm --budget-status-ms 800
target/release/fjord-bench.exe --fixture hist-deep --cache-state warm --budget-log-ms 200
```
