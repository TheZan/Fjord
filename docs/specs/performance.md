# Spec: performance foundation

Referenced by: P6-01–P6-20, SDD §5.3, §11, §15.
Related: [`git-backend.md`](git-backend.md), [`ipc-commands.md`](ipc-commands.md),
[`data-model.md`](data-model.md), [`operation-events.md`](operation-events.md),
[`release-hardening.md`](release-hardening.md).

## Problem

Fjord's product claim is "one of the fastest Git clients". Today that claim rests
on four numbers from two synthetic scenarios ([`../benchmarks/p4-18-release.md`](../benchmarks/p4-18-release.md))
and on subjective impressions. Three concrete consequences:

1. **No budget exists for the latency the user actually feels.** Every recorded
   number is a backend call in isolation (`status_ms`, `log_ms`). Nothing measures
   *user action → visible pixels*, which is the only latency a user experiences.
   A 9.7 ms `log` call can still land in a 400 ms repository switch.
2. **The heaviest realistic workloads are untested.** The largest fixture is
   50 000 commits / 200 files. Real monorepos reach 150k–300k working-tree files
   and 500k–1M commits; real workspaces reach 100+ repositories. Fjord has never
   been run against any of them, so "fast at scale" is currently unfalsifiable.
3. **State is recomputed rather than kept.** Every repository read re-opens the
   repository (`LocalGitBackend::open` per call, see `crates/fjord-git/src/local/`),
   and any filesystem event invalidates every query the change set touches. There
   is no long-lived per-repository state and no generation model, so switching
   back to a repository the user visited a minute ago costs exactly as much as
   opening it the first time.

## Goals

- A published, measurable SLO per user-visible interaction, each with a defined
  measurement method and an owner benchmark scenario.
- Torture fixtures that represent the workloads Fjord claims to handle, generated
  reproducibly by `fjord-bench`.
- End-to-end latency attribution: for any slow interaction, the split between
  frontend dispatch, IPC, Rust work, IPC return, and React render/paint is
  visible without a debugger.
- A `RepositoryRuntime` that keeps open repository state alive, so repeated reads
  of an unchanged repository do not repeat setup work.
- Generation-scoped invalidation: a working-tree write must not invalidate refs,
  history, or stash state.
- Snapshot-first repository switching: a repository with a known snapshot paints
  its primary view without waiting for a fresh Git computation.
- Payloads that stay bounded regardless of repository size — no unbounded diff
  or history crosses IPC.
- Performance regression reporting in CI, then gates once the SLOs are backed by
  measurements on real fixtures.

## Non-goals

- Replacing React, Tauri, `gix`, or `git2`. SDD §5.2 and the roadmap principle in
  §15 hold: a component swap requires profiling evidence that the component is
  the bottleneck, produced by the instrumentation this spec defines.
- Micro-optimizing Rust (allocations, data structures) before measurement. The
  order is measure → locate → change architecture → measure → only then optimize.
- Caching Git object data in SQLite as a source of truth. Caches stay
  reconstructible; [`data-model.md`](data-model.md) §"What's deliberately not here"
  continues to apply, with the single documented exception of the repository
  snapshot table introduced below (a cache, droppable at any time).
- Multi-process or GPU rendering architectures.

## Current state

