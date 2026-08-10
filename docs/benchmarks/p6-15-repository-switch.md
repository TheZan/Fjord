# P6-15 Snapshot-first Repository Switch

Date: 2026-08-10

Fixture: `ws-100`, packed and reused. Release profile on Windows 11, warm
operator-asserted cache, 3 discarded warmups and 20 measured repetitions.
Machine-readable result: [`p6-15-repo-switch.json`](p6-15-repo-switch.json).

| Metric | P50 | P95 | Max | SLO-4 |
| --- | ---: | ---: | ---: | ---: |
| persisted `repo_snapshot` load + JSON decode | 0.143 ms | **0.503 ms** | 0.785 ms | 150 ms end to end |

This is the backend contribution to a warm repository switch, not a claim that
SQLite alone measures WebView paint. It leaves 149.497 ms of the provisional
SLO-4 budget for IPC, query-cache hydration, React commit, and paint. Those
frontend stages are already covered by the end-to-end interaction trace and
will receive the formal product-level baseline in P6-18.

The semantic fast path is deterministic and covered separately: a component
test holds live revalidation open, observes the persisted status/refs/history/
working state in the query cache, then resolves revalidation and observes the
same mounted view patched to live state. Revalidation starts only after the
snapshot's paint opportunity, and deactivation capture bypasses interaction
telemetry, so neither background operation extends the warm-switch trace.

For context, the same run reported `cached_dashboard` P95 2.065 ms and the
known-sequential `live_refresh` P95 1302.972 ms. The latter is total work over
100 repositories and is not user-visible switch latency.
