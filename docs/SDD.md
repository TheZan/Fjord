# Fjord — Software Design Document

Status: v0.3 (reworked 2026-08 to match the implemented system; supersedes draft v0.2)
Owner: msochnev

This document covers the *why* — vision, architecture, and the decisions behind them — and, since v0.3, the honest *current state*. For the task-level breakdown and progress, see:

- [`tasks.md`](tasks.md) — the task board (stable IDs `P0-01`, `P1-03`, ...) with per-task status. It replaces the former `plan.md`.
- [`specs/`](specs/) — focused technical specs per subsystem (Git engine, data model, IPC commands, i18n, theming).
- [`benchmarks/`](benchmarks/) — recorded benchmark checkpoints.

Status markers used throughout this document:

- ✅ — implemented and verified in the codebase.
- ⚠️ — partially implemented, or the implementation diverges from the target described here.
- 🚧 — planned / designed but not implemented yet.

**Implementation snapshot (2026-08):** Phases 0–2 are implemented. Phase 3 is partially done (command palette, global search, onboarding). See §12 and [`tasks.md`](tasks.md).

## 1. Vision

Fjord is an open-source, cross-platform Git **workspace manager** — not a single-repo Git GUI, but a control center for many repositories at once. Users group repositories into Workspaces (Backend, Frontend, Infrastructure, ...), see unified status across all of them, run bulk operations, and drill into any single repository for a full history/graph/diff view comparable to GitKraken.

Design language: minimalist, premium, in the spirit of Linear / Raycast / Arc Browser. Native-feeling desktop app, not a wrapped website.

## 2. Goals

- **G1 — Multi-repo workspace management**: group, monitor, and bulk-operate on many repositories. ✅
- **G2 — Single-repo deep view**: branches, commit graph, diffs, history — on par with dedicated Git GUIs. ✅
- **G3 — Internationalization (i18n)**: ship with English and Russian, switchable at runtime, and structured so a third locale is a content-only addition (no code changes). ✅
- **G4 — Theming**: light / dark / system, defaulting to system, switchable at runtime without restart. ✅
- **G5 — Clean Architecture**: strict dependency direction, framework-agnostic domain/use-case core, swappable infrastructure (git engine, database, IPC transport). ✅
- **G6 — Performance at scale**: stays fast on large monorepos (tens of thousands of commits, large working trees) and on workspaces containing dozens of repositories. ⚠️ backend caching/concurrency in place; frontend virtualization missing (§5.3)
- **G7 — Cross-platform parity**: first-class, equally fast experience on Windows, macOS, and Linux. ⚠️ code is cross-platform by design, but there is no CI verifying all three targets (§5.4)

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
    fjord-git/        # GitBackend impl: gix primary, git2 fallback
    fjord-db/         # sqlx + SQLite migrations, implements *Store traits
    fjord-fs/         # filesystem watching (notify), path/case-sensitivity helpers
    fjord-app/        # Tauri commands, DI wiring, per-OS IdeLauncher impls — the only crate depending on `tauri`
    fjord-bench/      # benchmark harness: synthetic repo/workspace generator + timed scenarios
  src-tauri/          # thin Tauri entrypoint, re-exports fjord-app
