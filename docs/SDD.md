# Fjord — Software Design Document

Status: draft v0.1
Owner: msochnev

## 1. Vision

Fjord is an open-source, cross-platform Git **workspace manager** — not a single-repo Git GUI, but a control center for many repositories at once. Users group repositories into Workspaces (Backend, Frontend, Infrastructure, ...), see unified status across all of them, run bulk operations, and drill into any single repository for a full history/graph/diff view comparable to GitKraken.

Design language: minimalist, premium, in the spirit of Linear / Raycast / Arc Browser. Native-feeling desktop app, not a wrapped website.

## 2. Goals

- **G1 — Multi-repo workspace management**: group, monitor, and bulk-operate on many repositories.
- **G2 — Single-repo deep view**: branches, commit graph, diffs, history — on par with dedicated Git GUIs.
- **G3 — Internationalization (i18n)**: ship with English and Russian, switchable at runtime, and structured so a third locale is a content-only addition (no code changes).
- **G4 — Theming**: light / dark / system, defaulting to system, switchable at runtime without restart.
- **G5 — Clean Architecture**: strict dependency direction, framework-agnostic domain/use-case core, swappable infrastructure (git engine, database, IPC transport).
- **G6 — Performance at scale**: stays fast on large monorepos (tens of thousands of commits, large working trees) and on workspaces containing dozens of repositories.
- **G7 — Cross-platform parity**: first-class, equally fast experience on Windows, macOS, and Linux — not a "works on Mac, tolerated elsewhere" app.

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
│  │  presentation / app state  │IPC│  → repositories →      │  │
│  │  i18n, theming             │   │    database / models   │  │
│  └───────────────────────────┘   └───────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

Both sides follow the same Clean Architecture dependency rule independently — the Rust core is the source of truth for domain logic; the frontend is a (fairly thin) presentation layer over Tauri IPC, not a second place where business rules live.

## 5. Backend architecture (Rust)

### 5.1 Layering and the dependency rule

```
commands        (Tauri command handlers — thin adapters, no logic)
   │  depends on
services        (use-cases / application logic — orchestrates repositories)
   │  depends on
repositories     (ports: traits describing what the app needs — Git, DB, FS, IDE-launcher)
   │  implemented by
database / models / infra   (sqlx+SQLite, gix/git2, notify, process spawning)
```

Dependency rule: inner layers never import outer layers. `services` depends on **repository traits**, not on `gix`, `sqlx`, or `tauri` types directly. This is what makes the git engine and the database swappable, and what makes `services` unit-testable with in-memory fakes.

Concretely, as a Cargo workspace:

```
fjord/
  crates/
    fjord-domain/       # entities + value objects, zero deps beyond std/serde
    fjord-services/     # use-cases, orchestration, depends only on fjord-domain + port traits
    fjord-ports/         # trait definitions (GitBackend, WorkspaceStore, SettingsStore, IdeLauncher, ...)
    fjord-git/           # GitBackend impl: gix primary, git2 fallback
    fjord-db/            # sqlx + SQLite migrations, implements *Store traits
    fjord-fs/             # filesystem watching (notify), path/case-sensitivity helpers
    fjord-app/           # Tauri commands, DI wiring, app bootstrap — the only crate depending on `tauri`
  src-tauri/             # thin Tauri entrypoint, re-exports fjord-app
```

`fjord-domain` and `fjord-services` have no knowledge that Tauri, SQLite, or gix exist. This is the actual enforcement of Clean Architecture here — not a folder-naming convention, but a compile-time boundary (each layer is its own crate; the dependency graph is checked by `cargo`, not by discipline alone).

### 5.2 Git engine: gix primary, git2 fallback behind a trait

You mentioned gitoxide — that's the right call, with one caveat worth designing around up front.

