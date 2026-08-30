# Spec: Tauri IPC command surface

Referenced by: P0-08, Phases 1–5; extended by Phases 6–10 (including
`P10-MERGE-01`–`P10-MERGE-03`, `P10-WC-01`–`P10-WC-06`,
`P10-STASH-01`–`P10-STASH-06`, and `P10-WC-MULTI-01`–`P10-WC-MULTI-03`).

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
| `set_workspace_expected_branch` | `{ id, expected_branch }` | `Workspace` | Configuration only: trims the value, treats empty as `null`, validates it as a local branch name (`expected_branch_invalid`), and persists it. Runs no Git command, checks nothing out, and bumps no repository generation; only the derived `RepoHealth` changes |
| `reorder_workspaces` | `{ ids }` | — | Full new order, not a delta |
| `delete_workspace` | `{ id }` | — | Cascades to its `repositories` rows (not the repos on disk) |
| `list_repositories` | `{ workspace_id }` | `RepositoryEntry[]` | |
| `add_repository` | `{ workspace_id, path }` | `RepositoryEntry` | Validates `path` is a Git repository before persisting |
| `clone_repository` | `{ request: { workspace_id, url, destination_parent, directory_name?, branch? }, operation_id? }` | `CloneRepositoryResult` | Cancellable system-Git clone; validates local state before operation creation, registers exactly once, and retains any partial destination on failure/cancel |
| `create_repository` | `{ request: { workspace_id, destination_parent, directory_name, initial_branch? } }` | `CreateRepositoryResult` | Local non-bare init with unborn `HEAD`; omitted branch defaults to `main`; accepts a missing or empty target, rejects a non-empty target, and registers exactly once |
| `import_repositories` | `{ workspace_id, root }` | `RepositoryEntry[]` | Recursively discovers repositories, skips generated directories and duplicates |
| `remove_repository` | `{ id }` | — | Removes tracking only, never touches disk |
| `get_workspace_status` | `{ workspace_id }` | `RepoStatusSummary[]` | Reads from `repo_status_cache`; triggers a background refresh, does not block on it |
| `get_workspace_health` | `{ workspace_id }` | `RepoHealth[]` | O(repositories) projection over cached status plus in-memory operation/error observations; performs no Git reads and returns all applicable conditions in canonical severity order |
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
| `get_repo_operation_state` | `{ repo_id }` | `GenerationEnvelope<RepoOperationState>` | Live on-disk operation state; query validity depends on `refs` and `working_tree` |
| `get_branches` | `{ repo_id }` | `GenerationEnvelope<BranchInfo[]>` | |
| `get_tags` | `{ repo_id }` | `GenerationEnvelope<TagInfo[]>` | |
| `get_stashes` | `{ repo_id }` | `GenerationEnvelope<StashEntry[]>` | Rich identity-bearing `StashEntry` from [`stash-management.md`](stash-management.md) §1.2, in exact Git stack order; read-locked and cached against the `stash` generation |
| `get_stash_files` | `{ repo_id, stash_id }` | `GenerationEnvelope<StashFiles>` | Bounded, authoritative stash file groups: base→index, index→stash, and empty→untracked; resolved only by stable `StashId` and read-locked |
| `get_stash_file_diff` | `{ repo_id, stash_id, group, path, offset, limit, whitespace, load_anyway }` | `GenerationEnvelope<FileDiffWindow>` | Read-only tree-to-tree stash diff using the existing 2,000-line, 2 MB response, and 10 MB source-file ceilings; `load_anyway` overrides only the source-file ceiling |
| `get_commit_log` | `{ repo_id, cursor?, limit }` | `GenerationEnvelope<CommitPage>` | `cursor` from the previous page's `next_cursor`; omitted = from `HEAD` |
| `get_reflog` | `{ repo_id, ref_name?, cursor?, limit }` | `GenerationEnvelope<ReflogPage>` | Newest-first, capped at 200 entries per page; omitted `ref_name` reads `HEAD`, and `cursor` is the opaque value from `nextCursor` |
| `get_reflog_refs` | `{ repo_id }` | `GenerationEnvelope<string[]>` | Canonical `refs/heads/*` names that currently have a reflog |
| `search_commit_log` | `{ repo_id, query, limit }` | `GenerationEnvelope<CommitSummary[]>` | Titles across local and remote refs |
| `get_commit_diff` | `{ repo_id, commit_id }` | `GenerationEnvelope<FileDiff[]>` | Changed-files summary with line counts |
| `get_recovery_diff` | `{ repo_id, commit_id }` | `GenerationEnvelope<FileDiff[]>` | Changes from the current `HEAD` tree to the selected recovery commit, with line counts |
| `get_commit_files` | `{ repo_id, commit_id }` | `GenerationEnvelope<FileDiff[]>` | Fast tree-only list, painted before line counts finish |
| `get_file_diff` | `{ repo_id, commit_id, path, offset, limit, whitespace, load_anyway }` | `GenerationEnvelope<FileDiffWindow>` | Bounded diff window; `whitespace` is `show`, `ignoreTrailing`, or `ignoreAll` and is applied by the backend so rendered hunks match the selected mode. `load_anyway = true` is an explicit user override of only the 10 MB source-file display ceiling; the 2,000-line and 2 MB response ceilings remain. Every page echoes its authoritative served `offset` and retains its generation envelope for snapshot/continuation validation. |
| `get_working_changes` | `{ repo_id }` | `GenerationEnvelope<WorkingChanges>` | Staged/unstaged split; a partially staged file appears in both |
| `get_working_file_diff` | `{ repo_id, path, staged, offset, limit, whitespace, load_anyway }` | `GenerationEnvelope<FileDiffWindow>` | Bounded index-vs-HEAD window when staged, worktree-vs-index otherwise. Backend `whitespace` flags determine the displayed hunk structure. `load_anyway` overrides only the source-file display ceiling; response bounds remain mandatory. Every page independently carries its served `offset`, the full diff's `baseDigest`, and complete `GenerationSet`; the digest and existing `working_tree` generation are captured coherently and retained for cross-page validation. Partial patch actions are unavailable unless `whitespace = show`. |
| `get_merge_preflight` | `{ repo_id, source }` | `GenerationEnvelope<MergePreflight>` | Read-only, generation-stamped branch integration facts (`P10-MERGE-01`) |
| `get_amend_info` | `{ repo_id }` | `AmendInfo` | Current `HEAD` message plus `publishedUpstream` when the branch's locally known upstream contains `HEAD` |
| `preview_ignore_rule` | `{ repo_id, path, rule_kind }` | `IgnoreRulePreview` | Returns the exact root-`.gitignore` rule and duplicate state without writing; refuses tracked files and non-UTF-8 `.gitignore` bytes |
| `preflight_destructive_action` | `{ repo_id, action, patch_selection? }` | `DestructivePreflight` | Bounded consequences for all destructive actions. Returns a short-lived token bound to repository, exact action/scope, authoritative facts, and coherent generation stamp. |
| `execute_destructive_action` | `{ repo_id, action, expected_generations, confirmation_token, operation_id? }` | `DestructiveExecutionResult` | Atomically consumes the exact confirmation before execution. Returns `OperationState` for abort, `StashApply` for Pop (including typed conflict paths and whether the entry was removed), and `Completed` otherwise. `StashPop { id, restore_index }` and `StashDrop { id }` are bound by exact stable identity and have no standalone mutation commands. |

