# Fjord — Software Design Document

Status: v0.4.1 (2026-08 Phase 6/7 review-fix audit; supersedes v0.4)
Owner: msochnev

This document covers the *why* — vision, architecture, and the decisions behind them — and, since v0.3, the honest *current state*. For the task-level breakdown and progress, see:

- [`tasks.md`](tasks.md) — the task board (stable IDs `P0-01`, `P1-03`, ...) with per-task status. It replaces the former `plan.md`.
- [`specs/`](specs/) — focused technical specs per subsystem (Git engine, data model, IPC commands, i18n, theming).
- [`benchmarks/`](benchmarks/) — recorded benchmark checkpoints.

Status markers used throughout this document:

- ✅ — implemented and verified in the codebase.
- ⚠️ — partially implemented, or the implementation diverges from the target described here.
- 🚧 — planned / designed but not implemented yet.

**Implementation snapshot (2026-08):** Phases 0–4 are implemented. Phase 5
replaces libgit2 network transport with the installed system Git (implementation
complete; manual sign-off and a small residual list remain — see §5.2 and
[`tasks.md`](tasks.md)). Phase 6 implementation is complete except for `P6-20`
(promotion of stable report-only baselines to gates), and Phase 7 plus its review
fixes are complete. Phases 8–11 remain designed; their contracts live in
[`specs/`](specs/) and their goals in §15.

## 1. Vision

Fjord is an open-source, cross-platform Git **workspace manager** — not a single-repo Git GUI, but a control center for many repositories at once. Users group repositories into Workspaces (Backend, Frontend, Infrastructure, ...), see unified status across all of them, run bulk operations, and drill into any single repository for a full history/graph/diff view comparable to GitKraken.

Design language: minimalist, premium, in the spirit of Linear / Raycast / Arc Browser. Native-feeling desktop app, not a wrapped website.

## 2. Goals

- **G1 — Multi-repo workspace management**: group, monitor, and bulk-operate on many repositories. ✅
- **G2 — Single-repo deep view**: branches, commit graph, diffs, history — on par with dedicated Git GUIs. ✅
- **G3 — Internationalization (i18n)**: ship with English and Russian, switchable at runtime, and structured so a third locale is a content-only addition (no code changes). ✅
- **G4 — Theming**: light / dark / system, defaulting to system, switchable at runtime without restart. ✅
- **G5 — Clean Architecture**: strict dependency direction, framework-agnostic domain/use-case core, swappable infrastructure (git engine, database, IPC transport). ✅
- **G6 — Performance at scale**: stays fast on large monorepos and workspaces containing dozens of repositories. ⚠️ Phase 6 implemented SLOs, torture fixtures up to 1M commits / 300k-file definitions / 100 repositories, a long-lived tiered runtime, bounded diff/history transport, generation invalidation, and release measurements. Packaged WebView end-to-end baselines and promotion of stable CI reports to failing gates remain `P11-01`/`P6-20` ([`specs/performance.md`](specs/performance.md)).
- **G7 — Cross-platform parity**: first-class, equally fast experience on Windows, macOS, and Linux. ✅ CI verifies all three targets (§5.4)

## 3. Non-goals (for v1)

- Hosting/forge features (issues, PRs as a first-class object model) — Fjord reads PR status where cheap to fetch, but is not a forge client.
- Built-in merge/diff editor competing with dedicated tools — Fjord shells out to the user's configured merge tool for conflict resolution in v1.
- Mobile clients.

## 4. High-level architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Tauri v2 shell                        │
│  ┌───────────────────────────┐   ┌───────────────────────┐  │
│  │        Frontend (WebView)  │   │   Rust backend (core)  │  │
│  │  React + TS + Vite         │◄─►│  commands → services   │  │
│  │  presentation / app state  │IPC│  → ports →             │  │
│  │  i18n, theming             │   │    adapters (git/db/fs)│  │
│  └───────────────────────────┘   └───────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

Both sides follow the same Clean Architecture dependency rule independently — the Rust core is the source of truth for domain logic; the frontend is a (fairly thin) presentation layer over Tauri IPC, not a second place where business rules live.

## 5. Backend architecture (Rust)

### 5.1 Layering and the dependency rule ✅