```

`fjord-domain` and `fjord-services` have no knowledge that Tauri, SQLite, or gix exist. Identifiers use the NewType pattern (`WorkspaceId`, `RepositoryId`) so IDs of different entities cannot be confused at compile time.

### 5.2 Git engine: gix primary, git2 fallback behind a trait ✅

- **[`gix`](https://github.com/GitoxideLabs/gitoxide)** (gitoxide) is a pure-Rust, memory-safe Git implementation. Its read paths — status, diff, commit-graph traversal, index access — are fast and are exactly the hot paths for a *workspace manager* (computing "24 repos, 3 need attention" means running status across every repo, repeatedly, cheaply). No C dependency; cross-compiles cleanly.
- Its gaps as of today: push, full merge workflows, rebase, and hooks are still maturing.
- **[`git2`](https://github.com/rust-lang/git2-rs)** (libgit2 bindings) is the mature, complete fallback — push, merge, credential/transport handling for every edge case.

This is the same hybrid GitButler (the closest prior art: also Rust + Tauri) has converged on, with the balance shifting toward gix over time.

Implemented design: the `GitBackend` trait in `fjord-ports` expresses operations in domain terms (`status`, `log(cursor, limit)`, `file_diff`, `branches`, `checkout`, `fetch`, `pull`, `push`, `commit`, stash operations, merge-tool handoff). `fjord-git` routes each method internally: **gix serves the hot read paths** (status/log/diff/branches), **git2 serves mutations and network transport** (fetch/pull/push/checkout/commit). Callers in `fjord-services` never know which engine served a call — when a `gix` feature matures, it's a one-crate change with zero blast radius. No shelling out to the system `git` binary in the hot path.

Concurrency inside the adapter: all blocking git work runs under `tokio::task::spawn_blocking`; a per-repository `RwLock` (keyed by canonicalized path) allows parallel reads of the same repo while serializing writes.

### 5.3 Performance strategy for large repositories and large workspaces

Two different performance problems, both real: (1) one huge repo — big working tree, deep history; (2) many repos at once — 24+ repositories, each needing a status check on every workspace refresh.

Approach, item by item:

- ✅ **Incremental status, not full rescans.** `fjord-fs` watches each working tree recursively via `notify` and invalidates only the affected repo's cached status. Events under generated directories (`target/`, `node_modules/`, ...) and the `.git` object store are filtered out, and bursts are debounced inside the watcher (300 ms quiet window, 5 s max delay) — a rebase or an `npm install` produces one invalidation, not a storm (`P4-15`). A second debounce layer in `WorkspaceService` coalesces refresh scheduling.
- ✅ **A status/summary cache in SQLite.** The dashboard reads from `repo_status_cache`, refreshed asynchronously per-repo; the read path is a single `LEFT JOIN` (no N+1). The UI always shows "status as of last refresh, refreshing in background" rather than blocking on the slowest repo.
- ✅ **Bulk operations run concurrently**, bounded by a worker pool (Tokio `Semaphore` + `JoinSet`, currently 6 concurrent) — "Pull all" on 24 repos takes roughly as long as the slowest one, not the sum.
- ✅ **gix for the hot read paths** (status, diff, log) — avoids libgit2's process-wide locking and is competitive-to-faster on large trees.
- ✅ **Commit graph is paginated/lazy** on the backend: `log(repo, cursor, limit)` with a "Load earlier commits" affordance in the UI.
- 🚧 **Frontend list virtualization** (e.g. `@tanstack/react-virtual`) for lists that scale with repo/commit/file count. Not implemented: commit graph and repository lists currently render every row (`P4-08`). This is the missing half of the pagination story — the backend never loads a 200k-commit history at once, but the frontend renders every loaded row into the DOM.
- ✅ **Global search** fans out across repositories through the same bounded worker pool as bulk operations, preserving deterministic result order before the global limit cut (`P4-13`); `fjord-bench --workspace-repos N` reports `global_search_ms`.

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
- ⚠️ **Data fetching**: the target design is TanStack Query over Tauri IPC (cache, deduplication, invalidation after mutations). The library is installed and a `QueryClientProvider` is mounted, but every `application/` hook currently uses manual `useState` + `useEffect` with `cancelled` flags — no cache, repeated IPC calls on every view switch. Migration is tracked as `P4-07`.
- ⚠️ **Domain types**: the target is TS types **generated from the Rust side** (via `specta` or `ts-rs`) so the contract cannot drift. Currently the types in `src/domain/` are hand-maintained mirrors of `fjord-domain`, kept in sync by convention and review. Generation is tracked as `P4-11`.
- ⚠️ **Component size**: `App.tsx` has accreted palette/modal/action state and passes 15+ props into `RepoDetailView` (prop drilling). Decomposition is tracked as `P4-12`.
- ✅ **Error boundaries**: a global boundary wraps `App` in `main.tsx` and a per-view boundary (keyed by the active view, so navigation resets it) wraps the main pane — an unhandled render exception shows a localized fallback with retry/reload instead of blanking the window (`P4-10`).

### 6.2 Internationalization

- ✅ Library: `react-i18next`. Catalogs: one JSON file per locale per namespace under `src/locales/`. Currently two namespaces (`common`, `workspace`) — the spec's finer split (`repo`, `settings`) can be introduced when catalogs grow.
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
settings          { id = 1, locale, theme, default_ide, updated_at }          -- single row
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
- ✅ **Async runtime**: Tokio throughout the backend; blocking git work wrapped in `spawn_blocking`. 🚧 Long-running operations (fetch/pull/push, bulk ops) do **not** yet report progress via Tauri events or support cancellation — the UI waits silently until completion (`P4-17`). The event contract needs its own spec before implementation.
- ✅ **Logging/tracing**: `tracing` + a daily-rotating file appender in the app data dir so bug reports can include real diagnostics (`P4-14`). See §10.
- **Testing** (current state; gaps tracked in `P4-09`):
  - ✅ `fjord-domain` / `fjord-services`: unit tests with in-memory fakes of the port traits — no real Git or SQLite needed.
  - ✅ `fjord-git`: integration tests against real fixture repositories (including this repository itself as the cheapest fixture).
  - ✅ `fjord-db`: store tests against a real SQLite database.
  - ✅ Frontend: unit tests for the pure algorithmic parts (`fileTree`, `graphLayout`) under `vitest`.
  - 🚧 Missing: React component tests (RTL), contract tests mocking the IPC boundary at `infrastructure/`, integration tests of Tauri commands in `fjord-app`, `IdeLauncher` tests on real paths.
  - ✅ All of the above run in CI on every push/PR (`P0-09`, see §5.4).

## 9. Security

Threat model in one line: the WebView renders only local data (no remote content), so the main risks are (a) a compromised/renegade WebView reaching powerful IPC commands, and (b) the app spawning external processes based on user-controlled settings.

- ✅ **Content Security Policy**: `tauri.conf.json` sets a strict CSP (self-only sources; `style-src 'unsafe-inline'` is required by React inline styles; a slightly looser `devCsp` allows the Vite dev server and HMR websocket) so a markup-injection bug cannot escalate to IPC access (`P4-01`).
- ✅ **Tauri capabilities**: `src-tauri/capabilities/default.json` grants only the core defaults plus the dialog/opener plugin permissions the app actually uses; no broad filesystem or shell capabilities are exposed to the WebView.
- ✅ **External process launching** (`fjord-app/src/ide_launcher.rs`): the `ide` string from settings/IPC only launches commands from an explicit allowlist of known IDE CLIs; the custom-editor escape hatch requires the deliberate `custom:<command>` form and an unrecognized bare value is rejected with `ide_not_allowed`. The Unix availability check walks `PATH` directly instead of interpolating into `sh -c` (`P4-04`).
- ✅ **Startup robustness**: bootstrap failures (app data dir resolution, DB open) surface a blocking error dialog and a non-zero exit code instead of a panic (`P4-02`).
- ✅ **Input validation**: repository paths from IPC are canonicalized and checked for being actual Git repositories before use; IDs are opaque NewTypes generated backend-side.

## 10. Observability

Implemented in `fjord-app/src/logging.rs` (`P4-14`):

- ✅ `tracing-subscriber` with an env-filter — default `info`, `debug` for `fjord_*` crates in dev builds, overridable via `RUST_LOG`.
- ✅ A daily-rotating file appender (`tracing-appender`) writing to `<app data dir>/logs/fjord.*.log`; retention of the 5 most recent files. Initialized before state bootstrap so startup failures leave a trace on disk; a logging failure never blocks the app itself.
- ✅ Log lines never include file *contents* or diff bodies — paths, repo names, and timings only (logs may be attached to public bug reports).
- 🚧 A "reveal log folder" affordance in settings.

## 11. Non-functional requirements and benchmarks

Performance budgets (targets, measured on **release** builds; enforcement via benchmark checkpoints is `P4-18`):

| Scenario | Budget |
|---|---|
| Dashboard read from cache, 24 repos | < 5 ms |
| Full uncached status refresh, 24 repos (parallel) | < 1 s wall-clock |
| `log` page (200 commits) on a 100k-commit repo | < 150 ms |
| Commit-graph interaction (select/scroll) at 1k loaded commits | no dropped frames (< 16 ms/frame) |

Measured checkpoints so far (recorded in [`benchmarks/`](benchmarks/), **dev profile** — treat as upper bounds, not representative numbers):

- [`p1-09.md`](benchmarks/p1-09.md) — single-repo open/status/log against synthetic fixtures (e.g. status ≈ 69 ms at 1 000 commits, dev profile).
- [`p2-07.md`](benchmarks/p2-07.md) — dashboard refresh on a 24-repo synthetic workspace (cached read ≈ 0.5 ms; parallel uncached refresh bounded by the slowest repo).

Methodology gap: checkpoints were recorded with the dev profile; re-record with `--release` and larger fixtures (50–200k commits) before drawing optimization conclusions.

## 12. Implementation status

High-level snapshot; the authoritative per-task list is [`tasks.md`](tasks.md).

| Area | Status |
|---|---|
| Phase 0 — Foundation (workspace scaffold, ports, git/db adapters, shell, theming, i18n, IPC pattern, bench harness, CI) | ✅ done |
| Phase 1 — Single-repo core (branches, graph, inspector, diff, mutations, push, conflicts, benchmark) | ✅ done |
| Phase 2 — Workspace layer (CRUD, status cache, dashboard, list-detail, bulk ops, IDE launcher, benchmark) | ✅ done |
| Phase 3 — Polish and release | ⚠️ partial: palette (`P3-01`), global search (`P3-02`), onboarding (`P3-04`) done; packaging (`P3-03`) and contributor docs (`P3-05`) open |
| Phase 4 — Hardening & tech debt (2026-08 audit) | 🚧 open; see [`tasks.md`](tasks.md) §Phase 4 |

Known divergences between this document and the code are marked ⚠️/🚧 inline in their sections (data fetching §6.1, type generation §6.1, virtualization §5.3, CSP §9, logging §10, CI §5.4).

## 13. Risks and open questions

| Risk | Mitigation |
|---|---|
| `gix` push/merge/rebase support matures slower than expected | `GitBackend` trait already isolates this — worst case, those calls stay on `git2` indefinitely with no architectural cost |
| Platform-specific and locale regressions | CI matrix on all three OSes plus the i18n catalog check run on every push (`P0-09`, `P4-16`); release benchmarks in CI are still open (`P4-18`) |
| Hand-maintained TS types drift from Rust domain | Reviews catch it today; `P4-11` (generated types) removes the class of bug |
| Large-monorepo performance is partly a claim: dev-profile numbers only | Re-record benchmarks in release profile with larger fixtures (`P4-18`) before optimizing blind |
| SVG commit graph DOM cost on deep histories | Virtualize first (`P4-08`); re-evaluate a canvas renderer only if still needed after that |
| Custom title bar vs. native OS conventions | Default to native decorations per-platform; only override where there's a clear UX win |

## 14. Documentation map

- [`SDD.md`](SDD.md) (this document) — architecture, decisions, current state.
- [`tasks.md`](tasks.md) — task board with statuses. **Replaces `plan.md`** (removed in v0.3; task IDs referenced from code and commits are unchanged).
- [`specs/`](specs/) — per-subsystem contracts: [`git-backend.md`](specs/git-backend.md), [`data-model.md`](specs/data-model.md), [`ipc-commands.md`](specs/ipc-commands.md), [`i18n.md`](specs/i18n.md), [`theming.md`](specs/theming.md).
- [`benchmarks/`](benchmarks/) — recorded benchmark checkpoints (`p1-09.md`, `p2-07.md`).
