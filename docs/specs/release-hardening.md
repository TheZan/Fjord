# Spec: packaged performance and release quality gates

Referenced by: P11-01–P11-08, SDD §11, §15.
Related: [`performance.md`](performance.md), [`../release.md`](../release.md),
[`../manual-git-compatibility.md`](../manual-git-compatibility.md),
[`../benchmarks/`](../benchmarks/).

## Problem

Phase 6 establishes SLOs, fixtures, and telemetry — all measured through
`fjord-bench` and a development build. That leaves three gaps between "fast in the
harness" and "fast for a user who installed the app":

1. **Nothing is measured in the shipped artifact.** `fjord-bench` links the crates
   directly; it never starts the packaged binary, never pays WebView startup, never
   loads the bundled frontend assets, and never runs through the installer's
   filesystem layout. Startup — the first thing a user judges — is the metric least
   covered by the existing harness.
2. **Resource behavior over time is unknown.** All current measurements are
   single-shot. Memory growth across an hour of use, cache eviction behavior at
   `ws-100`, and background work competing with the active repository are
   unmeasured, and these are exactly the properties that make a fast app feel slow
   after lunch.
3. **Release readiness is a checklist, not a gate.** [`../release.md`](../release.md)
   and [`../manual-git-compatibility.md`](../manual-git-compatibility.md) describe
   what to verify; nothing mechanically prevents shipping a build that regressed.

## Goals

- Startup and interaction measurement against the **packaged** application on
  Windows, macOS, and Linux.
- Enforced memory budgets and a measured eviction policy under sustained use.
- A background scheduler whose priorities are observable and testable, so
  background work provably yields to the active repository.
- Predictive prefetch that is measured, and removed if it does not pay for itself.
- An in-app performance diagnostics surface for developers and bug reports.
- A regression dashboard with history, not just a pass/fail per run.
- Alpha/beta quality gates that a release cannot bypass silently.

## Non-goals

- New product features. This phase hardens what Phases 5–10 built.
- Telemetry that leaves the user's machine. All measurement is local or CI-side;
  Fjord ships no usage reporting.
- Per-user adaptive tuning. Budgets and tiers are configuration, not learned
  behavior.
- Replacing the packaging pipeline. `.github/workflows/release.yml` and the
  bundle-smoke matrix stay; this phase adds measurement stages to them.

## Current state

| Area | State |
|---|---|
| Packaged validation | ✅ `bundle-smoke` builds unsigned bundles on three OSes and asserts the askpass sidecar is present (`.github/workflows/ci.yml`). No runtime measurement. |
| Release pipeline | ✅ Signed draft releases, updater artifacts, injected updater config (`.github/workflows/release.yml`, [`../release.md`](../release.md)). |
| Benchmarks | ⚠️ Library-level, Linux-only, weekly (`.github/workflows/benchmarks.yml`), three budget flags, human-readable output. Phase 6 makes them JSON and multi-fixture. |
| Startup measurement | 🚧 None at any level. |
| Memory / CPU | 🚧 Never measured. |
| Scheduler | ⚠️ Bounded worker pool for bulk operations and search (`Semaphore` + `JoinSet`, 6 workers). No priorities: a background refresh and a user-initiated action compete equally. |
| Prefetch | ⚠️ Hover-warm with an 80 ms debounce (`warmRepositoryData`), unmeasured. |
| Diagnostics UI | ⚠️ Git environment diagnostics in Settings ✅; no performance surface. Frontend `Profiler` marks are dev-only. |
| Regression history | 🚧 Point-in-time markdown checkpoints in [`../benchmarks/`](../benchmarks/); no series, no trend. |
| Release gates | ⚠️ Manual checklists ([`../release.md`](../release.md), [`../manual-git-compatibility.md`](../manual-git-compatibility.md)). |

## Proposed design

### 1. Packaged startup profiling

A harness that installs or unpacks the built artifact, launches it with a
profiling flag, and reads structured startup marks the app emits to a file:

```text
process_start → tauri_setup → db_open → window_created → webview_ready
   → first_paint → shell_interactive → workspace_rendered → first_git_work
```

- Marks are emitted by the existing `tracing` subscriber to a dedicated
  newline-delimited JSON file when `FJORD_STARTUP_PROFILE` is set, so a released
  binary can produce them without a special build.
- The frontend contributes `first_paint`, `shell_interactive`, and
  `workspace_rendered` through one IPC call carrying its own marks — the phase
  ordering rules from [`performance.md`](performance.md) §3 apply (each side
  reports its own durations).
- Cold start is measured after clearing the OS file cache where the platform
  allows it, and is reported separately from warm start; a run that could not
  guarantee a cold cache is labeled, never silently reported as cold.