```
commands        (Tauri command handlers — thin adapters, no logic)
   │  depends on
services        (use-cases / application logic — orchestrates ports)
   │  depends on
ports           (traits describing what the app needs — Git, DB, FS, IDE-launcher)
   │  implemented by
adapters        (sqlx+SQLite, gix/git2, notify, process spawning)
```

Dependency rule: inner layers never import outer layers. `services` depends on **port traits**, not on `gix`, `sqlx`, or `tauri` types directly. This is what makes the git engine and the database swappable, and what makes `services` unit-testable with in-memory fakes.

Implemented as a Cargo workspace — the layering is a compile-time boundary checked by `cargo`, not a folder-naming convention:

```
fjord/
  crates/
    fjord-domain/     # entities + value objects (Workspace, RepositoryEntry, RepoStatus, ...), zero deps beyond std/serde
    fjord-ports/      # trait definitions: GitBackend, WorkspaceStore, SettingsStore, IdeLauncher
    fjord-services/   # use-cases (WorkspaceService, RepoService, SettingsService), depends only on domain + ports
    fjord-git/        # local gix/git2 backend + system-Git remote backend
    fjord-db/         # sqlx + SQLite migrations, implements *Store traits
    fjord-fs/         # filesystem watching (notify), path/case-sensitivity helpers
    fjord-app/        # Tauri commands, DI wiring, per-OS IdeLauncher impls — the only crate depending on `tauri`
    fjord-askpass/    # minimal one-shot credential prompt sidecar; no Tauri or storage
    fjord-bench/      # benchmark harness: synthetic repo/workspace generator + timed scenarios
  src-tauri/          # thin Tauri entrypoint, re-exports fjord-app
```

`fjord-domain` and `fjord-services` have no knowledge that Tauri, SQLite, or gix exist. Identifiers use the NewType pattern (`WorkspaceId`, `RepositoryId`) so IDs of different entities cannot be confused at compile time.

### 5.2 Git engine: local engines plus system Git transport ✅