| Area | State |
|---|---|
| Backend caching | ⚠️ Only `repo_status_cache` (dashboard summary). Every other read is live. |
| Repository handles | 🚧 None. `status`, `branches`, `log`, `diff` each open the repository again; a per-path `RwLock` (`crates/fjord-git/src/locking.rs`) serializes writers only. |
| Invalidation | ⚠️ `RepoChangeSet { status, working, history, refs, stashes }` is computed per filesystem burst in `crates/fjord-fs/src/watcher.rs` and emitted as `fjord-repository-changed`. It is a *hint per event*, not a durable generation, so nothing can answer "is my cached snapshot still valid?". |
| Frontend caching | ✅ TanStack Query with `staleTime: Infinity` and 30 min `gcTime` (`src/application/repositoryQueryPolicy.ts`); explicit invalidation from watcher events. Lost on reload; not persisted. |
| Prefetch | ✅ `warmRepositoryData` prefetches status/branches/tags/first commit page/working changes on hover (80 ms debounce) and on selection (`src/presentation/App.tsx`). |
| Virtualization | ✅ Commit graph, all-repositories list, dashboard grid, diff rows (`@tanstack/react-virtual`). |
| Graph layout | ✅ Moved off the UI thread (`src/presentation/graphLayout.worker.ts`, `useGraphLayout.ts`). |
| Frontend timing | ⚠️ `src/presentation/performance.tsx` records React `Profiler` durations as `performance.measure` entries — dev-only, frontend-only, no IPC or backend correlation. |
| Startup | ⚠️ `src/main.tsx` awaits `getSettings()` (IPC) and `initI18n()` before the first `createRoot().render()`. First paint is behind two round trips. |
| Diff transport | ⚠️ `get_file_diff` returns every hunk and every line of a file in one IPC payload. Rendering is virtualized; the payload is not bounded. |
| History transport | ✅ Paginated (`log(cursor, limit)`, page size 30). |
| Benchmarks | ⚠️ `fjord-bench` covers single-repo open/status/log and a 24-repo workspace, with three budget flags; weekly workflow `.github/workflows/benchmarks.yml`. Human-readable stdout only. |
| Idle cost | 🚧 Never measured. One `RepoEventWatcher` thread per repository, created for every tracked repository at bootstrap (`crates/fjord-app/src/state.rs`). |

## Proposed design

### 1. SLO catalogue

Budgets are **P95 on a release build**, on the reference machine defined below,
unless a row says otherwise. Rows marked *provisional* have no measurement yet
and are what `P6-18` must confirm or correct — a provisional number is a
hypothesis, not a promise, and is never quoted as a property of the product.

Reference machine for published numbers: the CI runner class used by
`.github/workflows/benchmarks.yml`, plus one recorded developer machine per OS in
[`../benchmarks/`](../benchmarks/). Budgets are compared against the CI runner;
developer runs are context, not gates.

Every row names the **scenario** that measures it: a harness entry point plus the
fixture it runs against (§2). A scenario name is the identifier `fjord-bench`
emits in its JSON output, so a budget, a measurement, and a CI result can always
be joined. No SLO may exist without one — a budget nobody can run is a wish.

| # | Interaction | Budget (P95) | Scenario | Fixture | Status |
|---|---|---|---|---|---|
| SLO-1 | Cold start → first usable UI (window painted, workspace list rendered from snapshot, input accepted) | 1200 ms | `startup-cold` | `ws-100` | provisional |
| SLO-2 | Warm start → first usable UI | 600 ms | `startup-warm` | `ws-100` | provisional |
| SLO-3 | Workspace snapshot render, 100 repositories, cached | 120 ms | `workspace-render` | `ws-100` | provisional; anchored by a measured 0.1 ms cached dashboard read at 24 repos |
| SLO-4 | Repository switch with a valid snapshot → primary view painted | 150 ms | `repo-switch-warm` | `ws-100` | provisional |
| SLO-5 | Repository switch without a snapshot → primary view painted | 800 ms | `repo-switch-cold` | `ws-100` | provisional |
| SLO-6 | `status`, 300k-file working tree, warm runtime | 800 ms | `status-huge-tree` | `wt-huge` | provisional; measured 3.5 ms at 200 files, unknown at 300k |
| SLO-7 | `status`, ≤5k files, warm runtime | 40 ms | `status-small-tree` | `wt-noisy` | measured: 3.5 ms at 200 files ([`p4-18-release.md`](../benchmarks/p4-18-release.md)) |
| SLO-8 | First commit page (30 commits) on a 1M-commit repository | 200 ms | `log-first-page` | `hist-deep` | measured: 9.7 ms for 200 commits at 50k history ([`p4-18-release.md`](../benchmarks/p4-18-release.md)) |
| SLO-9 | Diff first viewport painted, file ≤2 MB | 250 ms | `diff-first-viewport` | `diff-giant` | provisional |
| SLO-10 | Diff first viewport painted, giant file (≥50 MB or ≥500k lines) | 600 ms | `diff-first-viewport-giant` | `diff-giant` | provisional; needs the windowed transport in §9 |
| SLO-11 | Watcher event → visible UI update, single repository | 500 ms | `watcher-to-paint` | `wt-noisy` | provisional; the 5 s max-delay debounce path is deliberately outside this budget and is reported separately |
| SLO-12 | UI input latency (keystroke → frame) during background work | 50 ms | `input-under-load` | `ws-100` | provisional |
| SLO-13 | Idle CPU, 100 tracked repositories, no input, 60 s window | < 1% of one core, mean | `idle-cost` | `ws-100` | provisional |
| SLO-14 | Resident memory, 100 tracked repositories, 5 hot | 600 MB | `idle-cost` | `ws-100` | provisional |
| SLO-15 | Bulk fetch, 24 repositories | wall clock ≤ 2× slowest single repository | `bulk-fetch` | `ws-100` | architectural invariant of the bounded pool; measured 62 ms for a 24-repo live refresh |
| SLO-16 | Refs read (branches + tags), 5k branches / 5k tags | 300 ms | `refs-read` | `refs-many` | provisional |

