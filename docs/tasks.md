# Fjord — task board

This is the actionable breakdown of [`SDD.md`](SDD.md) **with per-task status**. It replaces the former `plan.md` — the task IDs (`P0-01`, ...) are stable and unchanged, so references from commits, code comments, and specs keep working.

Legend: `[x]` done · `[ ]` open. A task is done when it's merged **and** covered by the testing approach described in SDD §8 for its layer — "works on my machine" doesn't close a task.

Last status review: 2026-08 (technical audit; Phase 4 was added from its findings).

## Phase 0 — Foundation

Goal: an empty app that boots, themes, and localizes correctly, on all three platforms, with the architectural seams in place before any real feature is built on top of them.

- [x] **P0-01** — Scaffold the Cargo workspace: `fjord-domain`, `fjord-ports`, `fjord-services`, `fjord-git`, `fjord-db`, `fjord-fs`, `fjord-app`, plus the `src-tauri` entrypoint. Enforce the dependency direction with `cargo`'s own dependency graph — see SDD §5.1.
- [x] **P0-02** — Define the port traits in `fjord-ports`: `GitBackend`, `WorkspaceStore`, `SettingsStore`, `IdeLauncher`. See [`specs/git-backend.md`](specs/git-backend.md).
- [x] **P0-03** — Implement `fjord-git`: `gix`-backed `status`/`log`/`diff`/`branches`, `git2`-backed write operations. One `GitError` type shared by both engines.
- [x] **P0-04** — SQLite schema + `sqlx` migrations for `settings`, `workspaces`, `repositories`, `repo_status_cache`. See [`specs/data-model.md`](specs/data-model.md).
- [x] **P0-05** — Tauri shell boots on Windows/macOS/Linux: window opens, native decorations correct per platform, app data dir resolved correctly.
- [x] **P0-06** — Theming end-to-end: CSS token set, `ThemeProvider`, system-theme detection plus Tauri native theme-change listener, persisted choice round-trips through `SettingsStore`. See [`specs/theming.md`](specs/theming.md).
- [x] **P0-07** — i18n end-to-end: `react-i18next` wired, `en`/`ru` catalogs, locale switcher, persisted choice, fallback chain verified. See [`specs/i18n.md`](specs/i18n.md).
- [x] **P0-08** — Initial Tauri command surface (`get_settings`, `update_settings`) end-to-end through all layers, establishing the `commands → services → ports` call pattern. See [`specs/ipc-commands.md`](specs/ipc-commands.md).
- [x] **P0-09** — CI: build and test matrix on Windows, macOS, Linux (`.github/workflows/ci.yml`): `cargo fmt`/`clippy -D warnings`/`cargo test --workspace` per OS, plus a frontend job running `tsc` + Vite build, `vitest`, and the i18n check from P4-16.
- [x] **P0-10** — Benchmark harness: synthetic-repository generator (parametrized by commit/file count) — implemented as the `fjord-bench` crate; reports live in [`benchmarks/`](benchmarks/).

## Phase 1 — Single-repo core

Goal: prove the `fjord-git` abstraction against a real UI before building the multi-repo layer on top of it.

- [x] **P1-01** — Open a repository via folder picker; persist it as a `RepositoryEntry`.
- [x] **P1-02** — Branches panel: local, remote, tags, current-branch indicator — backed by `GitBackend::branches`.
- [x] **P1-03** — Commit graph: backend exposes paginated `log(repo, cursor, limit)`; frontend lane-assignment renders merge/branch topology (SVG).
- [x] **P1-04** — Commit inspector: full message, author, timestamp, SHA, changed-files list with add/modify/delete state.
- [x] **P1-05** — Single-file diff view.
- [x] **P1-06** — Core mutations: checkout branch, fetch, pull, stage/unstage, commit.
- [x] **P1-07** — Push, including credential/transport handling — routed to `git2` per [`specs/git-backend.md`](specs/git-backend.md).
- [x] **P1-08** — Conflict flow: detect a conflicted merge/rebase, surface it in the UI, hand off to the user's configured external merge tool (`open_merge_tool`).
- [x] **P1-09** — Benchmark checkpoint: open/status/log against synthetic fixtures — recorded in [`benchmarks/p1-09.md`](benchmarks/p1-09.md) (dev profile; release re-run tracked as P4-18).

## Phase 2 — Workspace layer

Goal: the actual product pitch — many repositories, one dashboard.

