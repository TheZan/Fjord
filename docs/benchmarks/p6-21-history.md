# P6-21 — Depth-independent history paging

Date: 2026-08-10

Host:

- OS: Windows 11 Pro (26200), x86_64
- CPU: Intel64 Family 6 Model 191 Stepping 2
- Rust profile: `release`
- Cache state: warm (operator asserted)

These remain single-run checkpoints until `P6-22` implements the specified
warmup/repetition distribution. They are directly comparable architecture
checks, not P95 baselines.

## Result

| Packed fixture | Page | Before | After | SLO-8 |
| --- | --- | ---: | ---: | ---: |
| `hist-deep`, 500k commits | first 30 | 3639 ms | **7.733 ms** | 200 ms |
| `hist-deep`, 500k commits | page 10 | not recorded | **4.840 ms** | ≤ page 1 |
| `hist-deep`, 1M commits | first 30 | not recorded | **7.111 ms** | 200 ms |
| `hist-deep`, 1M commits | page 10 | not recorded | **3.592 ms** | ≤ page 1 |

The first page is now hundreds of times faster than the original 500k result,
and the 1M result is not slower than 500k. Page 10 is cheaper than page 1 on
both fixtures.

## What changed

The local history read moved from libgit2's `TOPOLOGICAL | TIME` revwalk to a
`gix` commit-time walk with commit-graph support explicitly enabled. The UI
draws its bounded graph lanes from each returned commit's parent ids, so it does
not need Git's global `--topo-order` guarantee — the guarantee that forced
libgit2 to buffer the entire reachable history before yielding one commit.

The opaque cursor carries at most ten pages of commit ids. Pages 2–10 therefore
read their bounded window directly instead of replaying `skip(offset)`; after
that, another bounded window is produced. A regression test crosses that
boundary, asserts no duplicates, and proves page 10 still uses the window.

Generating a million commits exposed a separate verification bottleneck. The
history fixture now seeds one realistic 50-file tree and streams the remaining
linear commits directly into a pack with `git fast-import`, reusing the tree.
This preserves the graph depth and commit-graph property under test while
avoiding millions of irrelevant working-tree writes, index scans, ref locks,
and loose objects. The complete 1M fixture generated, fully packed, and
measured in under one minute on this host.

## Reproduction

```text
cargo run --release -p fjord-bench -- --fixture hist-deep --cache-state warm
cargo run --release -p fjord-bench -- --fixture hist-deep --commits 1000000 --repo target/fjord-bench/hist-deep-1m --cache-state warm
```
