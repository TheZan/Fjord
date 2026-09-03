use fjord_domain::{
    BranchInfo, BulkRepoResult, CommitPage, CommitPushResult, CommitSummary,
    CreateBranchFromStashResult, CreateStashRequest, CreateStashResult, DestructiveAction,
    DestructiveExecutionResult, DestructivePreflight, FileDiff, FileDiffWindow, GenerationSet,
    GitConnectionTestResult, GlobalSearchResult, IgnoreRuleKind, IgnoreRuleOutcome,
    IgnoreRulePreview, LogCursor, MergeDirtyPolicy, MergeMode, MergePreflight, MergeResult,
    MergeSource, OpenTarget, PatchSelection, PatchSource, ReflogPage, RemoteInfo, RemotePushResult,
    RemoveRemotePreflight, RepoOperationState, RepoStatus, RepositoryFilePath, RepositoryId,
    SnapshotRevalidation, SquashMergeResult, StashApplyResult, StashEntry, StashFileGroup,
    StashFiles, StashId, StoredRepositorySnapshot, TagInfo, WorkingChanges, WorkspaceId,
};
use serde::Serialize;
use std::future::Future;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::AppHandle;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

use crate::error::AppError;
use crate::interaction_traces::TracedState as State;
use crate::operations::{
    emit_operation, OperationKind, OperationProgress, OperationRegistry, OperationScope,
    OperationStatus,
};
use crate::state::AppState;

const BULK_WORKER_LIMIT: usize = 6;

#[tauri::command]
pub async fn list_remotes(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
) -> Result<Vec<RemoteInfo>, AppError> {
    Ok(state.repos.list_remotes(repo_id).await?)
}

#[tauri::command]
pub async fn add_remote(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    name: String,
    url: String,
) -> Result<RemoteInfo, AppError> {
    Ok(state.repos.add_remote(repo_id, &name, &url).await?)
}

#[tauri::command]
pub async fn set_remote_url(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    name: String,
    fetch: String,
    push: Option<String>,
) -> Result<RemoteInfo, AppError> {
    Ok(state
        .repos
        .set_remote_url(repo_id, &name, &fetch, push.as_deref())
        .await?)
}

#[tauri::command]
pub async fn rename_remote(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    old: String,
    new: String,
) -> Result<RemoteInfo, AppError> {
    Ok(state.repos.rename_remote(repo_id, &old, &new).await?)
}

#[tauri::command]
pub async fn preflight_remove_remote(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    name: String,
) -> Result<RemoveRemotePreflight, AppError> {
    Ok(state.repos.preflight_remove_remote(repo_id, &name).await?)
}

