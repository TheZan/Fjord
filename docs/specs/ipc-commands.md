# Spec: Tauri IPC command surface

Referenced by: P0-08, Phases 1–5; extended by Phases 6–10.

## Purpose

This is the actual contract between the React frontend and the Rust backend. Every command is a thin `fjord-app` adapter over one `fjord-services` use-case (SDD §5.1); long-running operations add a small Tauri operation adapter for progress/cancellation. Request/response types are defined once in `fjord-domain` and mirrored to TypeScript via `ts-rs` (SDD §6.1); this table is the human-readable index of that contract, not a second source of truth for the shapes themselves.

## Naming convention

`verb_noun`, snake_case, matching the Rust side exactly (no camelCase translation layer) — `invoke('verb_noun', ...)` on the frontend calls `#[tauri::command] fn verb_noun(...)` on the backend, one-to-one, always.

Every command also accepts an optional camelCase `interactionId`. The typed
client adds it while a diagnostics interaction is active; it is telemetry
metadata, not part of the use-case input, and use-case handlers never inspect it.

## Shipped commands

The authoritative list is the `invoke_handler` registration in `crates/fjord-app/src/lib.rs`; the typed wrappers live in `src/infrastructure/tauriClient.ts`. `scripts/check-ipc-docs.ts` (`npm run check-ipc-docs`, run in CI) fails when the three disagree — a command registered but undocumented, documented as shipped but not registered, or registered but unreachable from the typed client (`P5-23`). Commands under [Planned additions](#planned-additions) are excluded, so designing ahead does not break the check.

### Settings and environment

| Command | Input | Output | Notes |
|---|---|---|---|
| `get_settings` | — | `Settings` | Locale, theme, default IDE, auto-fetch, performance diagnostics, Git executable path |
| `update_settings` | `Settings` | `Settings` | Full replace; persisted immediately |
| `get_ui_state` | — | `UiState` | Loads the versioned, restart-persistent UI preference document; unsupported versions use defaults |
| `update_ui_state` | `{ patch }` | `UiState` | Merges a partial patch and persists the resulting document immediately |
| `activate_after_first_paint` | — | — | Idempotently resolves Git and registers repository watchers after the frontend's first paint |
| `get_git_environment` | — | `GitEnvironmentInfo` | Read-only inspection: executable, version, credential helpers, SSH/proxy presence |
| `select_git_executable` | `{ path }` | `GitEnvironmentInfo` | Validates before persisting; applies to local and remote Git alike |
| `reset_git_executable` | — | `GitEnvironmentInfo` | Clears the override, falls back to discovery |
| `reveal_log_folder` | — | — | Creates and opens the application-owned rotating-log directory with the OS folder viewer |
| `test_git_connection` | `{ repo_id, remote }` | `GitConnectionTestResult` | `git ls-remote --symref`; never mutates the repository |

### Workspaces and repositories

| Command | Input | Output | Notes |
|---|---|---|---|
| `list_workspaces` | — | `Workspace[]` | Ordered by `sort_order` |
| `create_workspace` | `{ name }` | `Workspace` | |
| `rename_workspace` | `{ id, name }` | `Workspace` | |
| `reorder_workspaces` | `{ ids }` | — | Full new order, not a delta |
| `delete_workspace` | `{ id }` | — | Cascades to its `repositories` rows (not the repos on disk) |
| `list_repositories` | `{ workspace_id }` | `RepositoryEntry[]` | |
| `add_repository` | `{ workspace_id, path }` | `RepositoryEntry` | Validates `path` is a Git repository before persisting |
| `import_repositories` | `{ workspace_id, root }` | `RepositoryEntry[]` | Recursively discovers repositories, skips generated directories and duplicates |
| `remove_repository` | `{ id }` | — | Removes tracking only, never touches disk |
| `get_workspace_status` | `{ workspace_id }` | `RepoStatusSummary[]` | Reads from `repo_status_cache`; triggers a background refresh, does not block on it |
| `refresh_repo_status` | `{ repo_id }` | `RepoStatusSummary` | Forces a live `GitBackend::status`, updates the cache |
| `set_repository_activity` | `{ workspace_id?, repo_id? }` | — | Applies Hot/Warm/Cold runtime and watcher tiers after navigation |
| `get_repository_snapshot` | `{ repo_id }` | `StoredRepositorySnapshot?` | Loads the persisted projection as unvalidated; callers must start live revalidation |
| `capture_repository_snapshot` | `{ repo_id }` | `StoredRepositorySnapshot` | Captures a generation-consistent live projection and persists it |
| `revalidate_repository_snapshot` | `{ repo_id }` | `SnapshotRevalidation` | Replaces the stored projection with live Git state and reports whether it changed |
| `global_search` | `{ workspace_id?, query, limit }` | `GlobalSearchResult[]` | Fans out across repositories through the bounded pool; unreadable repos are skipped |

### Repository reads

Every repository read returns `GenerationEnvelope<T> { data, generations }`.
`generations` is the runtime's `GenerationSet` stamp used for query validity;
the typed frontend client unwraps `data` before exposing it to application hooks.

| Command | Input | Output | Notes |
|---|---|---|---|
| `get_repo_status` | `{ repo_id }` | `GenerationEnvelope<RepoStatus>` | Live single-repo status |
| `get_branches` | `{ repo_id }` | `GenerationEnvelope<BranchInfo[]>` | |
| `get_tags` | `{ repo_id }` | `GenerationEnvelope<TagInfo[]>` | |
| `get_stashes` | `{ repo_id }` | `GenerationEnvelope<StashEntry[]>` | |
| `get_commit_log` | `{ repo_id, cursor?, limit }` | `GenerationEnvelope<CommitPage>` | `cursor` from the previous page's `next_cursor`; omitted = from `HEAD` |
| `search_commit_log` | `{ repo_id, query, limit }` | `GenerationEnvelope<CommitSummary[]>` | Titles across local and remote refs |
| `get_commit_diff` | `{ repo_id, commit_id }` | `GenerationEnvelope<FileDiff[]>` | Changed-files summary with line counts |
| `get_commit_files` | `{ repo_id, commit_id }` | `GenerationEnvelope<FileDiff[]>` | Fast tree-only list, painted before line counts finish |
| `get_file_diff` | `{ repo_id, commit_id, path, offset, limit, whitespace }` | `GenerationEnvelope<FileDiffWindow>` | Bounded diff window; `whitespace` is `show`, `ignoreTrailing`, or `ignoreAll` and is applied by the backend so rendered hunks match the selected mode. Every page echoes its authoritative served `offset` and retains its generation envelope for snapshot/continuation validation; maximum 2 MB serialized response and 10 MB source-file display ceiling |
| `get_working_changes` | `{ repo_id }` | `GenerationEnvelope<WorkingChanges>` | Staged/unstaged split; a partially staged file appears in both |
| `get_working_file_diff` | `{ repo_id, path, staged, offset, limit, whitespace }` | `GenerationEnvelope<FileDiffWindow>` | Bounded index-vs-HEAD window when staged, worktree-vs-index otherwise. Backend `whitespace` flags determine the displayed hunk structure. Every page independently carries its served `offset`, the full diff's `baseDigest`, and complete `GenerationSet`; the digest and existing `working_tree` generation are captured coherently and retained for cross-page validation. Partial patch actions are unavailable unless `whitespace = show`. |
| `get_amend_info` | `{ repo_id }` | `AmendInfo` | Current `HEAD` message plus `publishedUpstream` when the branch's locally known upstream contains `HEAD` |
| `preflight_destructive_action` | `{ repo_id, action, patch_selection? }` | `DestructivePreflight` | Phase 8 consequences. Discard binds the exact `PatchSelection`; force-with-lease accepts only the action intent and returns display facts resolved from backend Git state. Both return a short-lived token bound to repository, action, authoritative facts, and coherent generation stamp. |

### Repository mutations (local)

| Command | Input | Output | Notes |
|---|---|---|---|
| `checkout_branch` | `{ repo_id, branch }` | — | Materializes a remote branch through a targeted fetch first when needed |
| `create_branch` | `{ repo_id, name, checkout }` | — | At current `HEAD` |
| `create_branch_at` | `{ repo_id, name, target, checkout }` | — | At an arbitrary commit |
| `rename_branch` | `{ repo_id, old_name, new_name }` | — | |
| `delete_branch` | `{ repo_id, name }` | — | Local branch |
| `set_branch_upstream` | `{ repo_id, branch, upstream }` | — | Local config write; `upstream` must name an existing remote-tracking branch |
| `unset_branch_upstream` | `{ repo_id, branch }` | — | Local config write; no network operation |
| `create_tag` / `delete_tag` | `{ repo_id, name, target? }` | — | Lightweight tags |
| `stage_files` / `unstage_files` | `{ repo_id, paths }` | — | Empty `paths` means all |
| `stage_patch` | `{ repo_id, selection, expected_generations }` | `GenerationSet` | Reconstructs the current worktree patch under the write lock; stale generation/digest fails before index mutation; applies with shared system Git `apply --cached` |
| `unstage_patch` | `{ repo_id, selection, expected_generations }` | `GenerationSet` | Reconstructs the current staged patch under the write lock; stale generation/digest fails before index mutation; applies with shared system Git `apply --cached --reverse` |
| `discard_patch` | `{ repo_id, action, selection, expected_generations, confirmation_token }` | `GenerationSet` | Under the write lock, atomically validates and consumes the one-use confirmation before reconstructing the current index-to-worktree patch; any confirmation binding/expiry/replay mismatch is `preflight_stale`; checks then applies with shared system Git `apply --reverse` without writing the index |
| `commit_repo` | `{ repo_id, message, amend }` | `string` | New commit id; amend preserves `HEAD`'s author and parents and permits a message-only rewrite; ordinary commit returns `nothing_to_commit` when the index matches `HEAD` |
| `commit_and_push_repo` | `{ repo_id, message, amend, operation_id? }` | `CommitPushResult` | One operation id covers both phases. Once commit succeeds, push failure resolves as a partial outcome (`commitSucceeded: true`, `pushSucceeded: false`, stable `pushErrorCode`) and never rolls the commit back. |
| `cherry_pick` | `{ repo_id, commit_id }` | — | |
| `revert_commit` | `{ repo_id, commit_id }` | — | |
| `reset_to_commit` | `{ repo_id, commit_id, mode }` | — | `soft` \| `mixed` \| `hard` |
| `stash_push` | `{ repo_id, message? }` | — | |
| `stash_pop` | `{ repo_id }` | — | Applies and drops `stash@{0}` |
| `open_merge_tool` | `{ repo_id }` | — | `git mergetool --no-prompt`; the configured external tool owns resolution |

### Remote operations (system Git)

| Command | Input | Output | Notes |
|---|---|---|---|
| `fetch_repo` | `{ repo_id, remote?, operation_id? }` | — | `--progress --prune` |
| `pull_repo` | `{ repo_id, operation_id? }` | — | System fetch + local integration; never `git pull` |
| `push_repo` | `{ repo_id, force_with_lease, expected_generations?, confirmation_token?, operation_id? }` | — | Normal target is resolved from the branch's upstream; `no_upstream` → publish. Force mode requires the one-use preflight token and executes only its backend-bound remote/ref/OIDs. |
| `publish_branch` | `{ repo_id, remote?, operation_id? }` | — | The only operation allowed to name a default remote |
| `delete_remote_branch` | `{ repo_id, name }` | — | `git push <remote> --delete` |
| `bulk_fetch` / `bulk_pull` | `{ workspace_id, operation_id? }` | `BulkRepoResult[]` | Bounded worker pool; per-repo results, one failure does not abort the batch |

### Operations, authentication, and tools

| Command | Input | Output | Notes |
|---|---|---|---|
| `cancel_operation` | `{ operation_id }` | `boolean` | Terminates the Git process tree |
| `answer_git_auth_prompt` | `{ operation_id, prompt_id, value }` | `boolean` | One-use; never persisted or logged |
| `cancel_git_auth_prompt` | `{ operation_id, prompt_id }` | `boolean` | |
| `open_in_ide` | `{ repo_id, ide? }` | — | Falls back to `Settings.default_ide`; allowlisted commands only |
| `open_terminal` | `{ repo_id }` | — | |
| `bulk_open_in_ide` | `{ workspace_id, ide? }` | `BulkRepoResult[]` | |

### Performance diagnostics

| Command | Input | Output | Notes |
|---|---|---|---|
| `get_interaction_traces` | — | `InteractionTrace[]` | Drains the bounded in-memory buffer; returns `performance_diagnostics_disabled` unless the settings flag is enabled |

### Events

| Event | Payload | Spec |
|---|---|---|
| `fjord-operation-progress` | `OperationProgressEvent` | [`operation-events.md`](operation-events.md) |
| `fjord-auth-prompt` | `GitAuthPrompt` | [`operation-events.md`](operation-events.md), [`system-git-transport.md`](system-git-transport.md) |
| `fjord-repository-changed` | `{ repoId, status, working, history, refs, stashes, config, generations, statusSummary }` | Emitted by the per-repository watcher; generation comparison drives targeted query invalidation |

## Planned additions

Designed but not implemented. Each is owned by a spec and a phase; nothing below exists in the shipped surface yet.

| Command | Spec | Phase |
|---|---|---|
| `get_repo_operation_state`, `continue_operation`, `skip_operation`, `abort_operation` | [`repository-safety.md`](repository-safety.md) §1–2 | 9 |
| `get_reflog` / `get_reflog_refs` | [`repository-safety.md`](repository-safety.md) §5 | 9 |
| `list_worktrees` / `create_worktree` / `remove_worktree` | [`workspace-workflows.md`](workspace-workflows.md) §1 | 10 |
| `start_rebase` | [`workspace-workflows.md`](workspace-workflows.md) §2 | 10 |
| `remotes` / `add_remote` / `set_remote_url` / `rename_remote` / `remove_remote` | [`workspace-workflows.md`](workspace-workflows.md) §3 | 10 |
| `get_workspace_health` | [`workspace-workflows.md`](workspace-workflows.md) §4 | 10 |

## Long-running operations: events, not blocking returns

`fetch`, `pull`, `push`, and `publish` are repo-scoped operations; the UI keeps them off the render path while awaiting completion. `bulk_fetch` and `bulk_pull` run through a bounded Tokio worker pool and return per-repo results once the batch completes, so one failed repository does not abort the rest. Progress/cancellation details live in [`operation-events.md`](operation-events.md): the event name is `fjord-operation-progress`, and cancellation is requested with `cancel_operation`.

## Error shape

Every command that can fail returns `Result<T, AppError>` where `AppError = { code, message, diagnostics? }` (SDD §8). `code` is a stable, localizable identifier (`repository_not_found`, `repository_discovery_failed`, `merge_conflict`, `no_upstream`, `nothing_to_commit`, `merge_tool_failed`, `ide_not_allowed`, `operation_cancelled`, `preflight_stale`, `patch_stale`, `patch_apply_failed`, `patch_unsupported`, plus the `git_*` transport codes in [`system-git-transport.md`](system-git-transport.md)) that the frontend maps through the i18n catalog; `message` is a developer-facing fallback, never shown directly in the UI without going through a translation first. A stale destructive confirmation is never retried automatically.

## What's not a command

Anything that's pure frontend state (which row is selected in the commit graph, whether the command palette is open) — that stays in `application/` view-state, never round-trips through IPC. UI state that *must* survive a restart is the documented exception and goes through `get_ui_state`/`update_ui_state` ([`ui-shell.md`](ui-shell.md) §5), not through per-feature commands.
