# P4-18 Release Benchmark Checkpoint

Date: 2026-08-05 22:26:23 +03:00

Code checkpoint: P4-18 working tree before commit

Host:

- OS: macOS / Darwin 25.5.0 arm64
- Rust profile: `release` (`cargo run --release`)

## Single-repo log budget

Command:

```bash
cargo run --release -p fjord-bench -- --repo target/fjord-bench/p4-18-single-50k --commits 50000 --files 200 --log-limit 200 --force --budget-log-ms 150
```

Synthetic repository:

| Metric | Value |
| --- | ---: |
| Commits | 50,000 |
| Files | 200 |
| Branch | `main` |
| Dirty files | 0 |
| Conflict flag | `false` |
| Log limit | 200 |
| Returned commits | 200 |

Results:

| Operation | Time | Budget |
| --- | ---: | ---: |
| Open repository | 0.455 ms | — |
| Status | 3.535 ms | — |
| Log | 9.746 ms | < 150 ms |

Raw output:

```text
repo=target/fjord-bench/p4-18-single-50k
generated=true
commits=50000
files=200
branch=main
dirty_count=0
has_conflict=false
log_commits=200
open_ms=0.455
status_ms=3.535
log_ms=9.746
budget_log_ms=150.000 actual_log_ms=9.746 budget_log_ok=true
```

## Workspace dashboard budgets

Command:

```bash
cargo run --release -p fjord-bench -- --repo target/fjord-bench/p4-18-workspace-60k --workspace-repos 24 --commits 2500 --files 50 --force --budget-live-refresh-ms 1000 --budget-cached-dashboard-ms 5
```

Synthetic workspace:

| Metric | Value |
| --- | ---: |
| Repositories | 24 |
| Commits per repository | 2,500 |
| Total commits | 60,000 |
| Files per repository | 50 |
| Dashboard rows | 24 |
| Need attention | 0 |
| Behind origin | 0 |

Results:

| Operation | Time | Budget |
| --- | ---: | ---: |
| Fixture generation | 211,786.859 ms | — |
| Live status refresh for all repositories | 62.106 ms | < 1,000 ms |
| Cached dashboard read | 0.100 ms | < 5 ms |
| Global search | 56.528 ms | — |

Raw output:

```text
workspace_root=target/fjord-bench/p4-18-workspace-60k
generated=true
workspace_repos=24
commits_per_repo=2500
files_per_repo=50
dashboard_rows=24
need_attention=0
behind_origin=0
generation_ms=211786.859
live_refresh_ms=62.106
cached_dashboard_ms=0.100
global_search_hits=0
global_search_ms=56.528
budget_live_refresh_ms=1000.000 actual_live_refresh_ms=62.106 budget_live_refresh_ok=true
budget_cached_dashboard_ms=5.000 actual_cached_dashboard_ms=0.100 budget_cached_dashboard_ok=true
```