#[tauri::command]
pub async fn remove_remote(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    name: String,
    expected_config_generation: u64,
    confirmation_token: String,
) -> Result<(), AppError> {
    Ok(state
        .repos
        .remove_remote(
            repo_id,
            &name,
            expected_config_generation,
            &confirmation_token,
        )
        .await?)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationEnvelope<T> {
    data: T,
    generations: GenerationSet,
}

async fn versioned<T>(
    state: &AppState,
    repo_id: RepositoryId,
    data: T,
) -> Result<GenerationEnvelope<T>, AppError> {
    Ok(GenerationEnvelope {
        data,
        generations: state.repos.get_generations(repo_id).await?,
    })
}

#[tauri::command]
pub async fn get_branches(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
) -> Result<GenerationEnvelope<Vec<BranchInfo>>, AppError> {
    let data = state.repos.get_branches(repo_id).await?;
    versioned(&state, repo_id, data).await
}

#[tauri::command]
pub async fn get_merge_preflight(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    source: MergeSource,
) -> Result<GenerationEnvelope<MergePreflight>, AppError> {
    let data = state.repos.get_merge_preflight(repo_id, &source).await?;
    Ok(GenerationEnvelope {
        generations: data.generations,
        data,
    })
}

#[tauri::command]
pub async fn merge_branch(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    source: MergeSource,
    mode: MergeMode,
    dirty_policy: MergeDirtyPolicy,
    operation_id: Option<String>,
) -> Result<MergeResult, AppError> {
    run_repo_operation(
        &app,
        &state,
        operation_id,
        OperationKind::Merge,
        repo_id,
        |context| {
            state
                .repos
                .merge_branch_with_context(repo_id, &source, mode, dirty_policy, context)
        },
    )
    .await
}

#[tauri::command]
pub async fn squash_merge_branch(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    source: MergeSource,
    dirty_policy: MergeDirtyPolicy,
    operation_id: Option<String>,
) -> Result<SquashMergeResult, AppError> {
    run_repo_operation(
        &app,
        &state,
        operation_id,
        OperationKind::SquashMerge,
        repo_id,
        |context| {
            state
                .repos
                .squash_merge_branch_with_context(repo_id, &source, dirty_policy, context)
        },
    )
    .await
}

#[tauri::command]
pub async fn get_tags(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
) -> Result<GenerationEnvelope<Vec<TagInfo>>, AppError> {
    let data = state.repos.get_tags(repo_id).await?;
    versioned(&state, repo_id, data).await
}

#[tauri::command]
pub async fn get_repo_status(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
) -> Result<GenerationEnvelope<RepoStatus>, AppError> {
    let data = state.repos.get_status(repo_id).await?;
    versioned(&state, repo_id, data).await
}

#[tauri::command]
pub async fn get_repo_operation_state(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
) -> Result<GenerationEnvelope<RepoOperationState>, AppError> {
    let data = state.repos.get_operation_state(repo_id).await?;
    versioned(&state, repo_id, data).await
}

#[tauri::command]
pub async fn get_rebase_preflight(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    onto: MergeSource,
) -> Result<GenerationEnvelope<fjord_domain::RebasePreflight>, AppError> {
    let data = state.repos.get_rebase_preflight(repo_id, &onto).await?;
    Ok(GenerationEnvelope {
        generations: data.generations,
        data,
    })
}

#[tauri::command]
pub async fn start_rebase(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    preflight: fjord_domain::RebasePreflight,
    dirty_policy: MergeDirtyPolicy,
    operation_id: Option<String>,
) -> Result<fjord_domain::RebaseResult, AppError> {
    state.repos.revalidate_repository_snapshot(repo_id).await?;
    run_repo_operation(
        &app,
        &state,
        operation_id,
        OperationKind::Rebase,
        repo_id,
        |context| {
            state
                .repos
                .start_rebase_preflighted(repo_id, &preflight, dirty_policy, context)
        },
    )
    .await
}

#[tauri::command]
pub async fn continue_operation(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    operation_id: Option<String>,
) -> Result<RepoOperationState, AppError> {
    run_repo_operation(
        &app,
        &state,
        operation_id,
        OperationKind::ContinueOperation,
        repo_id,
        |context| {
            state
                .repos
                .continue_operation_with_context(repo_id, context)
        },
    )
    .await
}

#[tauri::command]
pub async fn skip_operation(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    operation_id: Option<String>,
) -> Result<RepoOperationState, AppError> {
    run_repo_operation(
        &app,
        &state,
        operation_id,
        OperationKind::SkipOperation,
        repo_id,
        |context| state.repos.skip_operation_with_context(repo_id, context),
    )
    .await
}

#[tauri::command]
pub async fn get_repository_snapshot(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
) -> Result<Option<StoredRepositorySnapshot>, AppError> {
    Ok(state.repos.load_repository_snapshot(repo_id).await?)
}

#[tauri::command]
pub async fn capture_repository_snapshot(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
) -> Result<StoredRepositorySnapshot, AppError> {
    Ok(state.repos.capture_repository_snapshot(repo_id).await?)
}

#[tauri::command]
pub async fn revalidate_repository_snapshot(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
) -> Result<SnapshotRevalidation, AppError> {
    Ok(state.repos.revalidate_repository_snapshot(repo_id).await?)
}

#[tauri::command]
pub async fn get_commit_log(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    cursor: Option<LogCursor>,
    limit: u32,
) -> Result<GenerationEnvelope<CommitPage>, AppError> {
    let data = state.repos.get_commit_log(repo_id, cursor, limit).await?;
    versioned(&state, repo_id, data).await
}

#[tauri::command]
pub async fn get_reflog(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    ref_name: Option<String>,
    cursor: Option<LogCursor>,
    limit: u32,
) -> Result<GenerationEnvelope<ReflogPage>, AppError> {
    let data = state
        .repos
        .get_reflog(repo_id, ref_name.as_deref(), cursor, limit)
        .await?;
    versioned(&state, repo_id, data).await
}

#[tauri::command]
pub async fn get_reflog_refs(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
) -> Result<GenerationEnvelope<Vec<String>>, AppError> {
    let data = state.repos.get_reflog_refs(repo_id).await?;
    versioned(&state, repo_id, data).await
}

#[tauri::command]
pub async fn search_commit_log(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    query: String,
    limit: u32,
) -> Result<GenerationEnvelope<Vec<CommitSummary>>, AppError> {
    let data = state
        .repos
        .search_commit_log(repo_id, &query, limit)
        .await?;
    versioned(&state, repo_id, data).await
}

#[tauri::command]
pub async fn global_search(
    state: State<'_, AppState>,
    workspace_id: Option<WorkspaceId>,
    query: String,
    limit: u32,
) -> Result<Vec<GlobalSearchResult>, AppError> {
    Ok(state
        .repos
        .global_search(workspace_id, &query, limit)
        .await?)
}

#[tauri::command]
pub async fn get_commit_diff(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    commit_id: String,
) -> Result<GenerationEnvelope<Vec<FileDiff>>, AppError> {
    let data = state.repos.get_commit_diff(repo_id, &commit_id).await?;
    versioned(&state, repo_id, data).await
}

#[tauri::command]
pub async fn get_recovery_diff(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    commit_id: String,
) -> Result<GenerationEnvelope<Vec<FileDiff>>, AppError> {
    let data = state.repos.get_recovery_diff(repo_id, &commit_id).await?;
    versioned(&state, repo_id, data).await
}

#[tauri::command]
pub async fn get_commit_files(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    commit_id: String,
) -> Result<GenerationEnvelope<Vec<FileDiff>>, AppError> {
    let data = state.repos.get_commit_files(repo_id, &commit_id).await?;
    versioned(&state, repo_id, data).await
}

// Keep the documented IPC payload flat; grouping only these fields would make
// the frontend contract nested without simplifying the adapter.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn get_file_diff(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    commit_id: String,
    path: String,
    offset: u32,
    limit: u32,
    whitespace: fjord_domain::DiffWhitespaceMode,
    load_anyway: bool,
) -> Result<GenerationEnvelope<FileDiffWindow>, AppError> {
    let data = state
        .repos
        .get_file_diff(
            repo_id,
            &commit_id,
            &path,
            fjord_services::DiffRequestOptions {
                offset,
                limit,
                whitespace,
                load_anyway,
            },
        )
        .await?;
    versioned(&state, repo_id, data).await
}

