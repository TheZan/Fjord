# P7-PERF-01 — Repository runtime cold-open contention

Date: 2026-08-10  
Platform: Windows, release profile  
Command: `cargo test --release -p fjord-git cold_concurrent_open_profile -- --ignored --nocapture`

## Question

`RepositoryRuntimeRegistry::resolve()` currently holds its registry mutex while
`gix::open` and `git2::Repository::open` run. Does dispatching cold opens for
different repositories concurrently provide enough lost parallelism to justify
per-entry `Opening`/`OnceLock` state?

## Method

The ignored focused profile creates 32 independent empty repositories and measures
cold opens at cardinalities 1, 8, and 32. Sequential and current concurrent
callers use fresh registries. Seven samples are taken in alternating order and the
median is reported, avoiding the first-run antivirus/filesystem-cache outlier.

## Result

The current mutex coverage is confirmed. On this machine concurrent callers did
not improve wall time at 8 or 32 repositories; thread creation/scheduling made the
concurrent path slightly slower.

| Repositories | Sequential | Current concurrent callers | Concurrent delta |
|---:|---:|---:|---:|
| 1 | 1.439 ms | 1.634 ms | +13.6% |
| 8 | 11.326 ms | 12.626 ms | +11.5% |
| 32 | 46.481 ms | 49.201 ms | +5.9% |

## Decision

Keep the production registry synchronization unchanged. The measured concern is
not a significant bottleneck on this environment, and per-entry single-flight
would add lifetime and failure-state complexity without demonstrated benefit.
The ignored profile stays in-tree so a future workspace warm-up regression can be
remeasured before revisiting the design.
