# Spec: Tauri IPC command surface

Referenced by: P0-08, all of Phase 1–2.

## Purpose

This is the actual contract between the React frontend and the Rust backend. Every command is a thin `fjord-app` adapter over one `fjord-services` use-case (SDD §5.1) — no logic lives in the command handler itself. Request/response types are defined once in `fjord-domain` and mirrored to TypeScript via `specta` (SDD §6.1); this table is the human-readable index of that contract, not a second source of truth for the shapes themselves.

## Naming convention

`verb_noun`, snake_case, matching the Rust side exactly (no camelCase translation layer) — `invoke('verb_noun', ...)` on the frontend calls `#[tauri::command] fn verb_noun(...)` on the backend, one-to-one, always.

## Commands (initial cut)

| Command | Input | Output | Notes |
|---|---|---|---|
| `get_settings` | — | `Settings` | Locale, theme, default IDE |
| `update_settings` | `SettingsPatch` | `Settings` | Partial update; persisted immediately |
| `list_workspaces` | — | `Workspace[]` | Ordered by `sort_order` |
| `create_workspace` | `{ name }` | `Workspace` | |
| `rename_workspace` | `{ id, name }` | `Workspace` | |
| `reorder_workspaces` | `{ ids: string[] }` | — | Full new order, not a delta |
| `delete_workspace` | `{ id }` | — | Cascades to its `repositories` rows (not the repos on disk) |
| `add_repository` | `{ workspace_id, path }` | `RepositoryEntry` | Validates `path` is a Git repository before persisting |
| `remove_repository` | `{ id }` | — | Removes tracking only, never touches disk |
| `get_workspace_status` | `{ workspace_id }` | `RepoStatusSummary[]` | Reads from `repo_status_cache`; triggers a background refresh, does not block on it |
| `refresh_repo_status` | `{ repo_id }` | `RepoStatusSummary` | Forces a live `GitBackend::status` call, updates the cache, returns fresh data — used for pull-to-refresh style UI, not the default path |
| `get_branches` | `{ repo_id }` | `BranchInfo[]` | |
| `get_commit_log` | `{ repo_id, cursor?, limit }` | `CommitPage` | `cursor` from the previous page's `CommitPage.next_cursor`; omitted cursor = start from `HEAD` |
| `get_commit_diff` | `{ repo_id, commit_id }` | `FileDiff[]` | |
| `checkout_branch` | `{ repo_id, branch }` | — | |
| `fetch_repo` / `pull_repo` / `push_repo` | `{ repo_id }` | — | Emits progress via Tauri events (see below), not a blocking return |
| `bulk_fetch` / `bulk_pull` | `{ workspace_id }` | — | Fans out across the bounded worker pool (SDD §5.3); per-repo results stream as events |
| `open_in_ide` | `{ repo_id, ide? }` | — | `ide` optional, falls back to `Settings.default_ide` |

## Long-running operations: events, not blocking returns

`fetch`, `pull`, `push`, and the `bulk_*` commands return once the operation is *started*, not once it's finished. Progress and completion are reported via Tauri events (`repo://status-changed`, `bulk-op://progress`) that the frontend's `application/` layer subscribes to through TanStack Query's cache invalidation — this is what keeps a slow push on one repository from freezing the whole UI, and what makes `bulk_pull` on 24 repositories feel like 24 independent operations instead of one big blocking call (SDD §5.3, §8).

## Error shape

Every command that can fail returns `Result<T, AppError>` where `AppError = { code: string, message: string }` (SDD §8). `code` is a stable, localizable identifier (`repo_not_found`, `merge_conflict`, `auth_failed`, ...) that the frontend maps through the i18n catalog; `message` is a developer-facing fallback, never shown directly in the UI without going through a translation first.

## What's not a command

Anything that's pure frontend state (which row is selected in the commit graph, whether the command palette is open) — that stays in `application/` view-state, never round-trips through IPC. If it doesn't need to survive a restart or be shared with the backend's business logic, it doesn't belong here.