#[tauri::command]
pub async fn checkout_branch(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    branch: String,
) -> Result<(), AppError> {
    let operation_id = OperationRegistry::next_id();
    let askpass = state.begin_askpass_operation(
        &operation_id,
        state.repos.repository_name(repo_id).await,
        Some("checkout-remote-branch".to_string()),
    );
    let result = state
        .repos
        .checkout_branch_with_context(
            repo_id,
            &branch,
            fjord_ports::GitOperationContext::default().with_askpass(askpass),
        )
        .await;
    state.askpass.finish_operation(&operation_id);
    Ok(result?)
}

#[tauri::command]
pub async fn stash_and_checkout(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    branch: String,
    operation_id: Option<String>,
) -> Result<String, AppError> {
    run_repo_operation(
        &app,
        &state,
        operation_id,
        OperationKind::StashCheckout,
        repo_id,
        |context| {
            state
                .repos
                .stash_and_checkout_with_context(repo_id, &branch, context)
        },
    )
    .await
}

#[tauri::command]
pub async fn get_working_changes(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
) -> Result<GenerationEnvelope<WorkingChanges>, AppError> {
    let data = state.repos.get_working_changes(repo_id).await?;
    versioned(&state, repo_id, data).await
}

// This mirrors `get_file_diff` so committed and working windows keep one flat
// transport shape.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn get_working_file_diff(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    path: String,
    staged: bool,
    offset: u32,
    limit: u32,
    whitespace: fjord_domain::DiffWhitespaceMode,
    load_anyway: bool,
) -> Result<GenerationEnvelope<FileDiffWindow>, AppError> {
    let (data, generations) = state
        .repos
        .get_working_file_diff_versioned(
            repo_id,
            &path,
            staged,
            fjord_services::DiffRequestOptions {
                offset,
                limit,
                whitespace,
                load_anyway,
            },
        )
        .await?;
    Ok(GenerationEnvelope { data, generations })
}

#[tauri::command]
pub async fn preflight_destructive_action(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    action: DestructiveAction,
    patch_selections: Option<Vec<PatchSelection>>,
) -> Result<DestructivePreflight, AppError> {
    Ok(state
        .repos
        .preflight_destructive_action(repo_id, action, patch_selections)
        .await?)
}

#[tauri::command]
pub async fn execute_destructive_action(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    action: DestructiveAction,
    expected_generations: GenerationSet,
    confirmation_token: String,
    operation_id: Option<String>,
) -> Result<DestructiveExecutionResult, AppError> {
    run_repo_operation(
        &app,
        &state,
        operation_id,
        OperationKind::DestructiveAction,
        repo_id,
        |context| {
            state.repos.execute_destructive_action(
                repo_id,
                &action,
                expected_generations,
                &confirmation_token,
                context,
            )
        },
    )
    .await
}

#[tauri::command]
pub async fn create_branch(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    name: String,
    checkout: bool,
) -> Result<(), AppError> {
    Ok(state.repos.create_branch(repo_id, &name, checkout).await?)
}

#[tauri::command]
pub async fn create_branch_at(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    name: String,
    target: String,
    checkout: bool,
) -> Result<(), AppError> {
    Ok(state
        .repos
        .create_branch_at(repo_id, &name, &target, checkout)
        .await?)
}