- Runs on all three OSes in CI against the same bundles `bundle-smoke` already
  produces, so the measured artifact is the shipped artifact.

This is what makes SLO-1 and SLO-2 real rather than provisional.

### 2. Memory budgets and eviction

- The harness drives a scripted session against `ws-100`: open the workspace,
  visit 30 repositories, run bulk fetch, idle for 10 minutes, revisit 10
  repositories. It samples RSS and handle counts throughout.
- Budgets: SLO-14 (600 MB resident at 100 tracked / 5 hot) becomes a gate, plus a
  growth bound — resident memory after the idle segment must not exceed the
  pre-idle peak, which is what catches a leak that a single-shot measurement
  cannot.
- Eviction is validated by assertion, not inference: after visiting 30
  repositories with `max_hot = 3` and `max_warm = 32`, the runtime registry holds
  the expected tier counts and the evicted repositories hold no open handles.
- Handle counts are asserted on Windows specifically, where a retained handle is
  user-visible as a file-locking failure.

### 3. Background priority scheduler

Today one bounded pool serves bulk operations and search. It gains priority
classes:

| Class | Work | Rule |
|---|---|---|
| Interactive | Anything the active repository's visible view is waiting on | Never queued behind a lower class; own reserved capacity |
| Warm | Status refresh and snapshot capture for warm-tier repositories | Yields to interactive |
| Background | Cold-tier refresh, prefetch, snapshot writes, auto-fetch | Yields to both; cancelled when the active repository changes |

Implementation: separate semaphores per class with reserved capacity for
interactive work, plus cancellation tokens tied to the active repository, so a
repository switch cancels prefetch for the repository the user left. The scheduler
exposes its queue depths and class occupancy to the diagnostics surface — a
scheduler that cannot be observed cannot be tuned.