### Repository mutations (local)

| Command | Input | Output | Notes |
|---|---|---|---|
| `checkout_branch` | `{ repo_id, branch }` | — | Materializes a remote branch through a targeted fetch when needed; before switching, returns `checkout_would_overwrite` with at most 100 affected paths if local work would be replaced |
| `stash_and_checkout` | `{ repo_id, branch, operation_id? }` | `string` | Saves tracked and untracked work with a source→target message, checks out the target, never auto-pops, and returns `stash@{0}` |
| `merge_branch` | `{ repo_id, source, mode, dirty_policy, operation_id? }` | `MergeResult` | Cancellable branch merge through system Git; supports local and remote-tracking sources (`P10-MERGE-01`, `P10-MERGE-02`) |
| `squash_merge_branch` | `{ repo_id, source, dirty_policy, operation_id? }` | `SquashMergeResult` | Cancellable `merge --squash` through system Git; shares `get_merge_preflight`'s blockers and dirty-tree policy. Stages the combined diff (or leaves it conflicted) without a merge commit and without moving any ref, so a conflict is a live index read rather than a `RepoOperationState`, and any outcome can be discarded with a plain Reset (Hard) to the returned `targetCommit` (`P10-MERGE-03`) |
| `create_branch` | `{ repo_id, name, checkout }` | — | At current `HEAD` |
| `create_branch_at` | `{ repo_id, name, target, checkout }` | — | At an arbitrary commit |
| `rename_branch` | `{ repo_id, old_name, new_name }` | — | |
| `set_branch_upstream` | `{ repo_id, branch, upstream }` | — | Local config write; `upstream` must name an existing remote-tracking branch |
| `unset_branch_upstream` | `{ repo_id, branch }` | — | Local config write; no network operation |
| `create_tag` | `{ repo_id, name, target }` | — | Lightweight tag |
| `stage_files` / `unstage_files` | `{ repo_id, paths }` | — | Empty `paths` means **all** — one `add_all("*")` over a fresh index. Deliberate for the *Stage all* control, and precisely why a batch action built on a user selection must never dispatch an empty list ([`working-tree-and-diff.md`](working-tree-and-diff.md) §7.2). A non-empty list writes the index once, so batch stage is already atomic |
| `stage_patch` | `{ repo_id, selection, expected_generations }` | `GenerationSet` | Reconstructs the current worktree patch under the write lock; stale generation/digest fails before index mutation; applies with shared system Git `apply --cached` |
| `unstage_patch` | `{ repo_id, selection, expected_generations }` | `GenerationSet` | Reconstructs the current staged patch under the write lock; stale generation/digest fails before index mutation; applies with shared system Git `apply --cached --reverse` |
| `discard_patch` | `{ repo_id, action, selection, expected_generations, confirmation_token }` | `GenerationSet` | Under the write lock, atomically validates and consumes the one-use confirmation before reconstructing the current index-to-worktree patch; any confirmation binding/expiry/replay mismatch is `preflight_stale`; checks then applies with shared system Git `apply --reverse` without writing the index |
| `discard_patches` | `{ repo_id, action, selections, expected_generations, confirmation_token }` | `GenerationSet` | Whole-file worktree batch only. Consumes one token bound to the exact ordered action/selection/digest/generation vector, then checks and applies one byte-path-ordered combined reverse patch under one write lock and one resolved `index.lock`; one stale or invalid member refuses the complete mutation (`P10-WC-MULTI-03`) |
| `export_patch` | `{ repo_id, selections, destination }` | — | Read-only against the repository: validates every member of a non-empty source-homogeneous vector, reuses the `P8-01` patch constructor per file, orders sections byte-lexicographically by path, and writes one combined patch to the caller-chosen `destination`. Patch bytes never cross IPC for this command; a single file is a vector of length one (`P10-WC-03`, `P10-WC-MULTI-03`) |
| `get_patch_text` | `{ repo_id, selections }` | `string` | Same combined bytes as `export_patch`, returned as text for the clipboard follow-up — the only patch command whose content crosses IPC, since the frontend owns the Clipboard API (`P10-WC-03`, `P10-WC-MULTI-03`) |
| `add_ignore_rule` | `{ repo_id, path, rule_kind }` | `IgnoreRuleOutcome` | Appends an exact file, extension, or directory rule to the root `.gitignore`; preserves UTF-8 BOM and dominant line endings, returns `alreadyPresent` without writing duplicates, and advances `working_tree` only on addition |
| `commit_repo` | `{ repo_id, message, amend }` | `string` | New commit id; amend preserves `HEAD`'s author and parents and permits a message-only rewrite; ordinary commit returns `nothing_to_commit` when the index matches `HEAD` |
| `commit_and_push_repo` | `{ repo_id, message, amend, operation_id? }` | `CommitPushResult` | One operation id covers both phases. Once commit succeeds, push failure resolves as a partial outcome (`commitSucceeded: true`, `pushSucceeded: false`, stable `pushErrorCode`) and never rolls the commit back. |
| `cherry_pick` | `{ repo_id, commit_id }` | — | |
| `revert_commit` | `{ repo_id, commit_id }` | — | |
| `create_stash` | `{ repo_id, request: { scope, message, include_untracked } }` | `CreateStashResult` | The only interactive creation command. `All` delegates to `git stash push [-u] -m`; `Paths` constructs exact base/index/worktree/untracked trees through private indexes, uses `write-tree` and `commit-tree` to build the stash object graph, and publishes `refs/stash` via `update-ref` with expected-OID CAS validation. A failed publication independently attempts selected tracked-worktree, selected-untracked, and original-index recovery; complete recovery preserves the primary error, while incomplete recovery returns `stash_recovery_failed` (`P10-STASH-02`) |
| `apply_stash` | `{ repo_id, stash_id, restore_index }` | `StashApplyResult` | Re-resolves immutable `StashId` under the repository write lock and runs system-Git Apply on the current branch. Keeps the entry, returns typed conflict paths from the fresh index, and advances only `working_tree`. |
| `create_branch_from_stash` | `{ repo_id, stash_id, name, apply, keep }` | `CreateBranchFromStashResult` | Requires `keep = true`; safely creates/checks out a local branch at the stash's immutable `base`, optionally applies the selected entry, and always keeps it. Advances `working_tree`, `refs`, and `history`, never `stash`. |
| `stash_paths_supported` | — | `boolean` | Whether the resolved Git supports exact scoped stash creation (Git >= 2.23). Global and non-repo-scoped; `All` is not gated |
| `open_merge_tool` | `{ repo_id }` | — | `git mergetool --no-prompt`; the configured external tool owns resolution |
| `diff_tool_availability` | `{ repo_id }` | `boolean` | Whether `Settings.diff_tool` (or, if unset, Git's own `diff.tool`) currently resolves to something Git can run (`P10-WC-06`) |
| `open_external_diff` | `{ repo_id, path, source }` | — | `git difftool --no-prompt [--tool=<name>] [--cached] -- <path>`; `source` selects the diff side (`P10-WC-06`) |
| `continue_operation` | `{ repo_id, operation_id? }` | `RepoOperationState` | Dispatches to the detected merge/rebase/cherry-pick/revert sequencer and returns its new state; refuses unresolved conflicts |
| `skip_operation` | `{ repo_id, operation_id? }` | `RepoOperationState` | Dispatches to the detected rebase/cherry-pick/revert sequencer and returns its new state |
| `list_remotes` | `{ repo_id }` | `RemoteInfo[]` | Lists configured remotes with URL userinfo redacted before IPC |
| `add_remote` | `{ repo_id, name, url }` | `RemoteInfo` | Local Git config write; refuses duplicate names and never fetches, pushes, or rewrites another remote |

### Remote operations (system Git)

| Command | Input | Output | Notes |
|---|---|---|---|
| `fetch_repo` | `{ repo_id, remote?, operation_id? }` | — | `--progress --prune` |
| `pull_repo` | `{ repo_id, operation_id? }` | — | System fetch + local integration; never `git pull` |
| `push_repo` | `{ repo_id, force_with_lease, expected_generations?, confirmation_token?, operation_id? }` | — | Normal target is resolved from the branch's upstream; `no_upstream` → publish. Force mode requires the one-use preflight token and executes only its backend-bound remote/ref/OIDs. |
| `push_branch_to_remotes` | `{ repo_id, remotes, operation_id? }` | `RemotePushResult[]` | Sequentially pushes the current branch's exact local ref to the same ref on every explicitly selected configured remote. Returns a stable result per remote, continues after ordinary failures, never forces, and never changes upstream. |
| `publish_branch` | `{ repo_id, remote?, operation_id? }` | — | The only operation allowed to name a default remote |
| `bulk_fetch` / `bulk_pull` | `{ workspace_id, operation_id? }` | `BulkRepoResult[]` | Bounded worker pool; per-repo results, one failure does not abort the batch |

### Operations, authentication, and tools

| Command | Input | Output | Notes |
|---|---|---|---|
| `cancel_operation` | `{ operation_id }` | `boolean` | Terminates the Git process tree |
| `answer_git_auth_prompt` | `{ operation_id, prompt_id, value }` | `boolean` | One-use; never persisted or logged |
| `cancel_git_auth_prompt` | `{ operation_id, prompt_id }` | `boolean` | |
| `open_in_ide` | `{ repo_id, ide? }` | — | Falls back to `Settings.default_ide`; allowlisted commands only |
| `open_terminal` | `{ repo_id }` | — | |
| `resolve_repository_file_path` | `{ repo_id, path }` | `RepositoryFilePath` | Canonicalizes a repository-relative file path; rejects traversal, `.git`, absolute paths, and resolved parents outside the repository |
| `open_repository_path` | `{ repo_id, path, target }` | — | Opens a contained file in the configured editor (with optional line) or its OS default application |
| `reveal_repository_path` | `{ repo_id, path }` | — | Reveals a contained file through the platform file manager |
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

| Command | Input | Output | Spec | Task |
|---|---|---|---|---|
| `list_worktrees` / `create_worktree` / `remove_worktree` | — | — | [`workspace-workflows.md`](workspace-workflows.md) §1 | `P10-01`/`P10-02` |
| `start_rebase` | — | — | [`workspace-workflows.md`](workspace-workflows.md) §2 | `P10-04` |
| `set_remote_url` / `rename_remote` / `remove_remote` | — | — | [`workspace-workflows.md`](workspace-workflows.md) §3 | `P10-06` |

One addition already shipped by extending existing shapes rather than adding a
command: `preflight_destructive_action` / `execute_destructive_action` gained
the `DeleteFile { path }` action through the existing enum and executor
([`repository-safety.md`](repository-safety.md) §3, `P10-WC-04`).
`P10-STASH-06` extended the same enum and executor again — `StashPop { id,
restore_index }` replaced the index-keyed variant and `StashDrop { id }` was
added — without adding a destructive command of its own.
`P10-WC-MULTI-03` added `DiscardFiles { paths }` to the same enum. It needs one
new command, `discard_patches`, only because discard carries a `PatchSelection`
payload that the shared `execute_destructive_action` signature does not — exactly
the reason the shipped single-file `discard_patch` already exists
([`working-tree-and-diff.md`](working-tree-and-diff.md) §7.12).

Three former commands were **removed** by `P10-STASH-02` rather than kept
alongside their replacements: `stash_push` and `stash_file` folded into
`create_stash`, and `stash_file_supported` became `stash_paths_supported`.
Pop needed no standalone command — it has always run through
`execute_destructive_action`. `P10-STASH-06` retyped its action on `StashId` and
deleted the dead, test-only `GitBackend::stash_pop` port method.

Every planned command above takes a **repository-relative** path and never a
command line, an executable name, or a shell string; the backend canonicalizes
and validates containment before acting. `merge_branch` takes a typed
`MergeSource` ref, which the backend re-resolves itself.

## Long-running operations: events, not blocking returns

`clone` is workspace-scoped until its successful terminal event supplies the new repository id. `fetch`, `pull`, `push`, `publish`, and repository operation controls are repo-scoped operations; the UI keeps them off the render path while awaiting completion. `bulk_fetch` and `bulk_pull` run through a bounded Tokio worker pool and return per-repo results once the batch completes, so one failed repository does not abort the rest. Progress/cancellation details live in [`operation-events.md`](operation-events.md): the event name is `fjord-operation-progress`, and cancellation is requested with `cancel_operation`.

## Error shape

Every command that can fail returns `Result<T, AppError>` where `AppError = { code, message, diagnostics?, paths?, stash_ref? }` (SDD §8). `stash_ref` is present only when a merge error or cancellation happened after the backend verified that its explicit stash was created; the UI never infers stash retention from the requested dirty policy. `code` is a stable, localizable identifier (`repository_not_found`, `repository_discovery_failed`, `clone_request_invalid`, `clone_destination_invalid`, `clone_destination_exists`, `clone_registration_failed`, `create_repository_request_invalid`, `create_repository_destination_invalid`, `create_repository_destination_not_empty`, `create_repository_registration_failed`, `merge_conflict`, `no_upstream`, `nothing_to_commit`, `merge_tool_failed`, `ide_not_allowed`, `operation_cancelled`, `operation_not_in_progress`, `operation_has_conflicts`, `operation_step_failed`, `preflight_stale`, `patch_stale`, `patch_apply_failed`, `patch_unsupported`, `path_outside_repository`, `path_not_found`, `delete_target_not_a_file`, `delete_file_conflicted`, `delete_file_partially_staged`, plus the `git_*` transport codes in [`system-git-transport.md`](system-git-transport.md)) that the frontend maps through the i18n catalog; `message` is a developer-facing fallback, never shown directly in the UI without going through a translation first. A stale destructive confirmation is never retried automatically.

Planned codes, added with the commands above and listed here so no task invents
its own spelling. A normal Git outcome is never one of these — merge reports
already-up-to-date, fast-forward, merge commit, and conflict as typed results
([`branch-merge.md`](branch-merge.md) §6):

- Merge (`P10-MERGE-01`): `merge_source_not_found`,
  `merge_source_is_current_branch`, `merge_source_unsupported`,
  `merge_not_fast_forward`, `merge_would_overwrite`,
  `merge_index_has_staged_changes`, `merge_detached_head`, `merge_unborn_head`,
  `merge_failed`, and the shared `operation_already_in_progress` (which
  `start_rebase` also uses). `squash_merge_branch` (`P10-MERGE-03`) reuses this
  same set except `merge_not_fast_forward`, which has no squash equivalent —
  a conflicting squash is a typed `Conflicted { paths }` result, not an error,
  exactly like a conflicting merge.
- Remaining working-file actions (`P10-WC-02`, `P10-WC-03`, `P10-WC-05`,
  `P10-WC-06`): `ignore_rule_unsupported_for_tracked_file`,
  `ignore_file_encoding_unsupported`, `ignore_write_failed`,
  `patch_export_failed`, `stash_file_unsupported_git`, `stash_file_conflicted`,
  `diff_tool_not_configured`, `diff_tool_name_invalid`, plus the existing
  `ide_not_allowed`. (These shipped with `P10-WC-02`–`P10-WC-06`; the list is
  retained here as the record of their spelling. `stash_file_unsupported_git` is
  the shipped spelling — an earlier draft of this list said
  `stash_file_unsupported`, which never existed in code or in any locale.)
- Stash management (`P10-STASH-01`–`P10-STASH-06`,
  [`stash-management.md`](stash-management.md) §10): `stash_not_found`,
  `stash_ambiguous`, `stash_scope_empty`, `stash_concurrent_update`,
  `stash_recovery_failed`, `stash_scope_unrepresentable` (carries the requested
  offending semantic target in `paths`), `stash_apply_would_overwrite` (carries
  bounded `paths`), `stash_apply_index_refused`, `stash_apply_failed`. The
  existing `nothing_to_stash`, `stash_file_conflicted`, and
  `stash_file_unsupported_git` are reused unchanged; `stash_empty` is retired
  with the dead `GitBackend::stash_pop` method. A conflicting stash apply or pop
  is a typed `StashApplyOutcome::Conflicted { paths }` result, never an error.

`delete_file_partially_staged` and `delete_file_conflicted` are also
`DestructivePreflight.blockers` values: they disable confirmation so no token is
ever issued, and execution re-checks them under the repository write lock — a
disabled menu entry is never the guarantee
([`working-tree-and-diff.md`](working-tree-and-diff.md) §6.1, §6.5).

## What's not a command

Anything that's pure frontend state (which rows are selected in Working Changes, which row is selected in the commit graph, whether the command palette is open) — that stays in `application/` view-state, never round-trips through IPC. UI state that *must* survive a restart is the documented exception and goes through `get_ui_state`/`update_ui_state` ([`ui-shell.md`](ui-shell.md) §5), not through per-feature commands.