Existing SDD §11 budgets are absorbed here: cached dashboard read (24 repos)
< 5 ms and uncached parallel refresh < 1 s remain as measured floors and become
the smaller-scale anchors of SLO-3 and SLO-15. The `log` page budget of < 150 ms
becomes SLO-8 at a twenty-fold larger history.

Eleven of the seventeen rows are provisional, which is the honest state: the
existing benchmarks measure two scenarios on fixtures an order of magnitude
smaller than the ones Fjord claims to handle. `P6-18` converts them or revises
them with a recorded rationale; until then, no provisional number is quoted as a
property of the product.

**Measurement methodology.**

| Class | SLOs | Method |
|---|---|---|
| Backend | 6, 7, 8, 15, 16 | `fjord-bench` runs the scenario against a generated fixture, reports JSON, and fails on a budget flag. Timing brackets the port call only. |
| End-to-end | 1–5, 9–12 | The interaction-trace mechanism (§3) driven by a scripted interaction driver; reported as P50/P95/max over ≥20 repetitions after 3 warmups. |
| Resource | 13, 14 | Sampled by the harness over a fixed window with the app idle after a defined warmup; RSS and CPU read from the OS, not from inside the process. |

Rules that apply to every class:

- A run records OS, CPU model, profile, and fixture manifest hash. Results from
  different platforms are never compared; the harness refuses to.
- A budget is **reported** until its scenario has produced at least three
  consecutive stable results in CI, and only then becomes a **gate** (§10). A
  gate that lands before its baseline is noise, and noise gets disabled.
- P95 over ≥20 repetitions is the comparison statistic. Single-shot timings are
  recorded but never gated: the existing checkpoints are single-shot, which is
  why they are anchors rather than budgets.
- A measurement that cannot meet its scenario's preconditions (a cold OS file
  cache, most often) is labeled, never silently reported as if it had.

### 2. Torture fixtures

`fjord-bench` grows a fixture catalogue. Fixtures are generated, never committed,
and are content-addressed by their parameters so a regenerated fixture is
byte-comparable enough for stable timings. Generation is expensive (the existing
24×2500-commit fixture takes ~212 s); therefore:

- every fixture writes a manifest file (`.fjord-bench-manifest.json`) with its
  parameters and a schema version, and generation is skipped when the manifest
  matches — `--force` regenerates;
- CI caches fixture directories keyed by the manifest hash;
- the heaviest fixtures run in the scheduled workflow, not on every PR.

| Fixture | Parameters | Exercises |
|---|---|---|
| `wt-huge` | 150k / 300k tracked files, shallow history | SLO-6, watcher cost, index reads |
| `wt-noisy` | 50k tracked + 200k ignored + 20k untracked files | status filtering, watcher filtering, ignore handling |
| `hist-deep` | 500k and 1M commits, 5k files | SLO-8, commit-graph traversal, cursor paging |
| `refs-many` | 5k branches, 5k tags, 20 remotes | refs read path, branch tree render, palette/search |
| `diff-giant` | one 50 MB text file, one 500k-line file, one binary blob | SLO-9, SLO-10, diff transport |
| `ws-100` | 100 repositories × 2k commits | SLO-3, SLO-13, SLO-14, bulk operations, watcher fan-out |
| `win-fs` | `wt-huge` + `wt-noisy` executed on Windows with a warm and a cold OS file cache | Windows `ReadDirectoryChangesW`, path canonicalization, NTFS metadata cost |

