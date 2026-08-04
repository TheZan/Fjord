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
| `get_repo_status` | `{ repo_id }` | `RepoStatus` | Live single-repo status for Phase 1 UI; P2 dashboard status uses the cache-oriented commands above |
| `get_commit_log` | `{ repo_id, cursor?, limit }` | `CommitPage` | `cursor` from the previous page's `CommitPage.next_cursor`; omitted cursor = start from `HEAD` |
| `get_commit_diff` | `{ repo_id, commit_id }` | `FileDiff[]` | Changed-files summary for the commit inspector (P1-04) — path, change type, add/delete line counts, no content |
| `get_file_diff` | `{ repo_id, commit_id, path }` | `FileDiffDetail` | Full unified line diff for one file within a commit (P1-05); `isBinary` is `true` and `hunks` empty when either side is binary |
| `checkout_branch` | `{ repo_id, branch }` | — | |
| `stage_files` | `{ repo_id, paths: string[] }` | — | Empty `paths` means stage all changes |
| `unstage_files` | `{ repo_id, paths: string[] }` | — | Empty `paths` means unstage all paths |
| `commit_repo` | `{ repo_id, message }` | `string` | Returns the new commit id; `nothing_to_commit` if the index matches `HEAD` |
| `fetch_repo` / `pull_repo` / `push_repo` | `{ repo_id }` | — | Repo-level commands await completion without blocking the UI thread; P2 bulk operations emit progress events |
| `open_merge_tool` | `{ repo_id }` | — | Launches `git mergetool --no-prompt` in the repository when conflicts are present; the configured external merge tool owns resolution |
| `bulk_fetch` / `bulk_pull` | `{ workspace_id }` | `BulkRepoResult[]` | Fans out across the bounded worker pool (SDD §5.3); per-repo result records identify failures without aborting the whole batch |
| `bulk_open_in_ide` | `{ workspace_id, ide? }` | `BulkRepoResult[]` | Opens every tracked repo in the workspace through `IdeLauncher`, using the same bounded worker pool |
| `open_in_ide` | `{ repo_id, ide? }` | — | `ide` optional, falls back to `Settings.default_ide` |

## Long-running operations: events, not blocking returns

`fetch`, `pull`, and `push` are repo-scoped operations; the UI keeps them off the render path while awaiting completion. `bulk_*` commands run through a bounded Tokio worker pool and return per-repo results once the batch completes, so one failed repository does not abort the rest. A future event-stream layer can expose progress before completion (`bulk-op://progress`) without changing the worker-pool contract.

## Error shape

Every command that can fail returns `Result<T, AppError>` where `AppError = { code: string, message: string }` (SDD §8). `code` is a stable, localizable identifier (`repository_not_found`, `merge_conflict`, `auth_failed`, `no_upstream`, `nothing_to_commit`, `merge_tool_failed`, ...) that the frontend maps through the i18n catalog; `message` is a developer-facing fallback, never shown directly in the UI without going through a translation first.

## What's not a command

Anything that's pure frontend state (which row is selected in the commit graph, whether the command palette is open) — that stays in `application/` view-state, never round-trips through IPC. If it doesn't need to survive a restart or be shared with the backend's business logic, it doesn't belong here.