Testable invariant: with the background class saturated, an interactive request
still starts within a bounded delay (SLO-12's budget class).

### 4. Predictive prefetch

Extends hover-warm to a small, explicit prediction set:

- the repositories adjacent to the selection in the current list (arrow-key
  navigation is a strong predictor);
- the most recently used repositories in the active workspace;
- the next history page when the commit graph is within one page of its end.

All prefetch runs in the Background class and is cancelled on selection change.

Prefetch must justify itself: the phase ships an A/B measurement of SLO-4 and
SLO-5 with prefetch enabled and disabled, on `ws-100`. If the difference is within
noise, prefetch is reduced to hover-warm rather than kept for intuition's sake.

### 5. Developer performance diagnostics

A Settings section (behind the `performance_diagnostics` flag from
[`performance.md`](performance.md) §3) showing:

- recent interaction traces with their seven-phase breakdown;
- runtime registry contents by tier, with cache hit rates and generation counters;
- scheduler queue depths and class occupancy;
- watcher counts by tier and recent event rates;
- current process memory and handle counts.

Everything is local and copyable as JSON, with the same redaction rules as logs
(no paths, no repository names, no content). This is the surface that makes a
"Fjord is slow for me" bug report actionable.

### 6. Regression dashboard

- Every benchmark run appends a JSON record keyed by
  `{ scenario, os, runner_class, commit, timestamp, fixture_manifest_hash }`.
- Records accumulate in a dedicated branch or a release artifact series; the
  workflow renders a static HTML/markdown trend page per scenario, published as a
  workflow artifact.
- A run is compared against the median of the last five records on the same runner
  class, not against a single previous run, so ordinary CI variance does not read
  as a regression.
- The dashboard shows budget, current, median-of-5, and delta per scenario.

### 7. Release quality gates

A release build fails unless:

| Gate | Source |
|---|---|
| All CI jobs green on three OSes | `.github/workflows/ci.yml` |
| Bundle smoke passes with the sidecar present | existing |
| Fresh-install lifecycle smoke passes on the three CI operating systems and the candidate packages have manual clean-machine evidence | [`../v0.1-fresh-install-smoke.md`](../v0.1-fresh-install-smoke.md) |
| Gated SLOs within budget on all three OSes | §1, §2, [`performance.md`](performance.md) §10 |
| No memory-growth violation in the sustained session | §2 |
| Manual Git compatibility matrix complete for the target environments | [`../manual-git-compatibility.md`](../manual-git-compatibility.md) |
| Release checklist complete | [`../release.md`](../release.md) |

For the v0.1 Early Preview, the Release workflow implements a narrower first
public packaging gate ahead of the generalized Phase 11 channel/performance
gates. It requires same-SHA CI, reports each package matrix leg independently,
keeps the GitHub release draft/prerelease, and aggregates every packaging or
manual-evidence blocker in a final protected-environment job. It does not make
the repository public or claim that the later sustained-session/SLO gates exist.

Alpha and beta channels differ only in which gates are advisory: alpha reports
SLO violations, beta fails on them, stable fails on everything above. The
distinction is encoded in the workflow, not in a person's judgment on the day.

## Alternatives considered

**Startup measurement: instrument the app vs. wrap it with an external profiler.**
An external profiler (ETW, Instruments, `perf`) gives more detail and a different
setup per OS, plus results that are hard to compare across platforms. App-emitted
marks give one comparable format everywhere and work on a user's machine for bug
reports. External profilers remain available for investigating a regression the
marks have already located.

**Memory budgets: hard gate vs. advisory.** A hard RSS gate is noisy across
runner classes and OS allocators. It is chosen anyway, but paired with the growth
bound, which is the allocator-independent signal — a gate on absolute RSS alone
would either be too loose to catch anything or too tight to stay green.

**Scheduler: priority classes vs. one pool with request ordering.** Reordering a
single queue is less code and does not prevent a long-running background task
already in flight from occupying a worker. Reserved capacity per class does, which
is the property SLO-12 needs.

**Dashboard: hosted service vs. artifacts in the repository.** A hosted service is
nicer to read and adds an external dependency and an account to a project whose CI
must work from a fork. Committed JSON plus a rendered artifact is chosen.

**Prefetch: keep on intuition vs. measure and possibly remove.** Prefetch is the
kind of optimization that is easy to justify and hard to falsify. Measuring it is
the same discipline this roadmap applies to every other performance claim.

## Performance considerations

- Startup marks are a handful of writes to an already-open log sink and are only
  written when the profiling variable is set; the un-profiled path is unchanged.
- Diagnostics collection is off by default and, when on, reads pre-existing
  counters — it must not add work to the paths it measures.
- The scheduler's reserved capacity reduces total throughput for background work
  by design; the bulk-operation SLO (SLO-15) must be re-verified after it lands.
- The sustained-session harness is expensive and runs on the scheduled workflow
  only, never on a PR.

## Security / safety

- No measurement data leaves the machine or the CI run. There is no telemetry
  endpoint, and this spec introduces no network call.
- Startup profile files and diagnostics exports follow the SDD §10 rule: no file
  contents, no diff bodies, no repository paths or names — identifiers, phase
  names, durations, and counts only.
- The profiling environment variable enables *emission*, never a behavior change;
  a profiled run must execute the same code path as an unprofiled one.
- Release gates may not be bypassed by a workflow input; a skipped gate requires a
  recorded justification in the release notes.

## Testing strategy

| Level | Coverage |
|---|---|
| Unit | Startup mark ordering and serialization; scheduler class admission and reserved capacity; dashboard record parsing and median-of-5 comparison. |
| Integration | Eviction assertions (tier counts, handle release); cancellation of background work on repository switch; diagnostics export contains no paths or names. |
| E2E | Scripted sustained session against `ws-100` producing memory, handle, and interaction-trace series. |
| OS-specific / manual | Cold-start measurement per OS including cache-clearing preconditions; Windows handle-count assertions; macOS notarized-build launch timing. |
| Benchmark / regression | Packaged startup on three OSes; interactive-latency-under-load; prefetch A/B; all recorded to the dashboard. |

## Acceptance criteria

1. A packaged build on each of Windows, macOS, and Linux produces a startup
   profile with all nine marks of §1, and the harness reports cold and warm start
   separately, labeling any run whose cold-cache precondition could not be met.
2. SLO-1 and SLO-2 are measured against packaged builds and are no longer marked
   provisional in [`performance.md`](performance.md).
3. The sustained session against `ws-100` reports resident memory within SLO-14
   and shows no growth above the pre-idle peak after the idle segment.
4. After visiting 30 repositories, the runtime registry holds exactly the
   configured hot and warm counts, and no evicted repository retains an open Git
   handle — asserted on Windows by successfully renaming an evicted repository's
   working tree.
5. With the background class saturated on `ws-100`, a user-initiated interactive
   request begins within SLO-12's budget, verified by trace timestamps.
6. Switching repositories cancels in-flight prefetch for the previous repository,
   verified by scheduler counters.
7. The prefetch A/B measurement is recorded in [`../benchmarks/`](../benchmarks/)
   with an explicit keep-or-reduce decision based on the measured difference.
8. The diagnostics surface shows traces, tiers, cache hit rates, scheduler
   occupancy, watcher counts, and memory, and its JSON export contains no
   repository paths, names, or file contents.
9. The benchmark workflow publishes a per-scenario trend page comparing budget,
   current, and median-of-5, and flags a regression only against that median.
10. A release workflow run fails when any gated SLO is over budget on any of the
    three OSes, and the failure names the scenario and the measured value.
11. Alpha, beta, and stable channels differ only in gate severity, encoded in the
    workflow configuration, with no manual override path that leaves no record.