`win-fs` is a scenario, not a separate generator: the Windows-specific cost is in
execution, and the harness must record which OS produced a result so numbers are
never compared across platforms by accident.

### 3. End-to-end interaction telemetry

Goal: attribute one user interaction across the whole stack.

Model: an **interaction trace**. The frontend mints an `interactionId`
(monotonic counter + session nonce) at the input event and records marks; every
IPC call made while that interaction is active carries the id; the backend records
spans against it; the frontend closes the trace at the first paint that satisfies
the interaction's completion predicate.

```text
input event ──▶ frontend dispatch ──▶ IPC send ──▶ Rust handler ──▶ port/adapter work
                                                                        │
   paint ◀── React commit ◀── query settle ◀── IPC return ◀─────────────┘
```

Recorded phases per trace:

| Phase | Recorded by | Source |
|---|---|---|
| `input→dispatch` | frontend | `event.timeStamp` → handler entry |
| `dispatch→ipc_send` | frontend | mark before `invoke` |
| `ipc_send→handler_entry` | backend | handler receives client timestamp |
| `handler` | backend | `tracing` span, split per port call |
| `handler_exit→ipc_return` | frontend | mark on promise settle |
| `ipc_return→react_commit` | frontend | `Profiler` `commitTime` |
| `react_commit→paint` | frontend | `requestAnimationFrame` after commit |

Transport and contracts:

- Frontend marks use `performance.measure` with a `detail` payload
  (`src/presentation/performance.tsx` is the seed of this module and gets
  extended, not replaced).
- Backend spans are `tracing` spans carrying `interaction_id`; a bounded ring
  buffer (default 512 traces) holds recent completed traces in memory.
- One new IPC command, `get_interaction_traces`, drains the ring buffer for the
  diagnostics panel. Enabled by a settings flag (`performance_diagnostics`),
  default off in release builds; the `interactionId` argument itself is always
  accepted and costs one string field per call.
- Traces contain no paths, no repository names, no diff content — ids, phase
  names, durations, and counts only, so a trace dump is safe to attach to a bug
  report (SDD §10 rule).

Clock skew between the WebView and Rust is real. The contract therefore never
subtracts a frontend timestamp from a backend timestamp directly: the backend
reports its own durations, and the frontend derives IPC overhead as
`total_round_trip − backend_reported_duration`. Skew cannot corrupt a duration
computed on one side.

### 4. `RepositoryRuntime`

A long-lived, per-repository state object owned by the backend.

```text
RepositoryRuntimeRegistry
  ├── key: canonical repository path (via fjord-fs normalization)
  ├── value: Arc<RepositoryRuntime>
  └── tier: Hot | Warm | Cold  (§7)

RepositoryRuntime
  ├── gix::ThreadSafeRepository handle       (open once, reused)
  ├── git2::Repository behind the existing per-repo RwLock
  ├── generations: GenerationSet              (§5)
  ├── caches: refs, status summary, first history page, stash list
  ├── watcher subscription                    (feeds generation bumps)
  └── last_used_at, tier
```

Responsibilities:

- **Owns handles.** `GitBackend` methods take a runtime instead of re-opening the
  repository. This is an internal change to `fjord-git`; the port surface keeps
  taking `&RepoPath`, and the adapter resolves the path to a runtime. Services and
  IPC contracts are unchanged, which keeps the change reversible.
- **Owns caches with generation stamps.** Every cached value stores the generation
  it was computed at. A read returns the cached value when the stamp matches the
  current generation, and recomputes otherwise.
- **Owns lifecycle.** Created on first access, demoted and evicted per §7,
  destroyed when the repository is removed from a workspace.