#[tauri::command]
pub async fn rename_branch(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    old_name: String,
    new_name: String,
) -> Result<(), AppError> {
    Ok(state
        .repos
        .rename_branch(repo_id, &old_name, &new_name)
        .await?)
}

#[tauri::command]
pub async fn set_branch_upstream(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    branch: String,
    upstream: String,
) -> Result<(), AppError> {
    Ok(state
        .repos
        .set_branch_upstream(repo_id, &branch, &upstream)
        .await?)
}

#[tauri::command]
pub async fn unset_branch_upstream(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    branch: String,
) -> Result<(), AppError> {
    Ok(state.repos.unset_branch_upstream(repo_id, &branch).await?)
}

#[tauri::command]
pub async fn create_tag(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    name: String,
    target: String,
) -> Result<(), AppError> {
    Ok(state.repos.create_tag(repo_id, &name, &target).await?)
}

#[tauri::command]
pub async fn cherry_pick(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    commit_id: String,
) -> Result<(), AppError> {
    Ok(state.repos.cherry_pick(repo_id, &commit_id).await?)
}

#[tauri::command]
pub async fn revert_commit(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    commit_id: String,
) -> Result<(), AppError> {
    Ok(state.repos.revert(repo_id, &commit_id).await?)
}

#[tauri::command]
pub async fn get_stashes(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
) -> Result<GenerationEnvelope<Vec<StashEntry>>, AppError> {
    let data = state.repos.get_stashes(repo_id).await?;
    versioned(&state, repo_id, data).await
}