- [x] **P2-01** — Workspace CRUD: create, rename, reorder, delete; add/remove repositories from a workspace.
- [x] **P2-02** — `repo_status_cache` population: `fjord-fs` file-watcher invalidates per-repo, background task refreshes the cache row asynchronously (SDD §5.3). Known watcher limitation tracked as P4-15.
- [x] **P2-03** — Dashboard: metrics strip (repo count, need-attention count, behind-origin count) and repo card grid grouped by workspace.
- [x] **P2-04** — "All repositories" list-detail view: flat list across workspaces, instant switch, arrow-key navigation, name/workspace filter.
- [x] **P2-05** — Bulk operations (fetch all / pull all / open all in IDE) via a bounded Tokio worker pool (`Semaphore` + `JoinSet`).
- [x] **P2-06** — `IdeLauncher` implementations for Windows, macOS, Linux (installed-IDE discovery, per-OS process spawning). Hardening tracked as P4-04.
- [x] **P2-07** — Benchmark checkpoint: dashboard refresh time on a 24-repository synthetic workspace — recorded in [`benchmarks/p2-07.md`](benchmarks/p2-07.md).

## Phase 3 — Polish and release

Goal: the details that make it feel finished, then ship it.

- [x] **P3-01** — Command palette: actions + navigation + fuzzy search over repositories and branches.
- [x] **P3-02** — Global search across repositories, branches, and commits. Works, but scans repositories sequentially — parallelization tracked as P4-13.
- [x] **P3-03** — Packaging and code signing for Windows, macOS, and Linux; update channel. GitHub Actions release workflow builds signed draft releases, injects updater config from secrets, and creates updater artifacts/signatures; operational certificate setup is documented in [`release.md`](release.md).
- [x] **P3-04** — First-run / onboarding flow (add your first workspace, import existing repositories from disk).
- [x] **P3-05** — `CONTRIBUTING.md`, issue templates, and the public release checklist.

## Phase 4 — Hardening & tech debt

Added 2026-08 from the technical audit. Grouped by horizon; within a group, roughly by priority. Cross-referenced from the SDD sections that describe the target state.

### 4a. Quick wins (days)

- [x] **P4-01** — Set a strict Content Security Policy (currently `csp: null` in `src-tauri/tauri.conf.json`). See SDD §9. Verify both dev and production builds still work.
- [x] **P4-02** — Graceful startup errors: replace the `expect` calls in `fjord-app` bootstrap (app data dir, DB open) with an error dialog instead of a panic. See SDD §9.
- [x] **P4-03** — Memoize the commit-graph layout: wrap `computeGraphLayout(commits)` in `useMemo` in `CommitGraph.tsx`. Verify with React Profiler.
- [x] **P4-04** — Harden `IdeLauncher`: explicit allowlist for launchable IDEs (keep "custom editor" as an explicit, clearly-scoped setting) and shell-free availability lookup instead of `sh -c` string formatting. Unit-test `resolve_launch_command`. See SDD §9.
- [x] **P4-05** — Localize the hardcoded `"My workspace"` default in `App.tsx` through the i18n catalog. (Already localized as `onboarding.defaultWorkspaceName` in both catalogs — verified, nothing left to change.)
- [x] **P4-06** — Sync documentation with the implementation: SDD reworked to v0.3 (statuses, security/observability/NFR sections, actual schema), `plan.md` merged into this file, README roadmap/stack updated.

### 4b. High-importance fixes (1–3 weeks)

- [x] **P4-07** — Migrate `src/application/*` hooks from manual `useState`+`useEffect` to TanStack Query (`useQuery`/`useMutation`, keys per repo/workspace, invalidation after mutations). Simple fetch hooks now use `useQuery`, commit history uses `useInfiniteQuery`, workspace CRUD/import/remove use `useMutation`, and repo actions invalidate repo/workspace query keys. See SDD §6.1.
- [x] **P4-08** — Frontend list virtualization (`@tanstack/react-virtual`) for the commit graph, all-repositories list, and dashboard repo-card grid; SVG graph edges are now only mounted for virtual rows within/near the viewport. See SDD §5.3.
- [x] **P4-09** — Component and contract tests: React Testing Library for key screens/hooks with the IPC boundary mocked at `infrastructure/`. Added jsdom/RTL setup, component tests for repository UI, and `useRepositories` hook tests that mock `tauriClient`. See SDD §8.
- [x] **P4-10** — React error boundaries: a global boundary plus per-view boundaries with localized fallback UI.