Concurrency: reads take the existing per-repository read lock and may run in
parallel; a write takes the write lock and bumps generations on completion.
Cache fills are single-flighted per (repository, query, generation) so twenty
concurrent dashboard reads cause one status computation, not twenty.

Failure handling: a runtime that fails to open is *not* cached as a poisoned
entry beyond a short negative-cache window (5 s), so a repository that comes back
(mounted drive, restored path) recovers without a restart.

### 5. Generations

```rust
struct GenerationSet {
    working_tree: u64,  // index + worktree content
    refs: u64,          // branches, tags, remote refs, HEAD
    history: u64,       // reachable commit graph
    stash: u64,
    config: u64,        // remotes, upstreams, user config
}
```

Rules:

- Generations are monotonic `u64`, per repository, in memory only. They are not
  persisted; a restart starts at 0 and every persisted snapshot from a previous
  run is revalidated on first use (see §6).
- A generation is bumped by exactly two sources: a completed local mutation and a
  watcher change set. `RepoChangeSet` maps directly onto the set —
  `status`/`working` → `working_tree`, `refs` → `refs` (+ `history` when the
  change can alter reachability), `stashes` → `stash`.
- A working-tree bump must not bump `refs`, `history`, or `stash`. This is the
  invariant the phase exists to establish, and it is asserted in tests.
- Generations are exposed to the frontend on the existing
  `fjord-repository-changed` event and on every read response envelope, so the
  frontend can decide whether a cached value is still valid without a second
  round trip.

Ordering hazard: a value computed at generation *N* may be stored after a bump to
*N+1*. Cache writes therefore compare-and-swap on the generation captured **before**
the computation started and drop the result if it lost the race.

### 6. Snapshot-first repository switching

A **repository snapshot** is the minimum set needed to paint the primary view:
current branch, ahead/behind/dirty counts, conflict flag, branch and tag lists,
the first history page, and the working-changes summary.

Persistence: a new `repo_snapshot` table (`fjord-db`), one row per repository,
storing a versioned serialized snapshot plus `captured_at` and the schema version.
It is a cache in the same sense as `repo_status_cache` — droppable at any time,
never a source of truth, never consulted for a mutation decision.

Switch flow:

```text
select repository
  ├── snapshot present and schema-compatible
  │     ├── paint immediately from the snapshot, marked "as of <captured_at>"
  │     └── revalidate in background → on difference, patch the view in place
  └── no snapshot
        └── paint the shell + skeletons, stream in values as they resolve
```

Rules that keep this honest:

- The staleness marker is visible whenever displayed data is unvalidated, and
  disappears on validation. A user must never be unable to tell a stale view from
  a live one.
- Mutating actions (commit, checkout, push, discard) are **disabled** against an
  unvalidated snapshot for the fields they depend on, or force validation first.
  Fjord may never issue a destructive Git operation based on stale state.
- Snapshots are written on repository deactivation and on generation-quiescence
  (2 s after the last bump), not on every change.

### 7. Hot / Warm / Cold tiers

| Tier | Definition | Runtime | Watcher | Caches |
|---|---|---|---|---|
| Hot | The active repository, plus the last 2 visited | Open handles, all caches | Full recursive watch | In memory + snapshot |
| Warm | Repositories in the active workspace | Open handles, status + refs caches | Full recursive watch | In memory + snapshot |
| Cold | Everything else tracked | No handles | `.git`-only watch (HEAD, refs, index) | Snapshot only |

Promotion is on access; demotion is by an idle timer plus a budget
(`max_hot = 3`, `max_warm = 32`, both configurable). Eviction drops handles and
in-memory caches but never the persisted snapshot.

The cold-tier `.git`-only watch is the mechanism that makes `ws-100` viable: a
recursive working-tree watch over 100 repositories is what SLO-13 and SLO-14 are
most at risk from, and it buys nothing for a repository the user is not looking at.

### 8. Startup fast path

Target order:

1. Create the window and render the shell **synchronously** — no `await` before
   the first `createRoot().render()`.
2. Render workspace/repository lists from the persisted snapshot cache.
3. Resolve locale and theme; apply without a full remount. The current
   "await settings, then render" ordering exists to avoid a flash of the wrong
   language: keep that guarantee by rendering the shell with text hidden behind a
   `lang-pending` state for the (sub-frame) duration, not by blocking the paint.