- **[`gix`](https://github.com/GitoxideLabs/gitoxide)** (gitoxide) is a pure-Rust, memory-safe Git implementation. Its read paths — status, diff, commit-graph traversal, blame, index access — are fast and are exactly the hot paths for a *workspace manager* (computing "24 repos, 3 need attention" means running status across every repo, repeatedly, cheaply). It has no C dependency, cross-compiles cleanly for Windows/macOS/Linux, and is under active development.
- Its gaps as of today: push, full merge workflows, rebase, and hooks are still maturing. A workspace manager that can show status but can't push isn't shippable.
- **[`git2`](https://github.com/rust-lang/git2-rs)** (libgit2 bindings) is the mature, complete fallback — it has push, merge, rebase, credential/transport handling for every edge case.

This is not a hypothetical hybrid — it's the same path **GitButler** (the closest real prior art: also Rust + Tauri, also a Git client) has converged on: git2 for what gix doesn't cover yet, gix for the performance-critical hot paths, with the balance shifting toward gix over time as it matures.

Design: define a `GitBackend` trait in `fjord-ports` expressing operations in domain terms (`status(repo) -> RepoStatus`, `log(repo, range) -> CommitGraph`, `push(repo, refspec) -> Result<...>`, etc.). `fjord-git` implements it, internally routing each method to `gix` or `git2` — callers in `fjord-services` never know or care which engine served a given call. When a `gix` feature matures (e.g. push), it's a one-crate change with zero blast radius on `services` or the frontend. No shelling out to the system `git` binary in the hot path — it stays available only as a documented last-resort escape hatch (e.g. exotic hooks), not a core dependency.

### 5.3 Performance strategy for large repositories and large workspaces

Two different performance problems, both real:

1. **One huge repo** (large monorepo: big working tree, deep history).
2. **Many repos at once** (24+ repositories, each needs a status check, on every workspace refresh).

Approach:

- **Incremental status, not full rescans.** `fjord-fs` watches working trees via `notify` (cross-platform: FSEvents / ReadDirectoryChangesW / inotify under one API) and invalidates only the affected repo's cached status, instead of re-walking every repo on every UI refresh.
- **A status/summary cache in SQLite.** The dashboard's "24 repositories / 3 need attention" view reads from a materialized cache table (`repo_status_cache`), refreshed asynchronously per-repo, not computed synchronously on every paint. The UI is always showing "status as of last refresh, refreshing in background" rather than blocking on the slowest repo in the workspace.
- **Bulk operations run concurrently**, bounded by a worker pool (Tokio), not sequentially — "Pull all" on 24 repos should take roughly as long as the slowest one, not the sum.
- **gix for the hot read paths** (status, diff, log) specifically because it avoids libgit2's process-wide locking patterns and is competitive-to-faster on exactly these operations on large trees.
- **Commit graph is paginated/lazy**, not loaded in full — the prototype's "Load earlier commits" affordance is the intended real behavior, not a placeholder: the backend exposes a `log(repo, since_cursor, limit)` call, and the frontend virtualizes the row list so a 200k-commit history renders the same as a 200-commit one.
- **Frontend list virtualization** (e.g. `@tanstack/react-virtual`) for any list that scales with repo/commit/file count — repository grid, commit graph, changed-files list.

### 5.4 Cross-platform strategy (Windows / macOS / Linux)

- **Filesystem semantics differ** (case-insensitive-but-preserving on Windows/macOS by default, case-sensitive on Linux; path separators; symlink permission requirements on Windows). All path handling goes through a small `fjord-fs` abstraction rather than ad hoc `std::path` use scattered through services, so these differences are handled in one place.
- **File watching** via `notify`, which already abstracts FSEvents (macOS) / ReadDirectoryChangesW (Windows) / inotify (Linux) behind one API — no per-OS branches needed in application code.
- **External process integration** ("Open in IDE", "Open terminal here", launching the configured merge tool) is inherently OS-specific (different discovery of installed IDEs, different shell invocation). This lives entirely behind the `IdeLauncher` port in `fjord-ports`, with one implementation per OS in `fjord-app`, so `services` issues a single `open_in_ide(repo)` call and never branches on target OS.
- **Window chrome**: Tauri v2's decorations are per-platform by default (native traffic lights on macOS, native min/max/close on Windows/Linux). Fjord uses a custom title bar only where it earns its keep (workspace switcher, global search) and otherwise respects each platform's native window conventions rather than forcing one OS's look onto the others.
- **CI builds and tests on all three targets** from day one (not "Linux CI, manual Mac/Windows checks before release") — cheapest time to catch a platform-specific regression is the PR that introduced it.

## 6. Frontend architecture (React + TypeScript)

### 6.1 Layering

```
presentation/     UI components — “dumb”, receive data + callbacks as props
application/       hooks, TanStack Query cache, view-state, orchestration
domain/             TS types mirroring the Rust domain (generated, not hand-duplicated)
infrastructure/   Tauri IPC client, i18n runtime, theme runtime
```

`domain/` types are **generated from the Rust side** (via [`specta`](https://github.com/specta-rs/specta) or `ts-rs`) rather than hand-maintained — this is the concrete mechanism that keeps the frontend an honest presentation layer instead of a second source of truth that drifts from the backend.

### 6.2 Internationalization

- Library: `react-i18next` (mature, ICU-capable, minimal runtime cost, well-understood).
- Catalogs: one JSON file per locale per feature namespace — `locales/en/workspace.json`, `locales/ru/workspace.json`, etc. — not one giant file, so a new locale is additive and diffable.
- **Adding a locale is a content-only change**: drop a new `locales/<code>/*.json` set, register the code + display name in a single `locales/registry.ts` array. No component code changes required — this satisfies the "future locales without pain" requirement directly.
- **Fallback chain**: selected locale → English → raw key. Never a blank label.
- **Locale detection**: OS locale on first launch (via Tauri's locale API) if it maps to a supported locale, else English; user can override any time, choice persisted through `SettingsStore` (SQLite), applied instantly without app restart.
- **Preserving technical terms — the "не затирать технические термины" requirement** — is handled two ways, not left to translator judgement alone:
  1. A **glossary file** (`locales/glossary.md`) lists Git/dev vocabulary that stays untranslated or uses one fixed Russian community-standard rendering (e.g. `commit`, `rebase`, `stash` stay Latin; `branch` → «ветка» is the established convention). Translators work against this glossary, not ad hoc.
  2. Where a term must appear *inside* a translated sentence, it's interpolated as a variable (`t('mergedInto', { branch: 'main' })`) rather than baked into translated prose — so branch names, SHAs, and command names are never mangled by translation regardless of locale.
- **CI check**: a script diffs every non-English catalog's key set against `en/*.json` and fails the build on missing/orphaned keys — locale drift is caught at PR time, not discovered by a Russian user hitting a raw key in production.

### 6.3 Theming

- Tokens as CSS custom properties (`--surface-*`, `--text-*`, `--border`, `--fjord` accent, semantic `--moss/--amber/--rust`), exactly the token shape already validated in the dashboard prototype.
- Three modes: **Light / Dark / System**, default **System**.
- Implementation: a `ThemeProvider` resolves the effective mode (`system` → read `window.matchMedia('(prefers-color-scheme: dark)')`, and **also** subscribes to Tauri's native window theme-change event so the OS-native window chrome and the WebView content change together, not just the WebView), sets `data-theme` on `<html>`, and persists the user's *choice* (`light` / `dark` / `system` — not the resolved value) via `SettingsStore`.
- Switching is instant (CSS variable swap, no reload), matching what's already been validated in the interactive prototype.

## 7. Core data model (initial cut)

```
Workspace        { id, name, order }
RepositoryEntry  { id, workspace_id, name, path, remote_url, ide_hint }
RepoStatusCache  { repo_id, branch, ahead, behind, dirty_count, conflict, last_synced_at }
Settings         { locale, theme, default_ide, ... }        -- single row
```

`RepoStatusCache` is a cache, not a source of truth — it's always safe to drop and rebuild from the repositories themselves; this is what keeps "fast dashboard" and "correct dashboard" from being in tension.

## 8. Cross-cutting concerns

- **Errors**: `thiserror` typed errors per crate, mapped at the `commands` boundary to a small serializable `AppError { code, message }` — the frontend switches on `code` (stable, localizable) and never parses Rust `Display` strings. Error *messages* shown to the user go through the same i18n catalog as everything else.
- **Async runtime**: Tokio throughout the backend; long-running git operations (clone, fetch, push) run as cancellable background tasks and report progress via Tauri events, not blocking commands.
- **Logging/tracing**: `tracing` + a rotating file appender in the app data dir, so bug reports can include real diagnostics.
- **Testing**:
  - `fjord-domain` / `fjord-services`: pure unit tests, in-memory fake implementations of the port traits — no real Git or SQLite needed.
  - `fjord-git`: integration tests against real fixture repositories (checked into `fixtures/`, generated at test-setup time), run on all three OS targets in CI.
  - Frontend: component tests for presentation, contract tests that mock the Tauri IPC boundary at the `infrastructure/` layer.

## 9. Risks and open questions

| Risk | Mitigation |
|---|---|
| `gix` push/merge/rebase support matures slower than expected | `GitBackend` trait already isolates this — worst case, those calls stay on `git2` indefinitely with no architectural cost |
| Large-monorepo performance is a claim, not yet a measurement | Add a benchmark suite early (synthetic repo generator: N commits / M files) before optimizing blind |
| i18n key drift between locales as features ship fast | CI catalog-diff check (§6.2) turns this into a build failure, not a silent gap |
| Custom title bar vs. native OS conventions | Default to native decorations per-platform; only override where there's a clear UX win, revisit if it feels "un-native" on any one OS |

## 10. Suggested phasing (rough)

1. **Foundation**: Cargo workspace + crate boundaries, `GitBackend` trait + gix/git2 impl skeleton, SQLite migrations, Tauri shell boots, theming + i18n wiring end-to-end on a single placeholder screen.
2. **Single-repo core**: open a repo, branches, commit graph, diff/file view — proves the `fjord-git` abstraction against a real UI.
3. **Workspace layer**: multi-repo grouping, status cache, bulk operations, dashboard.
4. **Polish**: command palette, global search, cross-platform packaging/signing, first public release.
