# P6-18 SLO Audit

Date: 2026-08-10

Host: Windows 11 Pro, Intel64 Family 6 Model 191, x86_64 release build. All
new timing runs used packed fixtures, 3 discarded warmups and 20 measured
repetitions unless the metric itself specifies a fixed observation window.

P6-18 does not turn an unmeasured end-to-end target into a product claim. It
classifies every SLO as measured, corrected from evidence, or explicitly owned
by the packaged interaction/resource harness in Phase 11.

| SLO | Evidence / finding | Decision |
| --- | --- | --- |
| 1–2 | P6-10 proves first-paint ordering, but the repository has no packaged cross-OS startup driver. | Keep 1200/600 ms as targets; baseline in P11-01. |
| 3 | `ws-100` cached dashboard P50/P95/max **0.467/1.351/1.471 ms**; snapshot load **0.110/0.510/0.968 ms**. | Backend contribution passes 120 ms; WebView render remains P11-01. [JSON](p6-18-workspace-render.json) |
| 4 | Snapshot-load P95 **0.510 ms**; P6-15 previously measured 0.503 ms. | Backend is stable; action-to-paint remains P11-01. |
| 5 | Live no-snapshot path exists, but no scripted action-to-paint driver exists. | Keep 800 ms target; measure in P11-01. |
| 6 | Stable 150k result is P95 **300.701 ms**; the required 300k fixture has not been generated. | Keep 800 ms as a report target, not a gate, until the exact-size run. |
| 7 | The old row said “≤5k files / 40 ms” while its fixture actually contains 50k tracked + 220k noisy entries. Four same-hash P95 runs were **879.166 / 943.233 / 856.065 / 1443.908 ms**. | Correct scenario to `status-noisy-tree` and report budget to **1600 ms**. It is too variable for a gate. [passing corrected run](p6-18-wt-noisy-corrected-1600.json) |
| 8 | Packed 1M history P95 **7.111 ms**, page 10 **3.592 ms**. | 200 ms confirmed as a report budget. |
| 9 | No ≤2 MB first-viewport WebView scenario exists. | Keep 250 ms target; add to packaged interaction driver in P11-01. |
| 10 | Bounded giant-diff backend response P95 **34.592 ms**, 184 bytes; full viewport timing is absent. | Backend prerequisite passes 600 ms; UI portion remains P11-01. |
| 11 | Watcher debounce and generation delivery are tested, but not event-to-paint. | Keep 500 ms target; packaged driver must report quiet and 5 s max-delay paths separately. |
| 12 | No background-priority scheduler or input-under-load driver exists. | Keep 50 ms target; P11-04 owns the measurement and implementation. |
| 13 | Tiered backend model over 60.180 s: **0.389% of one core** with 35 recursive and 65 metadata watchers. | Backend passes <1%; full Tauri/WebView process remains P11-02. [JSON](p6-18-idle-cost.json) |
| 14 | Same run: maximum **24.000 MiB RSS** over 52 OS samples, with 3 Hot, 32 Warm, 65 Cold repositories. | Backend floor passes 600 MiB; full-process RSS remains P11-02. |
| 15 | The old 62 ms value is a local status refresh, not fetch, and the old 5132 ms value is sequential total work. | Keep the ≤2× slowest invariant as a target; require controlled local remotes before a baseline or gate. |
| 16 | The old 232 ms was one run. Four 20-sample P95 runs are **502.503 / 481.353 / 491.735 / 512.271 ms**. | Correct report budget from 300 to **550 ms**; do not gate until CI supplies stable baselines. [passing corrected run](p6-18-refs-many-corrected.json) |

## Resource scenario

`fjord-bench --fixture ws-100 --scenario idle-cost` now constructs the tier
shape implemented by P6-17: 3 Hot + 32 Warm repositories retain Git handles and
recursive watches, while 65 Cold repositories use `.git`-only watches and no
retained handles. After a two-second warmup it reads process CPU time and RSS
from the operating system over `--idle-seconds` (60 by default); RSS is the
maximum of regular samples across the window. This deliberately does not include
WebView memory, so the result is recorded as a backend floor.

`workspace-render` now seeds status once and samples the cached render input
without putting the old sequential 100-repository refresh inside every timing
iteration. The sequential scenario remains available under the fixture's
default scenario and is still total work, not user latency.

## Gate decision

P6-18 supplies report baselines and corrected targets. It promotes no new gate:
SLO-7 is visibly unstable, SLO-16 has local repeated runs but not CI history,
and every end-to-end or full-process resource SLO still lacks its packaged
driver. P6-19 may publish these records; P6-20 must wait for three stable CI
baselines per scenario.