4. Start Git work — status refresh, watchers, runtime creation — only after the
   first paint, prioritized by tier.

No Git operation, no watcher registration, and no full workspace status refresh
may run before the first usable paint. Bootstrap already avoids panics
(`P4-02`); this adds an ordering requirement on top.

### 9. Bounded transport for large payloads

`get_file_diff` gains a window: `{ repo_id, path, source, offset, limit }` →
`{ hunks, total_hunks, total_lines, truncated, next_offset }`. The frontend
virtualizer requests windows as it scrolls, exactly as the commit log already
does. A hard per-response ceiling (default 2 MB serialized) applies to every diff
response; exceeding it is reported as a typed condition
(`diff_window_too_large`), never as a silent truncation.

Additional ceilings:
- files above a configurable size (default 10 MB) return a `too_large` marker
  with counts instead of content, plus an explicit "load anyway" action;
- binary detection short-circuits before any content is read.

### 10. Performance CI

Two stages:

1. **Reporting (P6-18).** The scheduled workflow emits JSON per scenario, appends
   to a results file stored as a workflow artifact and in
   [`../benchmarks/`](../benchmarks/), and a PR comment shows the delta against
   the last recorded baseline on the same runner class. Nothing fails yet.
2. **Gating (P6-19).** Once a scenario has three consecutive stable baselines, its
   SLO becomes a gate with an explicit tolerance (default: fail above
   `budget`, warn above `0.8 × budget`). Gates run on the scheduled workflow and
   on demand, not on every PR, because the heavy fixtures cost more than a PR's
   CI budget allows.

## Alternatives considered

**Repository state: recompute per call (status quo) vs. `RepositoryRuntime`.**
Recomputing is simpler and has no cache-coherence risk, and it is genuinely fine
at 24 small repositories. It fails at the target workloads: repository open plus
index/refs parsing repeats on every one of the five reads a single view issues.
The runtime is chosen because the alternative fix — caching at the service layer —
would put Git-specific validity rules (index mtime, refs generation) into
`fjord-services`, breaking the dependency rule in SDD §5.1.

**Invalidation: one repository-wide epoch vs. per-domain generations.**
A single epoch is trivial to implement and impossible to get wrong. It also means
that saving a file invalidates the branch list and the commit graph — precisely
the behavior this phase exists to remove, and the dominant cost on `wt-noisy`.
Per-domain generations are chosen; the extra risk (a missed bump showing stale
data) is contained by the rule that every mutation bumps explicitly and by
contract tests per mutation.

**Snapshot storage: SQLite table vs. frontend `localStorage` vs. TanStack Query
persistence.** `localStorage` is synchronous on the UI thread and bounded at a few
MB; query persistence would make the frontend the owner of correctness rules about
staleness, which contradicts SDD §4 ("the Rust core is the source of truth").
SQLite is chosen: the backend already owns `repo_status_cache`, the write path is
async, and one durable store is easier to version and to drop wholesale.

**Telemetry: OpenTelemetry vs. a purpose-built interaction trace.** OTel gives
standard tooling but pulls a collector-shaped dependency into a desktop app whose
traces must never leave the machine, and its browser SDK cost lands on the hot
render path. The purpose-built trace is chosen because the required output is a
seven-phase breakdown of one interaction, not distributed tracing.

**Diff transport: window vs. compress vs. stream over an event channel.**
Compression reduces bytes but not the cost of materializing the whole diff in
Rust and in JS. An event channel duplicates the paging logic that `log` already
proves works. Windowed request/response is chosen for symmetry with the existing
history paging contract.

## Performance considerations

Every mechanism here is itself on a hot path and is budgeted:

- Interaction tracing adds one string argument per IPC call and a bounded ring
  buffer. Overhead budget: < 1% of a traced interaction's duration, and zero
  allocation on the render path when diagnostics are off. This is verified by a
  benchmark comparing traced and untraced runs.
- Generation checks are two atomic loads per cached read.
- Snapshot writes are debounced and run off the interaction path; a snapshot write
  may never block a user action.