- **[`gix`](https://github.com/GitoxideLabs/gitoxide)** (gitoxide) is a pure-Rust, memory-safe Git implementation. Its read paths — status, diff, commit-graph traversal, index access — are fast and are exactly the hot paths for a *workspace manager* (computing "24 repos, 3 need attention" means running status across every repo, repeatedly, cheaply). No C dependency; cross-compiles cleanly.
- Its gaps as of today: push, full merge workflows, rebase, and hooks are still maturing.
- **[`git2`](https://github.com/rust-lang/git2-rs)** (libgit2 bindings) owns
  working-tree/index mutations and integration after fetch.
- The user's **installed Git** owns all network transport so Fjord honors existing
  credential helpers, GCM, SSH agent/configuration, proxies, and certificates.

This is the same hybrid GitButler (the closest prior art: also Rust + Tauri) has converged on, with the balance shifting toward gix over time.

Target design: `GitBackend` expresses local operations, `GitRemoteBackend`
expresses remote operations, and `GitEnvironmentProvider` expresses discovery and
read-only diagnostics. **gix serves hot reads**, **git2 serves local mutations and
merge/fast-forward**, and **system Git serves fetch/push/remote inspection**.
`pull` remains system fetch followed by local integration, preserving Fjord's
existing semantics regardless of user `pull.rebase` configuration. Details and
security constraints are in
[`specs/system-git-transport.md`](specs/system-git-transport.md).

Remote commands use an async streaming runner with process-tree cancellation,
stable error codes, bounded/redacted diagnostics, and operation-scoped askpass.
The local port has no transport methods, so libgit2 cannot become a hidden
network fallback. Git environment and connection diagnostics are exposed in
Settings without changing global configuration or storing credentials.

Concurrency inside the adapter: all blocking git work runs under `tokio::task::spawn_blocking`; a per-repository `RwLock` (keyed by canonicalized path) allows parallel reads of the same repo while serializing writes.

### 5.3 Performance strategy for large repositories and large workspaces

Two different performance problems, both real: (1) one huge repo — big working tree, deep history; (2) many repos at once — 24+ repositories, each needing a status check on every workspace refresh.

Approach, item by item:

- ✅ **Incremental status, not full rescans.** `fjord-fs` watches Hot/Warm working trees recursively and Cold repositories through `.git` metadata only. Events under generated directories (`target/`, `node_modules`, ...) and the `.git` object store are filtered out, and bursts are debounced inside the watcher (300 ms quiet window, 5 s max delay) (`P4-15`, `P6-17`). A single-concurrency round-robin status check reconciles one Cold repository every five seconds so ordinary worktree edits cannot remain silently stale (`P7-FIX-02`). A second debounce layer in `WorkspaceService` coalesces watcher refresh scheduling.
- ✅ **A status/summary cache in SQLite.** The dashboard reads from `repo_status_cache`, refreshed asynchronously per-repo; the read path is a single `LEFT JOIN` (no N+1). The UI always shows "status as of last refresh, refreshing in background" rather than blocking on the slowest repo.
- ✅ **Bulk operations run concurrently**, bounded by a worker pool (Tokio `Semaphore` + `JoinSet`, currently 6 concurrent) — "Pull all" on 24 repos takes roughly as long as the slowest one, not the sum.
- ✅ **gix for the hot read paths** (status, diff, log) — avoids libgit2's process-wide locking and is competitive-to-faster on large trees.
- ✅ **Commit graph is paginated/lazy** on the backend: `log(repo, cursor, limit)` with a "Load earlier commits" affordance in the UI.
- ✅ **Frontend list virtualization** via `@tanstack/react-virtual` for lists that scale with repo/commit count (`P4-08`). The commit graph, all-repositories list, and dashboard repo-card grid only mount visible rows plus overscan; SVG graph edges are drawn only for virtualized commit rows within/near the viewport.
- ✅ **Global search** fans out across repositories through the same bounded worker pool as bulk operations, preserving deterministic result order before the global limit cut (`P4-13`); `fjord-bench --workspace-repos N` reports `global_search_ms`.

Phase 6 implementation and remaining limits
([`specs/performance.md`](specs/performance.md)):

- ✅ **Tiered long-lived repository state.** Hot/Warm repositories reuse one
  `RepositoryRuntime`; Cold repositories retain no Git handles and use
  metadata-only watches. Eviction preserves generation clocks (`P6-11`, `P6-17`).
- ✅ **Generation-scoped invalidation.** Reads and filesystem events share
  monotonic per-domain generations, so cached values can be validated precisely
  (`P6-12`, `P6-13`).
- ⚠️ **End-to-end tracing exists; scenario baselines do not yet.** Opt-in
  interaction traces now correlate input, IPC, backend handler spans, React
  commit, and paint (`P6-08`/`P6-09`), but the scripted SLO scenarios have not
  yet produced publishable action-to-paint baselines.
- ✅ **Bounded diff transport.** `get_file_diff` and working-file diff return
  windows of at most 2,000 lines under a 2 MB response ceiling; the UI fetches
  1,000-line windows near the virtualized end. Files above 10 MB return metadata
  without content. Packed `diff-giant` first response P95 is 34.592 ms (`P6-16`).
- ✅ **Startup shell precedes IPC.** Locale/settings resolution and all Git or
  watcher work start after the first usable paint (`P6-10`).

Measured numbers and budgets: see §11.

### 5.4 Cross-platform strategy (Windows / macOS / Linux)

- ✅ **Filesystem semantics differ** (case sensitivity, separators, symlinks). All path handling goes through `fjord-fs` rather than ad hoc `std::path` use scattered through services.
- ✅ **File watching** via `notify` (FSEvents / ReadDirectoryChangesW / inotify behind one API) — no per-OS branches in application code.
- ✅ **External process integration** ("Open in IDE", "Open terminal here", merge tool) lives behind the `IdeLauncher` port, with per-OS resolution in `fjord-app`. `services` issues a single `open_in_ide(repo)` call and never branches on target OS. ⚠️ Security caveats of the current implementation: see §9.
- ✅ **Window chrome**: native decorations per platform; custom title bar only where it earns its keep.
- ✅ **CI builds and tests on all three targets** (`P0-09`): `.github/workflows/ci.yml` runs `cargo fmt`/`clippy -D warnings`/`cargo test --workspace` on a Windows/macOS/Linux matrix, plus a frontend job (`tsc` + Vite build, `vitest`, i18n catalog check).

## 6. Frontend architecture (React + TypeScript)

### 6.1 Layering

```
presentation/     UI components — "dumb", receive data + callbacks as props
application/      hooks, view-state, data fetching, orchestration
domain/           TS types mirroring the Rust domain
infrastructure/   Tauri IPC client, i18n runtime, theme runtime
```

- ✅ The four layers exist and the dependency direction is respected; all IPC goes through the typed client in `infrastructure/tauriClient.ts`.
- ✅ **Data fetching**: TanStack Query wraps Tauri IPC in the `application/` hooks (`P4-07`). Queries are keyed by workspace/repo scope, commit history uses `useInfiniteQuery`, workspace mutations use `useMutation`, and repository/workspace mutations invalidate the affected query keys instead of relying on remounts or manual cancellation flags.
- ✅ **Domain types**: TypeScript domain declarations are generated from `fjord-domain` with `ts-rs` (`P4-11`). The committed source of truth is `src/domain/generated.ts`, the public `src/domain/*` modules re-export those generated types, and the `fjord-domain` `export_types` test fails if the generated file drifts from Rust.
- ✅ **Component size**: `App.tsx` now stays at the shell/orchestration layer (`P4-12`): command palette state/search lives in `useCommandPaletteState`, repo detail action/selection state lives in `RepoDetailContainer`, and the shell passes a narrow route command into the detail view instead of owning the 15+ prop bundle.
- ✅ **Error boundaries**: a global boundary wraps `App` in `main.tsx` and a per-view boundary (keyed by the active view, so navigation resets it) wraps the main pane — an unhandled render exception shows a localized fallback with retry/reload instead of blanking the window (`P4-10`).

### 6.2 Internationalization

- ✅ Library: `react-i18next`. Catalogs: one JSON file per locale per namespace under `src/locales/`. Two namespaces (`common`, `workspace`) — the spec's finer split (`repo`, `settings`) can be introduced when catalogs grow. Five locales ship today: `en`, `ru`, `de`, `es`, `fr`.
- ✅ **Adding a locale is a content-only change**: drop a new `locales/<code>/*.json` set and register it in the locale registry. No component code changes.
- ✅ **Fallback chain**: selected locale → English → raw key. Never a blank label.
- ✅ **Locale detection**: OS locale on first launch if supported, else English; user override persisted through `SettingsStore`, applied instantly without restart.
- ✅ Russian plural forms are handled correctly via i18next plural suffixes.
- **Preserving technical terms** («не затирать технические термины»):
  1. ✅ A **glossary file** (`src/locales/en/glossary.md`) listing Git vocabulary that stays untranslated or uses one fixed rendering (`commit`, `rebase`, `stash` stay Latin; `branch` → «ветка»). Written as part of `P4-16`.
  2. ✅ Terms inside translated sentences are interpolated as variables (`t('mergedInto', { branch })`) — branch names, SHAs, and command names are never mangled by translation.
- ✅ **CI check**: `scripts/check-i18n.ts` diffs every non-English catalog's key set against `en/*.json` (plural suffixes normalized) and exits non-zero on missing/orphaned keys — run via `npm run check-i18n` locally and in the CI frontend job (`P4-16`).

### 6.3 Theming ✅

- Tokens as CSS custom properties (`--surface-*`, `--text-*`, `--border`, `--fjord` accent, semantic `--moss/--amber/--rust`).
- Three modes: **Light / Dark / System**, default **System**.
- Implementation: `ThemeProvider` resolves the effective mode (`system` → `matchMedia('(prefers-color-scheme: dark)')` plus Tauri's native window theme-change event, so window chrome and WebView content change together), sets `data-theme` on `<html>`, and persists the user's *choice* (not the resolved value) via `SettingsStore`.
- Switching is instant (CSS variable swap, no reload).

## 7. Core data model ✅

Actual schema (see `crates/fjord-db/migrations/0001_init.sql` and [`specs/data-model.md`](specs/data-model.md)):

```
settings          { id = 1, locale, theme, default_ide, auto_fetch,
                    performance_diagnostics, git_executable_path, updated_at } -- single row
workspaces        { id, name, sort_order, created_at }
repositories      { id, workspace_id → workspaces, name, path, sort_order, created_at,
                    UNIQUE (workspace_id, path) }
repo_status_cache { repo_id → repositories, branch, ahead, behind, dirty_count,
                    has_conflict, last_synced_at }
```

`repo_status_cache` is a cache, not a source of truth — it's always safe to drop and rebuild from the repositories themselves; this is what keeps "fast dashboard" and "correct dashboard" from being in tension.

Earlier drafts listed `remote_url` and `ide_hint` columns on `repositories`; they were not needed by any shipped feature and are **not** in the schema. Add them via a forward-only migration if and when a feature requires them.

## 8. Cross-cutting concerns

- ✅ **Errors**: `thiserror` typed errors per crate (`GitError`, `StoreError`, service-level enums), mapped at the `commands` boundary to a small serializable `AppError { code, message }` — the frontend switches on `code` (stable, localizable) and never parses Rust `Display` strings. Error *messages* shown to the user go through the i18n catalog.
- ✅ **Async runtime**: Tokio throughout the backend; blocking local git work is wrapped in `spawn_blocking`, while system-Git transport uses `tokio::process`. Long-running Git operations (`fetch`/`pull`/`push`) and workspace bulk operations emit `fjord-operation-progress` Tauri events, take caller-generated operation IDs, and can be cancelled through `cancel_operation`; cancellation terminates the process tree. See [`specs/operation-events.md`](specs/operation-events.md).
- ✅ **Logging/tracing**: `tracing` + a daily-rotating file appender in the app data dir so bug reports can include real diagnostics (`P4-14`). See §10.
- **Testing** (current state; gaps tracked in `P4-09`):
  - ✅ `fjord-domain` / `fjord-services`: unit tests with in-memory fakes of the port traits — no real Git or SQLite needed.
  - ✅ `fjord-git`: integration tests against real fixture repositories (including this repository itself as the cheapest fixture).
  - ✅ `fjord-db`: store tests against a real SQLite database.
  - ✅ Frontend: unit tests for the pure algorithmic parts (`fileTree`, `graphLayout`) under `vitest`.
  - ✅ Frontend component/hook tests: React Testing Library under jsdom, including `useRepositories` tests with the IPC boundary mocked at `infrastructure/` (`P4-09`).
  - ✅ `fjord-app`: the command layer's wiring — `state::compose_services` on real adapters against a temporary database and fixture repositories, asserting the stable `AppError` codes (`P5-22`). Tauri's own IPC serialization is not exercised, because `AppState` holds an `AppHandle` that needs a runtime; handlers are thin adapters and the boundary is covered from the frontend side.
  - 🚧 Missing: `IdeLauncher` tests on real paths.
  - ✅ All of the above run in CI on every push/PR (`P0-09`, see §5.4).

## 9. Security

Threat model in one line: the WebView renders only local data (no remote content), so the main risks are (a) a compromised/renegade WebView reaching powerful IPC commands, and (b) the app spawning external processes based on user-controlled settings.

- ✅ **Content Security Policy**: `tauri.conf.json` sets a strict CSP (self-only sources; `style-src 'unsafe-inline'` is required by React inline styles; a slightly looser `devCsp` allows the Vite dev server and HMR websocket) so a markup-injection bug cannot escalate to IPC access (`P4-01`).
- ✅ **Tauri capabilities**: `src-tauri/capabilities/default.json` grants only the core defaults plus the dialog/opener plugin permissions the app actually uses; no broad filesystem or shell capabilities are exposed to the WebView.
- ✅ **External process launching** (`fjord-app/src/ide_launcher.rs`): the `ide` string from settings/IPC only launches commands from an explicit allowlist of known IDE CLIs; the custom-editor escape hatch requires the deliberate `custom:<command>` form and an unrecognized bare value is rejected with `ide_not_allowed`. The Unix availability check walks `PATH` directly instead of interpolating into `sh -c` (`P4-04`).
- ✅ **Startup robustness**: bootstrap failures (app data dir resolution, DB open) surface a blocking error dialog and a non-zero exit code instead of a panic (`P4-02`).
- ✅ **Input validation**: repository paths from IPC are canonicalized and checked for being actual Git repositories before use; IDs are opaque NewTypes generated backend-side.
- ✅ **Credential handling**: Fjord delegates to system Git/GCM/SSH first and stores no credentials. The fallback askpass broker is loopback-only with expiring operation tokens and one-use prompt IDs; secrets never enter arguments, storage, tracing, or retained frontend state.

## 10. Observability

Implemented in `fjord-app/src/logging.rs` (`P4-14`):

- ✅ `tracing-subscriber` with an env-filter — default `info`, `debug` for `fjord_*` crates in dev builds, overridable via `RUST_LOG`.
- ✅ A daily-rotating file appender (`tracing-appender`) writing to `<app data dir>/logs/fjord.*.log`; retention of the 5 most recent files. Initialized before state bootstrap so startup failures leave a trace on disk; a logging failure never blocks the app itself.
- ✅ Log lines never include file *contents* or diff bodies — paths, repo names, and timings only (logs may be attached to public bug reports).
- ✅ Opt-in interaction diagnostics keep the latest 512 traces in memory and expose a draining IPC command. Trace records are stricter than logs: ids, phase/operation names, durations, and counts only; disabling the setting clears the buffer (`P6-08`).
- ✅ Settings exposes the application-owned rotating-log directory through the native OS folder viewer (`P7-15`).

## 11. Non-functional requirements and benchmarks

The full SLO catalogue, measurement methodology, fixture set, and gating policy
live in [`specs/performance.md`](specs/performance.md) (Phase 6). The budgets
below are the subset that is measured and enforced today; they remain valid and
are absorbed as the small-scale anchors of the SLO table.

Performance budgets (targets, measured on **release** builds; enforced by the scheduled/manual release benchmark workflow from `P4-18`):

| Scenario | Budget |
|---|---|
| Dashboard read from cache, 24 repos | < 5 ms |
| Full uncached status refresh, 24 repos (parallel) | < 1 s wall-clock |
| `log` page (200 commits) on a 100k-commit repo | < 150 ms |
| Commit-graph interaction (select/scroll) at 1k loaded commits | no dropped frames (< 16 ms/frame) |

Measured checkpoints so far (recorded in [`benchmarks/`](benchmarks/)):

- [`p1-09.md`](benchmarks/p1-09.md) — single-repo open/status/log against synthetic fixtures (e.g. status ≈ 69 ms at 1 000 commits, dev profile).
- [`p2-07.md`](benchmarks/p2-07.md) — dashboard refresh on a 24-repo synthetic workspace (cached read ≈ 0.5 ms; parallel uncached refresh bounded by the slowest repo).
- [`p4-18-release.md`](benchmarks/p4-18-release.md) — release-profile budget checkpoint: 50k-commit single-repo log page ≈ 9.7 ms; 24-repo/60k-total-commit workspace live refresh ≈ 62 ms and cached dashboard read ≈ 0.1 ms.

Release benchmark regression checks run weekly and on demand through `.github/workflows/benchmarks.yml`.

## 12. Implementation status

High-level snapshot; the authoritative per-task list is [`tasks.md`](tasks.md).

| Area | Status |
|---|---|
| Phase 0 — Foundation (workspace scaffold, ports, git/db adapters, shell, theming, i18n, IPC pattern, bench harness, CI) | ✅ done |
| Phase 1 — Single-repo core (branches, graph, inspector, diff, mutations, push, conflicts, benchmark) | ✅ done |
| Phase 2 — Workspace layer (CRUD, status cache, dashboard, list-detail, bulk ops, IDE launcher, benchmark) | ✅ done |
| Phase 3 — Polish and release | ✅ done through release readiness: palette (`P3-01`), global search (`P3-02`), packaging/update pipeline (`P3-03`), onboarding (`P3-04`), contributor docs and public release checklist (`P3-05`) |
| Phase 4 — Hardening & tech debt (2026-08 audit) | ✅ done |
| Phase 5 — System Git transport and authentication | ⚠️ implementation complete; residual stabilization items and manual provider/OS sign-off open ([`manual-git-compatibility.md`](manual-git-compatibility.md)) |
| Phase 6 — Performance foundation | ⚠️ implementation complete through `P6-22`; only report-to-gate promotion `P6-20` remains ([`specs/performance.md`](specs/performance.md)) |
| Phase 7 — UI/UX shell | ✅ done (`P7-01`–`P7-16`, `P7-FIX-01`–`P7-FIX-06`; [`specs/ui-shell.md`](specs/ui-shell.md)) |
| Phase 8 — Daily-driver essentials | 🚧 underway: destructive-preflight foundation `P8-00` and patch model/generation foundation `P8-01` complete; patch application, UI, amend, push, and diff tasks remain ([`specs/working-tree-and-diff.md`](specs/working-tree-and-diff.md)) |
| Phase 9 — Safety & recovery | 🚧 designed ([`specs/repository-safety.md`](specs/repository-safety.md)) |
| Phase 10 — Advanced workflows & workspace | 🚧 designed ([`specs/workspace-workflows.md`](specs/workspace-workflows.md)) |
| Phase 11 — Extreme performance & release hardening | 🚧 designed ([`specs/release-hardening.md`](specs/release-hardening.md)) |

Between `P4-18` and `P5-01`, and again after `P5-19`, a substantial amount of UI
and frontend-performance work landed without task IDs: the resizable repository
layout, the branch/tag tree with context menus, the working-changes panel,
commit-graph search and infinite scroll, the off-thread graph layout worker, list
virtualization refinements, the repository-change event pipeline, and three
additional locales. `P5-24` recorded it as `P4-19`–`P4-32`, at subsystem
granularity with the tests that cover each; the subsystems that turned out to
have no coverage are filed as `P5-26` rather than counted as done.

Known divergences between this document and the code are marked ⚠️/🚧 inline in their sections (performance limits §5.3, i18n locale count §6.2, logging §10, benchmarks §11).

## 13. Risks and open questions

| Risk | Mitigation |
|---|---|
| `gix` mutation support matures slower than expected | `GitBackend` isolates local engines; network transport remains system Git regardless of local engine choices. |
| Platform-specific and locale regressions | CI matrix on all three OSes plus the i18n catalog check run on every push (`P0-09`, `P4-16`); release benchmarks run weekly/on demand (`P4-18`) |
| Generated TS domain types drift from Rust domain | `cargo test --workspace` includes the `fjord-domain` export drift check (`P4-11`) |
| Large-monorepo performance is partly a claim | Phase 6 provides SLOs and measured backend baselines across the torture catalogue, including 1M-commit history and a 100-repository workspace. Packaged WebView action-to-paint and full-process resource baselines remain explicit Phase 11 owners, and `P6-20` has not promoted report-only results to gates ([`specs/performance.md`](specs/performance.md)). |
| `RepositoryRuntime` caches serve stale data | Per-domain generations with compare-and-swap cache writes, contract tests per mutation, and the rule that no destructive action runs against an unvalidated snapshot ([`specs/performance.md`](specs/performance.md) §5–6) |
| Partial staging corrupts uncommitted work | Patches are applied by `git apply`, never by a hand-written index writer, and every selection is verified against a freshly recomputed diff digest (`patch_stale`) before it is applied ([`specs/working-tree-and-diff.md`](specs/working-tree-and-diff.md) §1) |
| Recovery is presented as more than it is | The Recovery Center is explicitly reflog-based and states what it cannot recover; recoverability labels in destructive preflights are contractual and asserted in tests ([`specs/repository-safety.md`](specs/repository-safety.md) §3, §5) |
| Roadmap scope creep toward forge/IDE features | §15's admission rule: a feature ships only if it removes a reason to leave Fjord or strengthens speed, safety, or multi-repository workflow |
| SVG commit graph DOM cost on deep histories | Commit rows are virtualized (`P4-08`); re-evaluate a canvas renderer only if profiling still shows SVG edge cost inside the visible window |
| Custom title bar vs. native OS conventions | Default to native decorations per-platform; only override where there's a clear UX win |

## 14. Documentation map

- [`SDD.md`](SDD.md) (this document) — architecture, decisions, current state, roadmap phases (§15).
- [`tasks.md`](tasks.md) — task board with statuses. **Replaces `plan.md`** (removed in v0.3; task IDs referenced from code and commits are unchanged).
- [`specs/`](specs/) — per-subsystem contracts:
  - Implemented: [`git-backend.md`](specs/git-backend.md), [`system-git-transport.md`](specs/system-git-transport.md), [`data-model.md`](specs/data-model.md), [`ipc-commands.md`](specs/ipc-commands.md), [`operation-events.md`](specs/operation-events.md), [`i18n.md`](specs/i18n.md), [`theming.md`](specs/theming.md).
  - Implemented: [`ui-shell.md`](specs/ui-shell.md) (Phase 7).
  - Implemented except for the explicit `P6-20` gate-promotion task: [`performance.md`](specs/performance.md) (Phase 6).
  - Designed: [`working-tree-and-diff.md`](specs/working-tree-and-diff.md) (Phase 8), [`repository-safety.md`](specs/repository-safety.md) (Phase 8 safety foundation + Phase 9), [`workspace-workflows.md`](specs/workspace-workflows.md) (Phase 10), [`release-hardening.md`](specs/release-hardening.md) (Phase 11).
- [`benchmarks/`](benchmarks/) — recorded benchmark checkpoints (`p1-09.md`, `p2-07.md`, `p4-18-release.md`).
- [`manual-git-compatibility.md`](manual-git-compatibility.md), [`release.md`](release.md) — release gates that cannot be automated.

## 15. Roadmap (Phases 5–11)

Each phase has one goal, one owning spec, and a dependency reason for its
position. Tasks live in [`tasks.md`](tasks.md).

| Phase | Goal | Spec | Depends on |
|---|---|---|---|
| 5.x — Final stabilization | Close the residual System-Git transport and authentication work; no new product capability. | [`specs/system-git-transport.md`](specs/system-git-transport.md) | — |
| 6 — Performance foundation | Fjord has a *measurable* performance architecture: SLOs, torture fixtures, end-to-end telemetry, a long-lived repository runtime, generation-scoped invalidation, snapshot-first switching, bounded transport. | [`specs/performance.md`](specs/performance.md) | 5.x |
| 7 — UI/UX shell | Dense, quiet, keyboard-first shell: content over chrome, one utility area, persisted UI state, a real shortcut model. | [`specs/ui-shell.md`](specs/ui-shell.md) | 6 (snapshot-first switching and persisted state share a bootstrap path) |
| 8 — Daily-driver essentials | Starts with `P8-00`, the safety foundation required by Phase 8 destructive actions; then ordinary Git work gains hunk/line staging, amend, safe force push, and a comparable diff. | [`specs/working-tree-and-diff.md`](specs/working-tree-and-diff.md), [`specs/repository-safety.md`](specs/repository-safety.md) §3 | 6 (diff windowing), 7 (diff mode persistence, overflow menu) |
| 9 — Safety & recovery | Extends the already-available preflight foundation with operation states, continue/skip/abort, safe checkout, remaining destructive actions, and reflog recovery. | [`specs/repository-safety.md`](specs/repository-safety.md) | 8 (uses Phase 8 patch/discard semantics; no Phase 8 task depends on Phase 9) |
| 10 — Advanced workflows & workspace | Turn the workspace into the competitive advantage: worktrees, rebase, remotes, workspace health, expected branch, filters. | [`specs/workspace-workflows.md`](specs/workspace-workflows.md) | 9 (rebase and worktree removal depend on operation state and preflights) |
| 11 — Extreme performance & release hardening | Prove the performance architecture in the *shipped artifact*, and make release quality a gate rather than a checklist. | [`specs/release-hardening.md`](specs/release-hardening.md) | 6–10 |

**Admission rule for any new roadmap item.** A feature is added only if it
answers one of two questions: *which reason to leave Fjord does it remove?*, or
*how does it strengthen speed, safety, or multi-repository workflow?* "GitKraken
has it" is not an answer.

**Deliberately out of scope** (revisit only as an explicit proposal, never as a
drive-by addition): GitHub/GitLab pull- and merge-request UI, issues, CI/CD
dashboards, a plugin system, an embedded code editor, a full merge editor, an AI
chat sidebar, and forge-specific functionality generally. Fjord is a Git client,
not a forge client and not an IDE. Narrow AI assistance (explain diff, explain
conflict, summarize commit) is permissible in principle and is not a priority.

**Performance work order**, applied to every task in Phases 6 and 11: measure →
locate the bottleneck → change the architecture → measure again → and only then
optimize allocations and data structures. The stack (Rust, Tauri, React/TypeScript,
`gix`, `git2`, system Git, SQLite, TanStack Query, TanStack Virtual) is the
baseline architecture; replacing any component requires benchmark or profiling
evidence that it is the bottleneck.