### 4c. Mid-term architectural refactoring (1–2 months)

- [x] **P4-11** — Generate TS domain types from Rust (`ts-rs`) instead of hand-maintaining `src/domain/*`; `fjord-domain` exports `src/domain/generated.ts`, thin frontend domain modules re-export it, and `cargo test --workspace` fails on type drift. See SDD §6.1.
- [x] **P4-12** — Decompose `App.tsx` (~474 lines): command palette state/search moved to `useCommandPaletteState`, repo action/selection/status orchestration moved to `RepoDetailContainer`, and `App.tsx` now passes a narrow route command into the detail route instead of drilling the 15+ prop bundle into `RepoDetailView`.
- [x] **P4-13** — Parallelize `RepoService::global_search` through the existing bounded worker pool; benchmark on a 24+-repo workspace in `fjord-bench` (`global_search_ms` in the workspace scenario; ≈130 ms for 24×120-commit repos, dev profile).
- [x] **P4-14** — File logging: `tracing-subscriber` + `tracing-appender` (rotating) in the app data dir, per the contract in SDD §10. (The "reveal log folder" settings affordance from §10 remains open.)
- [x] **P4-15** — Watcher coverage: recursive working-tree watch (with ignores for generated directories) plus a debounce layer inside `fjord-fs`, so edits below the repo root invalidate the status cache. Integration-test it. See SDD §5.3.
- [x] **P4-16** — i18n tooling from [`specs/i18n.md`](specs/i18n.md): `scripts/check-i18n.ts` (catalog key diff, `npm run check-i18n`, wired into CI) and `src/locales/en/glossary.md`.

### 4d. Long-term (quarter+)

- [x] **P4-17** — Progress events and cancellation for long git operations (fetch/pull/push, bulk ops): `docs/specs/operation-events.md` defines the `fjord-operation-progress` contract, Tauri commands accept `operation_id` and expose `cancel_operation`, `GitOperationContext` carries progress/cancellation into libgit2, and the repo toolbar/dashboard show cancellable progress UI. See SDD §8.
- [x] **P4-18** — Release-profile benchmarks with budgets: `fjord-bench` accepts budget flags and exits non-zero on regressions, [`benchmarks/p4-18-release.md`](benchmarks/p4-18-release.md) records release checkpoints for a 50k-commit repo and 24-repo/60k-total-commit workspace, and `.github/workflows/benchmarks.yml` runs the budget checks weekly/on demand.

## Out of scope for this board

Anything under SDD §3 (Non-goals) — forge/PR object model, in-app merge editor, mobile. Revisit only as a deliberate new proposal, not a drive-by addition to an existing phase.

## Phase 5 — System Git transport and authentication

Goal: use the user's installed Git and existing authentication environment for all
remote operations, with streaming progress, real cancellation, stable diagnostics,
and an operation-scoped askpass fallback. See
[`specs/system-git-transport.md`](specs/system-git-transport.md).

- [x] **P5-01** — Architecture and migration contract.
- [ ] **P5-02** — Split `fjord-git` into local/legacy-remote modules without behavior changes.
- [x] **P5-03** — Add separate `GitRemoteBackend` and service injection.
- [x] **P5-04** — Discover and validate the system Git executable; persist an optional override.
- [x] **P5-05** — Async streaming Git process runner.
- [x] **P5-06** — Terminate the complete process tree on cancel/timeout.
- [x] **P5-07** — Stable remote error classification and diagnostic redaction.
- [x] **P5-08** — Route fetch through system Git.
- [x] **P5-09** — Preserve pull semantics with system fetch plus local integration.
- [x] **P5-10** — Route push through system Git.
- [x] **P5-11** — Route remote branch operations through system Git.
- [x] **P5-12** — Parse/throttle system Git progress and surface raw sanitized diagnostics.
- [x] **P5-13** — Compute real ahead/behind without hidden network access.
- [x] **P5-14** — Git environment diagnostics and connection test backend.
- [x] **P5-15** — Git section in Settings UI.
- [ ] **P5-16** — Operation-scoped askpass protocol and loopback broker.
- [ ] **P5-17** — Build and package the `fjord-askpass` sidecar.
- [ ] **P5-18** — Auth prompt UI and concurrent prompt queue.
- [ ] **P5-19** — Integration fixtures, three-OS CI/release gates, cleanup, and troubleshooting docs.