- The runtime registry holds open file handles. `max_hot`/`max_warm` exist to keep
  handle counts bounded — an important limit on Windows, where an open handle in a
  working tree can block another process's rename.
- Cold-tier `.git`-only watches replace recursive watches; the expected effect on
  SLO-13/SLO-14 at `ws-100` is the largest single win in this phase and must be
  measured before and after.

## Security / safety

- Traces, benchmark output, and diagnostics carry no file contents, no diff
  bodies, no repository paths, no branch names — consistent with SDD §10.
- The snapshot cache is not a decision input for mutations (§6).
- Fixtures are generated under `target/` only; the generator refuses to write into
  a directory that is not empty and lacks its own marker file (the existing
  `.fjord-synthetic-repo` guard is kept and extended to the manifest).
- Runtime eviction must release handles deterministically; a leaked `gix` or
  `git2` handle on Windows is a user-visible file-locking bug, so eviction is
  covered by an explicit test that asserts the working tree can be renamed after
  eviction.
- Performance diagnostics are opt-in and their IPC command returns nothing when
  the flag is off.

## Testing strategy

| Level | Coverage |
|---|---|
| Unit (Rust) | Generation bump rules per mutation; compare-and-swap on stale cache writes; tier promotion/demotion; snapshot serialization round-trip and version rejection; diff window arithmetic and ceilings. |
| Integration (Rust) | Runtime reuse across repeated reads (assert one open, N reads); watcher event → correct generations only; eviction releases handles (rename the working tree afterwards); snapshot revalidation detects an out-of-band change made by a plain `git` command. |
| Frontend/component | Snapshot-first render shows stale marker and clears it on validation; mutating actions disabled while unvalidated; diff windowing requests the next window on scroll and stops at `truncated`. |
| E2E | Scripted interaction driver measures SLO-1–SLO-5 and SLO-9–SLO-12 against the fixture catalogue and emits traces. |
| OS-specific / manual | `win-fs` scenario on Windows; idle CPU and memory sampling on all three OSes; handle-release check on Windows. |
| Benchmark / regression | Every fixture × its owning SLO, JSON output, baseline comparison, gates per §10. |

## Acceptance criteria

1. `docs/specs/performance.md` SLO table has, for every row, a named scenario, a
   measurement method, and either a measured baseline or an explicit *provisional*
   marker; no roadmap task references an SLO that lacks a scenario.
2. `fjord-bench` can generate every fixture in §2 from parameters, skips
   regeneration when the manifest matches, and refuses to overwrite an unmarked
   directory.
3. `fjord-bench` emits machine-readable JSON containing scenario name, OS, CPU
   model, profile, fixture manifest hash, and per-metric values.
4. For a traced interaction, the recorded trace contains all seven phases of §3
   and the sum of phase durations is within 5% of the wall-clock duration measured
   independently.
5. Opening a repository, reading `status`, `branches`, `log` page 1, and
   `working_changes` in sequence opens the repository handle exactly once
   (asserted by an integration test counting opens).
6. Writing a file in the working tree bumps `working_tree` and leaves `refs`,
   `history`, and `stash` generations unchanged; creating a branch bumps `refs`
   without bumping `working_tree`. Both asserted by tests.
7. Switching to a repository with a valid cached snapshot renders its primary view
   without waiting for a fresh Git status computation, and shows a staleness
   marker until validation completes.
8. A commit action is unavailable, or forces validation, while the working-changes
   portion of the displayed state is unvalidated.
9. The first paint occurs before any Git operation, watcher registration, or
   workspace status refresh is issued (asserted by an ordered startup trace).
10. Requesting a diff of the `diff-giant` fixture returns a bounded first window
    within SLO-10 and never a response above the serialized ceiling; the file above
    the size limit returns `too_large` with counts and no content.
11. At `ws-100` idle, exactly the hot and warm tiers hold recursive watches; cold
    repositories hold `.git`-only watches, verified by a runtime assertion in the
    harness.
12. The scheduled benchmark workflow publishes a JSON result set and a delta
    against the previous baseline for every scenario; gated scenarios fail the run
    when above budget.