#[tauri::command]
pub async fn get_stash_files(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    stash_id: StashId,
) -> Result<GenerationEnvelope<StashFiles>, AppError> {
    let data = state.repos.get_stash_files(repo_id, &stash_id).await?;
    versioned(&state, repo_id, data).await
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn get_stash_file_diff(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    stash_id: StashId,
    group: StashFileGroup,
    path: String,
    offset: u32,
    limit: u32,
    whitespace: fjord_domain::DiffWhitespaceMode,
    load_anyway: bool,
) -> Result<GenerationEnvelope<FileDiffWindow>, AppError> {
    let data = state
        .repos
        .get_stash_file_diff(
            repo_id,
            &stash_id,
            group,
            &path,
            fjord_services::DiffRequestOptions {
                offset,
                limit,
                whitespace,
                load_anyway,
            },
        )
        .await?;
    versioned(&state, repo_id, data).await
}

#[tauri::command]
pub async fn create_stash(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    request: CreateStashRequest,
) -> Result<CreateStashResult, AppError> {
    Ok(state.repos.create_stash(repo_id, request).await?)
}

#[tauri::command]
pub async fn apply_stash(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    stash_id: StashId,
    restore_index: bool,
) -> Result<StashApplyResult, AppError> {
    Ok(state
        .repos
        .apply_stash(repo_id, &stash_id, restore_index)
        .await?)
}

#[tauri::command]
pub async fn create_branch_from_stash(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    stash_id: StashId,
    name: String,
    apply: bool,
    keep: bool,
) -> Result<CreateBranchFromStashResult, AppError> {
    Ok(state
        .repos
        .create_branch_from_stash(repo_id, &stash_id, &name, apply, keep)
        .await?)
}

#[tauri::command]
pub async fn open_terminal(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
) -> Result<(), AppError> {
    Ok(state.repos.open_terminal(repo_id).await?)
}

#[tauri::command]
pub async fn resolve_repository_file_path(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    path: String,
) -> Result<RepositoryFilePath, AppError> {
    Ok(state
        .repos
        .resolve_repository_file_path(repo_id, &path)
        .await?)
}

#[tauri::command]
pub async fn open_repository_path(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    path: String,
    target: OpenTarget,
) -> Result<(), AppError> {
    Ok(state
        .repos
        .open_repository_path(repo_id, &path, target)
        .await?)
}

#[tauri::command]
pub async fn reveal_repository_path(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    path: String,
) -> Result<(), AppError> {
    Ok(state.repos.reveal_repository_path(repo_id, &path).await?)
}

#[tauri::command]
pub async fn preview_ignore_rule(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    path: String,
    rule_kind: IgnoreRuleKind,
) -> Result<IgnoreRulePreview, AppError> {
    Ok(state
        .repos
        .preview_ignore_rule(repo_id, &path, rule_kind)
        .await?)
}

#[tauri::command]
pub async fn add_ignore_rule(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    path: String,
    rule_kind: IgnoreRuleKind,
) -> Result<IgnoreRuleOutcome, AppError> {
    Ok(state
        .repos
        .add_ignore_rule(repo_id, &path, rule_kind)
        .await?)
}

#[tauri::command]
pub async fn stage_files(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    paths: Vec<PathBuf>,
) -> Result<(), AppError> {
    Ok(state.repos.stage_files(repo_id, &paths).await?)
}

#[tauri::command]
pub async fn stage_patch(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    selection: PatchSelection,
    expected_generations: GenerationSet,
) -> Result<GenerationSet, AppError> {
    Ok(state
        .repos
        .stage_patch(repo_id, &selection, expected_generations)
        .await?)
}

#[tauri::command]
pub async fn unstage_files(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    paths: Vec<PathBuf>,
) -> Result<(), AppError> {
    Ok(state.repos.unstage_files(repo_id, &paths).await?)
}

#[tauri::command]
pub async fn unstage_patch(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    selection: PatchSelection,
    expected_generations: GenerationSet,
) -> Result<GenerationSet, AppError> {
    Ok(state
        .repos
        .unstage_patch(repo_id, &selection, expected_generations)
        .await?)
}

#[tauri::command]
pub async fn discard_patch(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    action: DestructiveAction,
    selection: PatchSelection,
    expected_generations: GenerationSet,
    confirmation_token: String,
) -> Result<GenerationSet, AppError> {
    Ok(state
        .repos
        .discard_patch(
            repo_id,
            &action,
            &selection,
            expected_generations,
            &confirmation_token,
        )
        .await?)
}

#[tauri::command]
pub async fn discard_patches(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    action: DestructiveAction,
    selections: Vec<PatchSelection>,
    expected_generations: GenerationSet,
    confirmation_token: String,
) -> Result<GenerationSet, AppError> {
    Ok(state
        .repos
        .discard_patches(
            repo_id,
            &action,
            &selections,
            expected_generations,
            &confirmation_token,
        )
        .await?)
}

/// Writes a working-file patch to a user-chosen destination. Bytes come
/// entirely from the shared `P8-01` patch constructor and are never
/// returned over IPC or logged — only path/byte counts would ever appear in
/// diagnostics, and this command emits none.
#[tauri::command]
pub async fn export_patch(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    selections: Vec<PatchSelection>,
    destination: PathBuf,
) -> Result<(), AppError> {
    let bytes = state.repos.export_patch(repo_id, &selections).await?;
    tokio::fs::write(&destination, &bytes)
        .await
        .map_err(|error| AppError::patch_export_failed(format!("could not write patch: {error}")))
}

/// The same patch bytes as `export_patch`, returned as text for the
/// clipboard follow-up — the only path where patch content legitimately
/// crosses IPC, since the frontend owns the Clipboard API.
#[tauri::command]
pub async fn get_patch_text(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    selections: Vec<PatchSelection>,
) -> Result<String, AppError> {
    let bytes = state.repos.export_patch(repo_id, &selections).await?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[tauri::command]
pub async fn get_amend_info(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
) -> Result<fjord_domain::AmendInfo, AppError> {
    Ok(state.repos.amend_info(repo_id).await?)
}

#[tauri::command]
pub async fn commit_repo(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    message: String,
    amend: bool,
) -> Result<String, AppError> {
    Ok(state.repos.commit(repo_id, &message, amend).await?)
}

#[tauri::command]
pub async fn commit_and_push_repo(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    message: String,
    amend: bool,
    operation_id: Option<String>,
) -> Result<CommitPushResult, AppError> {
    run_commit_and_push_operation(app, state, repo_id, message, amend, operation_id).await
}

async fn run_commit_and_push_operation(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    message: String,
    amend: bool,
    operation_id: Option<String>,
) -> Result<CommitPushResult, AppError> {
    let operation_id = operation_id.unwrap_or_else(OperationRegistry::next_id);
    let guard = state.operations.begin(operation_id);
    let kind = OperationKind::CommitPush;
    let scope = OperationScope::Repo { repo_id };
    emit_operation(
        &app,
        OperationProgress {
            operation_id: guard.id().to_string(),
            kind,
            scope: scope.clone(),
            status: OperationStatus::Started,
            repo_id: Some(repo_id),
            completed: 0,
            total: 2,
            message: Some("commit".to_string()),
            error: None,
        },
    );

    if guard.is_cancelled() {
        emit_operation(
            &app,
            OperationProgress {
                operation_id: guard.id().to_string(),
                kind,
                scope,
                status: OperationStatus::Cancelled,
                repo_id: Some(repo_id),
                completed: 0,
                total: 2,
                message: Some("commit-not-started".to_string()),
                error: None,
            },
        );
        return Err(AppError::operation_cancelled());
    }

    let askpass = state.begin_askpass_operation(
        guard.id(),
        state.repos.repository_name(repo_id).await,
        Some(kind.as_str().to_string()),
    );
    let context = guard
        .git_context(app.clone(), kind, scope.clone(), repo_id)
        .with_askpass(askpass);
    let outcome = state
        .repos
        .commit_and_push_with_context(repo_id, &message, amend, context)
        .await;
    state.askpass.finish_operation(guard.id());

    match outcome {
        Err(error) => {
            let error = AppError::from(error);
            emit_operation(
                &app,
                OperationProgress {
                    operation_id: guard.id().to_string(),
                    kind,
                    scope,
                    status: if error.code == "operation_cancelled" {
                        OperationStatus::Cancelled
                    } else {
                        OperationStatus::Failed
                    },
                    repo_id: Some(repo_id),
                    completed: 0,
                    total: 2,
                    message: Some("commit-failed".to_string()),
                    error: error
                        .diagnostics
                        .as_deref()
                        .cloned()
                        .or_else(|| Some(error.message.clone())),
                },
            );
            Err(error)
        }
        Ok(outcome) => {
            let push_error = outcome.push_error.map(AppError::from);
            let result = CommitPushResult {
                commit_id: outcome.commit_id,
                commit_succeeded: true,
                push_succeeded: push_error.is_none(),
                push_error_code: push_error.as_ref().map(|error| error.code.clone()),
            };
            let status = match push_error.as_ref() {
                None => OperationStatus::Succeeded,
                Some(error) if error.code == "operation_cancelled" => OperationStatus::Cancelled,
                Some(_) => OperationStatus::Failed,
            };
            emit_operation(
                &app,
                OperationProgress {
                    operation_id: guard.id().to_string(),
                    kind,
                    scope,
                    status,
                    repo_id: Some(repo_id),
                    completed: if result.push_succeeded { 2 } else { 1 },
                    total: 2,
                    message: Some(if result.push_succeeded {
                        "commit-and-push-succeeded".to_string()
                    } else {
                        "commit-succeeded-push-failed".to_string()
                    }),
                    error: push_error.as_ref().and_then(|error| {
                        error
                            .diagnostics
                            .as_deref()
                            .cloned()
                            .or_else(|| Some(error.message.clone()))
                    }),
                },
            );
            Ok(result)
        }
    }
}

#[tauri::command]
pub async fn fetch_repo(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    remote: Option<String>,
    operation_id: Option<String>,
) -> Result<(), AppError> {
    run_repo_operation(
        &app,
        &state,
        operation_id,
        OperationKind::Fetch,
        repo_id,
        |context| {
            state
                .repos
                .fetch_with_context(repo_id, remote.as_deref().unwrap_or("origin"), context)
        },
    )
    .await
}

#[tauri::command]
pub async fn pull_repo(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    operation_id: Option<String>,
) -> Result<(), AppError> {
    run_repo_operation(
        &app,
        &state,
        operation_id,
        OperationKind::Pull,
        repo_id,
        |context| state.repos.pull_with_context(repo_id, context),
    )
    .await
}

#[tauri::command]
pub async fn push_repo(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    force_with_lease: bool,
    expected_generations: Option<GenerationSet>,
    confirmation_token: Option<String>,
    operation_id: Option<String>,
) -> Result<(), AppError> {
    let repos = state.repos.clone();
    run_repo_operation(
        &app,
        &state,
        operation_id,
        OperationKind::Push,
        repo_id,
        |context| async move {
            if force_with_lease {
                let generations =
                    expected_generations.ok_or(fjord_ports::GitError::PreflightStale)?;
                let token = confirmation_token
                    .as_deref()
                    .ok_or(fjord_ports::GitError::PreflightStale)?;
                repos
                    .force_push_with_context(repo_id, generations, token, context)
                    .await
            } else {
                repos.push_with_context(repo_id, context).await
            }
        },
    )
    .await
}

/// Pushes the current branch to multiple explicitly selected remotes without
/// changing its configured upstream. Ordinary failures are reported per
/// destination so a successful mirror push is never hidden by another remote.
#[tauri::command]
pub async fn push_branch_to_remotes(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    remotes: Vec<String>,
    operation_id: Option<String>,
) -> Result<Vec<RemotePushResult>, AppError> {
    run_repo_operation(
        &app,
        &state,
        operation_id,
        OperationKind::Push,
        repo_id,
        |context| {
            let repos = state.repos.clone();
            let remotes = remotes.clone();
            async move {
                repos
                    .push_branch_to_remotes_with_context(repo_id, &remotes, context)
                    .await
            }
        },
    )
    .await
}

/// Publishes a branch that has no upstream yet. Separate from `push_repo`
/// because it is the user's explicit answer to `no_upstream`.
#[tauri::command]
pub async fn publish_branch(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    remote: Option<String>,
    operation_id: Option<String>,
) -> Result<(), AppError> {
    run_repo_operation(
        &app,
        &state,
        operation_id,
        OperationKind::Publish,
        repo_id,
        |context| {
            let repos = state.repos.clone();
            let remote = remote.clone();
            async move {
                repos
                    .publish_branch_with_context(repo_id, remote.as_deref(), context)
                    .await
            }
        },
    )
    .await
}

#[tauri::command]
pub async fn open_merge_tool(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
) -> Result<(), AppError> {
    Ok(state.repos.open_merge_tool(repo_id).await?)
}

#[tauri::command]
pub async fn diff_tool_availability(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
) -> Result<bool, AppError> {
    Ok(state.repos.diff_tool_availability(repo_id).await?)
}

#[tauri::command]
pub async fn open_external_diff(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    path: String,
    source: PatchSource,
) -> Result<(), AppError> {
    Ok(state
        .repos
        .open_external_diff(repo_id, &path, source)
        .await?)
}

#[tauri::command]
pub async fn stash_paths_supported(state: State<'_, AppState>) -> Result<bool, AppError> {
    Ok(state.repos.stash_paths_supported().await?)
}

#[tauri::command]
pub async fn open_in_ide(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    ide: Option<String>,
) -> Result<(), AppError> {
    Ok(state.repos.open_in_ide(repo_id, ide.as_deref()).await?)
}

#[tauri::command]
pub async fn bulk_fetch(
    app: AppHandle,
    state: State<'_, AppState>,
    workspace_id: WorkspaceId,
    operation_id: Option<String>,
) -> Result<Vec<BulkRepoResult>, AppError> {
    run_bulk_operation(
        app,
        state,
        operation_id,
        OperationKind::BulkFetch,
        BulkGitOperation::Fetch,
        workspace_id,
    )
    .await
}

#[tauri::command]
pub async fn bulk_pull(
    app: AppHandle,
    state: State<'_, AppState>,
    workspace_id: WorkspaceId,
    operation_id: Option<String>,
) -> Result<Vec<BulkRepoResult>, AppError> {
    run_bulk_operation(
        app,
        state,
        operation_id,
        OperationKind::BulkPull,
        BulkGitOperation::Pull,
        workspace_id,
    )
    .await
}

#[tauri::command]
pub async fn bulk_open_in_ide(
    state: State<'_, AppState>,
    workspace_id: WorkspaceId,
    ide: Option<String>,
) -> Result<Vec<BulkRepoResult>, AppError> {
    Ok(state
        .repos
        .bulk_open_in_ide(workspace_id, ide.as_deref())
        .await?)
}

#[tauri::command]
pub async fn cancel_operation(
    state: State<'_, AppState>,
    operation_id: String,
) -> Result<bool, AppError> {
    let cancelled = state.operations.cancel(&operation_id);
    state.askpass.cancel_operation(&operation_id);
    Ok(cancelled)
}

#[tauri::command]
pub async fn test_git_connection(
    state: State<'_, AppState>,
    repo_id: RepositoryId,
    remote: Option<String>,
) -> Result<GitConnectionTestResult, AppError> {
    let operation_id = OperationRegistry::next_id();
    let askpass = state.begin_askpass_operation(
        &operation_id,
        state.repos.repository_name(repo_id).await,
        Some("connection-test".to_string()),
    );
    let result = state
        .repos
        .test_git_connection_with_context(
            repo_id,
            remote.as_deref().unwrap_or("origin"),
            fjord_ports::GitOperationContext::default().with_askpass(askpass),
        )
        .await;
    state.askpass.finish_operation(&operation_id);
    Ok(result?)
}

async fn run_repo_operation<T, Fut>(
    app: &AppHandle,
    state: &AppState,
    operation_id: Option<String>,
    kind: OperationKind,
    repo_id: RepositoryId,
    run: impl FnOnce(fjord_ports::GitOperationContext) -> Fut,
) -> Result<T, AppError>
where
    Fut: Future<Output = Result<T, fjord_services::RepoError>>,
{
    let operation_id = operation_id.unwrap_or_else(OperationRegistry::next_id);
    let guard = state.operations.begin(operation_id);
    let scope = OperationScope::Repo { repo_id };
    let total = if matches!(
        kind,
        OperationKind::Merge | OperationKind::SquashMerge | OperationKind::Rebase
    ) {
        0
    } else {
        1
    };
    emit_operation(
        app,
        OperationProgress {
            operation_id: guard.id().to_string(),
            kind,
            scope: scope.clone(),
            status: OperationStatus::Started,
            repo_id: Some(repo_id),
            completed: 0,
            total,
            message: None,
            error: None,
        },
    );

    let askpass = state.begin_askpass_operation(
        guard.id(),
        state.repos.repository_name(repo_id).await,
        Some(kind.as_str().to_string()),
    );
    let context = guard
        .git_context(app.clone(), kind, scope.clone(), repo_id)
        .with_askpass(askpass);
    let result = if guard.is_cancelled() {
        Err(AppError::operation_cancelled())
    } else {
        let result = run(context).await.map_err(AppError::from);
        if guard.is_cancelled() {
            Err(AppError::operation_cancelled())
        } else {
            result
        }
    };

    state.askpass.finish_operation(guard.id());
    let (status, completed, error) = match &result {
        Ok(_) => (OperationStatus::Succeeded, total, None),
        Err(error) if error.code == "operation_cancelled" => (OperationStatus::Cancelled, 0, None),
        Err(error) => (
            OperationStatus::Failed,
            0,
            error
                .diagnostics
                .as_deref()
                .cloned()
                .or_else(|| Some(error.message.clone())),
        ),
    };

    emit_operation(
        app,
        OperationProgress {
            operation_id: guard.id().to_string(),
            kind,
            scope,
            status,
            repo_id: Some(repo_id),
            completed,
            total,
            message: None,
            error,
        },
    );

    result
}

#[derive(Clone, Copy)]
enum BulkGitOperation {
    Fetch,
    Pull,
}

async fn run_bulk_operation(
    app: AppHandle,
    state: State<'_, AppState>,
    operation_id: Option<String>,
    kind: OperationKind,
    operation: BulkGitOperation,
    workspace_id: WorkspaceId,
) -> Result<Vec<BulkRepoResult>, AppError> {
    let operation_id = operation_id.unwrap_or_else(OperationRegistry::next_id);
    let guard = state.operations.begin(operation_id);
    let scope = OperationScope::Workspace { workspace_id };
    let repos = state.workspaces.list_repositories(workspace_id).await?;
    let total = repos.len() as u32;

    emit_operation(
        &app,
        OperationProgress {
            operation_id: guard.id().to_string(),
            kind,
            scope: scope.clone(),
            status: OperationStatus::Started,
            repo_id: None,
            completed: 0,
            total,
            message: None,
            error: None,
        },
    );

    let semaphore = Arc::new(Semaphore::new(BULK_WORKER_LIMIT));
    let mut tasks = JoinSet::new();

    for repo in repos {
        let permit = tokio::select! {
            _ = guard.cancelled() => break,
            permit = semaphore.clone().acquire_owned() => {
                permit.expect("bulk semaphore should stay open")
            }
        };
        let repo_id = repo.id;
        let service = state.repos.clone();
        // A prompt during a bulk run has to say which repository is asking,
        // so every repository gets its own session under the bulk operation.
        let repo_operation_id =
            crate::askpass::sub_operation_id(guard.id(), &repo_id.0.to_string());
        let askpass = state.begin_askpass_operation(
            &repo_operation_id,
            Some(repo.name.clone()),
            Some(kind.as_str().to_string()),
        );
        let broker = state.askpass.clone();
        let context = guard
            .git_context(app.clone(), kind, scope.clone(), repo_id)
            .with_askpass(askpass);
        emit_operation(
            &app,
            OperationProgress {
                operation_id: guard.id().to_string(),
                kind,
                scope: scope.clone(),
                status: OperationStatus::RepoStarted,
                repo_id: Some(repo_id),
                completed: 0,
                total,
                message: Some(repo.name),
                error: None,
            },
        );

        tasks.spawn(async move {
            let result = match operation {
                BulkGitOperation::Fetch => {
                    service.fetch_with_context(repo_id, "origin", context).await
                }
                BulkGitOperation::Pull => service.pull_with_context(repo_id, context).await,
            };
            broker.finish_operation(&repo_operation_id);
            drop(permit);
            BulkRepoResult {
                repo_id,
                ok: result.is_ok(),
                error: result.err().map(|error| error.to_string()),
            }
        });
    }

    let mut completed = 0;
    let mut results = Vec::new();
    while !tasks.is_empty() {
        if let Some(Ok(result)) = tasks.join_next().await {
            completed += 1;
            emit_operation(
                &app,
                OperationProgress {
                    operation_id: guard.id().to_string(),
                    kind,
                    scope: scope.clone(),
                    status: OperationStatus::RepoFinished,
                    repo_id: Some(result.repo_id),
                    completed,
                    total,
                    message: None,
                    error: result.error.clone(),
                },
            );
            results.push(result);
        }
    }

    if guard.is_cancelled() {
        state.askpass.finish_operation(guard.id());
        emit_operation(
            &app,
            OperationProgress {
                operation_id: guard.id().to_string(),
                kind,
                scope,
                status: OperationStatus::Cancelled,
                repo_id: None,
                completed,
                total,
                message: None,
                error: None,
            },
        );
        return Err(AppError::operation_cancelled());
    }

    emit_operation(
        &app,
        OperationProgress {
            operation_id: guard.id().to_string(),
            kind,
            scope,
            status: OperationStatus::Succeeded,
            repo_id: None,
            completed,
            total,
            message: None,
            error: None,
        },
    );

    state.askpass.finish_operation(guard.id());

    Ok(results)
}
