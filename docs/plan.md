# Fjord — implementation plan

This is the actionable breakdown of [`SDD.md`](SDD.md): four phases, each a set of concrete tasks. Task IDs (`P0-01`, ...) are stable — reference them from commits, PRs, and the specs in [`specs/`](specs/) instead of re-describing the work there.

A task is done when it's merged **and** covered by the testing approach described in SDD §8 for its layer — "works on my machine" doesn't close a task.

## Phase 0 — Foundation

Goal: an empty app that boots, themes, and localizes correctly, on all three platforms, with the architectural seams in place before any real feature is built on top of them.

- **P0-01** — Scaffold the Cargo workspace: `fjord-domain`, `fjord-ports`, `fjord-services`, `fjord-git`, `fjord-db`, `fjord-fs`, `fjord-app`, plus the `src-tauri` entrypoint. Enforce the dependency direction with `cargo`'s own dependency graph (inner crates must not depend on outer ones) — see SDD §5.1.
- **P0-02** — Define the port traits in `fjord-ports`: `GitBackend`, `WorkspaceStore`, `SettingsStore`, `IdeLauncher`. Signatures only, no implementation yet. See [`specs/git-backend.md`](specs/git-backend.md).
- **P0-03** — Implement `fjord-git`: `gix`-backed `status`/`log`/`diff`/`branches`, `git2`-backed stubs for the write operations gix doesn't cover yet. One `GitError` type shared by both engines.
- **P0-04** — SQLite schema + `sqlx` migrations for `settings`, `workspaces`, `repositories`, `repo_status_cache`. See [`specs/data-model.md`](specs/data-model.md).
- **P0-05** — Tauri shell boots on Windows/macOS/Linux: window opens, native decorations correct per platform, app data dir resolved correctly on all three.
- **P0-06** — Theming end-to-end: CSS token set, `ThemeProvider`, system-theme detection plus Tauri native theme-change listener, persisted choice round-trips through `SettingsStore`. See [`specs/theming.md`](specs/theming.md).
- **P0-07** — i18n end-to-end: `react-i18next` wired, `en`/`ru` catalogs for one placeholder screen, locale switcher, persisted choice, fallback chain verified. See [`specs/i18n.md`](specs/i18n.md).
- **P0-08** — Define the initial Tauri command surface (`get_settings`, `update_settings`) end-to-end through all layers, establishing the `commands → services → ports` call pattern every later command follows. See [`specs/ipc-commands.md`](specs/ipc-commands.md).
- **P0-09** — CI: build and test matrix on Windows, macOS, Linux, from the first commit that has code in it.
- **P0-10** — Benchmark harness: a synthetic-repository generator (parametrized by commit count and file count) so later performance work in Phase 1–2 has something real to measure against instead of a claim.

## Phase 1 — Single-repo core

Goal: prove the `fjord-git` abstraction against a real UI before building the multi-repo layer on top of it. This phase is deliberately scoped to *one repository at a time* — no workspace concept yet.

- **P1-01** — Open a repository via folder picker; persist it as a `RepositoryEntry` (not yet attached to a workspace).
- **P1-02** — Branches panel: local, remote, tags, current-branch indicator — backed by `GitBackend::branches`.
- **P1-03** — Commit graph: backend exposes paginated `log(repo, cursor, limit)`; frontend lane-assignment renders merge/branch topology (validated approach: see the interactive prototype — real branch/merge SVG topology, not a flat list).
- **P1-04** — Commit inspector: full message, author, timestamp, SHA, changed-files list with add/modify/delete state.
- **P1-05** — Single-file diff view.
- **P1-06** — Core mutations: checkout branch, fetch, pull, stage/unstage, commit.
- **P1-07** — Push, including credential/transport handling — routed to `git2` per [`specs/git-backend.md`](specs/git-backend.md).
- **P1-08** — Conflict flow: detect a conflicted merge/rebase, surface it clearly in the UI, hand off to the user's configured external merge tool rather than building an in-app merge editor (SDD non-goal).
- **P1-09** — Benchmark checkpoint: open/status/log against the Phase 0 synthetic large-repo fixture; record numbers, not vibes.

## Phase 2 — Workspace layer

Goal: the actual product pitch — many repositories, one dashboard.

- **P2-01** — Workspace CRUD: create, rename, reorder, delete; add/remove repositories from a workspace.
- **P2-02** — `repo_status_cache` population: `fjord-fs` file-watcher invalidates per-repo, background task refreshes the cache row asynchronously — dashboard never blocks on a live rescan (SDD §5.3).
- **P2-03** — Dashboard: metrics strip (repo count, need-attention count, behind-origin count) and repo card grid grouped by workspace.
- **P2-04** — "All repositories" list-detail view: flat list across workspaces, instant switch on click, arrow-key navigation, name/workspace filter.
- **P2-05** — Bulk operations (fetch all / pull all / open all in IDE) via a bounded Tokio worker pool — wall-clock time bounded by the slowest repo, not the sum.
- **P2-06** — `IdeLauncher` implementations for Windows, macOS, Linux (installed-IDE discovery, correct process spawning per OS).
- **P2-07** — Benchmark checkpoint: dashboard refresh time on a 24-repository synthetic workspace.

## Phase 3 — Polish and release

Goal: the details that make it feel finished, then ship it.

- **P3-01** — Command palette: actions + navigation + fuzzy search over repositories and branches.
- **P3-02** — Global search across repositories, branches, and commits.
- **P3-03** — Packaging and code signing for Windows, macOS, and Linux; update channel.
- **P3-04** — First-run / onboarding flow (add your first workspace, import existing repositories from disk).
- **P3-05** — `CONTRIBUTING.md`, issue templates, and the public release checklist.

## Out of scope for this plan

Anything under SDD §3 (Non-goals) — forge/PR object model, in-app merge editor, mobile. Revisit only as a deliberate new proposal, not a drive-by addition to an existing phase.
