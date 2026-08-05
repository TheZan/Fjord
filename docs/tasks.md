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
- [ ] **P0-09** — CI: build and test matrix on Windows, macOS, Linux. **Still open — the most important unfinished foundation item** (no `.github/workflows`; all tests run manually today). Should also run `cargo clippy`/`fmt`, `tsc`, `vitest`, and the i18n check from P4-16 once it exists.
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
- [ ] **P3-03** — Packaging and code signing for Windows, macOS, and Linux; update channel.
- [x] **P3-04** — First-run / onboarding flow (add your first workspace, import existing repositories from disk).
- [ ] **P3-05** — `CONTRIBUTING.md`, issue templates, and the public release checklist.

## Phase 4 — Hardening & tech debt

Added 2026-08 from the technical audit. Grouped by horizon; within a group, roughly by priority. Cross-referenced from the SDD sections that describe the target state.

### 4a. Quick wins (days)

- [x] **P4-01** — Set a strict Content Security Policy (currently `csp: null` in `src-tauri/tauri.conf.json`). See SDD §9. Verify both dev and production builds still work.
- [ ] **P4-02** — Graceful startup errors: replace the `expect` calls in `fjord-app` bootstrap (app data dir, DB open) with an error dialog instead of a panic. See SDD §9.
- [ ] **P4-03** — Memoize the commit-graph layout: wrap `computeGraphLayout(commits)` in `useMemo` in `CommitGraph.tsx`. Verify with React Profiler.
- [ ] **P4-04** — Harden `IdeLauncher`: explicit allowlist for launchable IDEs (keep "custom editor" as an explicit, clearly-scoped setting) and shell-free availability lookup instead of `sh -c` string formatting. Unit-test `resolve_launch_command`. See SDD §9.
- [ ] **P4-05** — Localize the hardcoded `"My workspace"` default in `App.tsx` through the i18n catalog.
- [x] **P4-06** — Sync documentation with the implementation: SDD reworked to v0.3 (statuses, security/observability/NFR sections, actual schema), `plan.md` merged into this file, README roadmap/stack updated.

### 4b. High-importance fixes (1–3 weeks)

- [ ] **P4-07** — Migrate `src/application/*` hooks from manual `useState`+`useEffect` to TanStack Query (`useQuery`/`useMutation`, keys per repo/workspace, invalidation after mutations). Removes duplicated loading/error/cancelled plumbing in ~9 hooks and repeated IPC calls on view switches. See SDD §6.1.
- [ ] **P4-08** — Frontend list virtualization (e.g. `@tanstack/react-virtual`) for the commit graph and repository lists; draw SVG graph edges only within the viewport. See SDD §5.3.
- [ ] **P4-09** — Component and contract tests: React Testing Library for key screens/hooks with the IPC boundary mocked at `infrastructure/`. Best done after P4-07 to avoid rewriting. See SDD §8.
- [ ] **P4-10** — React error boundaries: a global boundary plus per-view boundaries with localized fallback UI.

### 4c. Mid-term architectural refactoring (1–2 months)

- [ ] **P4-11** — Generate TS domain types from Rust (`specta` or `ts-rs`) instead of hand-maintaining `src/domain/*`; add a drift check to CI. See SDD §6.1.
- [ ] **P4-12** — Decompose `App.tsx` (~474 lines): extract palette/modal/action state into contexts or route-level containers; eliminate the 15+-prop drilling into `RepoDetailView`. Best after P4-07.
- [ ] **P4-13** — Parallelize `RepoService::global_search` through the existing bounded worker pool; benchmark on a 24+-repo workspace in `fjord-bench`.
- [ ] **P4-14** — File logging: `tracing-subscriber` + `tracing-appender` (rotating) in the app data dir, per the contract in SDD §10.
- [ ] **P4-15** — Watcher coverage: recursive working-tree watch (with ignores for generated directories) plus a debounce layer inside `fjord-fs`, so edits below the repo root invalidate the status cache. Integration-test it. See SDD §5.3.
- [ ] **P4-16** — i18n tooling from [`specs/i18n.md`](specs/i18n.md): `scripts/check-i18n.ts` (catalog key diff, wire into CI) and `locales/glossary.md`.

### 4d. Long-term (quarter+)

- [ ] **P4-17** — Progress events and cancellation for long git operations (fetch/pull/push, bulk ops): design the Tauri event contract (new spec), emit progress, make tasks cancellable, show progress in the UI. See SDD §8.
- [ ] **P4-18** — Release-profile benchmarks with budgets: re-record [`benchmarks/`](benchmarks/) checkpoints with `--release` and larger fixtures (50–200k commits), adopt the budgets from SDD §11, and run them periodically in CI with regression alerts.

## Out of scope for this board

Anything under SDD §3 (Non-goals) — forge/PR object model, in-app merge editor, mobile. Revisit only as a deliberate new proposal, not a drive-by addition to an existing phase.
