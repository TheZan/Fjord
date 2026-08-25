//! Local `GitBackend` implementation: `gix` for read paths and `git2` for
//! working-tree mutations. Remote transport is isolated under `crate::remote`.
//!
//! Every operation lives in the submodule that owns its concern. Rust requires
//! a trait implementation to stay in one block, so this file keeps the
//! `GitBackend` impl as pure wiring and delegates each method to that
//! submodule.

use crate::executable::GitCommandFactory;
use crate::generation::MutationKind;
use crate::locking;

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;

use async_trait::async_trait;
use fjord_domain::{
    BranchInfo, CommitId, CommitPage, CommitSummary, CreateStashRequest, CreateStashResult,
    DestructiveAction, DiffHunk, DiffLine, DiffLineEnding, DiffLineKind, DiffWhitespaceMode,
    DiscardSelection, FileChangeType, FileDiff, FileDiffDetail, FileDiffWindow, HunkSelection,
    IgnoreRuleKind, IgnoreRuleOutcome, IgnoreRulePreview, LogCursor, MergeDirtyPolicy, MergeMode,
    MergePreflight, MergeResult, MergeSource, PatchSelection, PatchSource, ReflogEntry, ReflogPage,
    RemoteInfo, RepoStatus, StashEntry, StashFileGroup, StashFiles, StashId, TagInfo,
    WorkingChanges, WorkingFile,
};
use fjord_ports::{
    DestructiveActionFacts, DiffWindowOptions, ForcePushPlan, GitBackend, GitError,
    GitExecutableResolution, PushTarget, RepoPath,
};
use git2::build::CheckoutBuilder;
use git2::{ErrorCode, IndexAddOption};
use gix::diff::blob::platform::prepare_diff::Operation;
use gix::diff::blob::unified_diff::{ConsumeHunk, ContextSize, HunkHeader};
use gix::diff::blob::UnifiedDiff;
use gix::object::tree::diff::{Change, ChangeDetached};
use gix::prelude::TreeDiffChangeExt;
use time::OffsetDateTime;

mod delete_file;
mod destructive_confirmation;
mod destructive_execution;
mod destructive_preflight;
mod diff;
mod diff_tool;
mod history;
mod ignore;
mod initialization;
mod merge;
mod mutations;
mod operation_control;
mod operation_state;
mod patch;
mod patch_transaction;
mod reflog;
mod refs;
mod remotes;
mod repository;
mod runtime;
mod stash;
mod status;
mod working_tree;

pub struct LocalGitBackend {
    /// Shared with the application so a Git executable chosen in Settings is
    /// used by local subprocess commands too, not just remote transport.
    commands: GitCommandFactory,
    destructive_confirmations: Arc<destructive_confirmation::DestructiveConfirmationStore>,
    operation_origins: Arc<operation_state::OperationOriginTracker>,
}

impl LocalGitBackend {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_commands(commands: GitCommandFactory) -> Self {
        Self {
            commands,
            destructive_confirmations: Arc::new(
                destructive_confirmation::DestructiveConfirmationStore::new(
                    destructive_confirmation::DEFAULT_CONFIRMATION_TTL,
                ),
            ),
            operation_origins: Arc::new(operation_state::OperationOriginTracker::default()),
        }
    }

    #[cfg(test)]
    fn with_confirmation_ttl(ttl: std::time::Duration) -> Self {
        Self {
            commands: GitCommandFactory::new(),
            destructive_confirmations: Arc::new(
                destructive_confirmation::DestructiveConfirmationStore::new(ttl),
            ),
            operation_origins: Arc::new(operation_state::OperationOriginTracker::default()),
        }
    }
}

impl Default for LocalGitBackend {
    fn default() -> Self {
        Self {
            commands: GitCommandFactory::new(),
            destructive_confirmations: Arc::new(
                destructive_confirmation::DestructiveConfirmationStore::new(
                    destructive_confirmation::DEFAULT_CONFIRMATION_TTL,
                ),
            ),
            operation_origins: Arc::new(operation_state::OperationOriginTracker::default()),
        }
    }
}

pub(crate) fn record_repository_changes(repo: &RepoPath, changes: fjord_fs::RepoChangeSet) {
    runtime::record_watcher_changes(repo, changes);
}

pub(crate) fn bump_repository_mutation(repo: &RepoPath, mutation: MutationKind) {
    runtime::bump_mutation(repo, mutation);
}

pub(crate) fn repository_generations(repo: &RepoPath) -> Result<crate::GenerationSet, GitError> {
    runtime::generations(repo)
}

pub(crate) fn set_resident_repositories(repositories: &[RepoPath]) {
    runtime::set_resident(repositories);
}

pub(crate) fn forget_repository(repo: &RepoPath) {
    runtime::forget(repo);
}

#[async_trait]
impl GitBackend for LocalGitBackend {
    fn generations(&self, repo: &RepoPath) -> Result<crate::GenerationSet, GitError> {
        runtime::generations(repo)
    }

    async fn init_repository(&self, repo: &RepoPath, initial_branch: &str) -> Result<(), GitError> {
        initialization::init_repository(repo, initial_branch).await
    }

    async fn remotes(&self, repo: &RepoPath) -> Result<Vec<RemoteInfo>, GitError> {
        remotes::list(repo).await
    }

    async fn add_remote(
        &self,
        repo: &RepoPath,
        name: &str,
        url: &str,
    ) -> Result<RemoteInfo, GitError> {
        let remote = remotes::add(repo, name, url).await?;
        bump_repository_mutation(repo, MutationKind::AddRemote);
        Ok(remote)
    }

    async fn status(&self, repo: &RepoPath) -> Result<RepoStatus, GitError> {
        status::status(repo).await
    }

    async fn operation_state(
        &self,
        repo: &RepoPath,
    ) -> Result<fjord_domain::RepoOperationState, GitError> {
        operation_state::state(self.operation_origins.clone(), repo).await
    }

    async fn continue_operation_with_context(
        &self,
        repo: &RepoPath,
        context: fjord_ports::GitOperationContext,
    ) -> Result<fjord_domain::RepoOperationState, GitError> {
        operation_control::run(
            self.commands.clone(),
            self.operation_origins.clone(),
            repo,
            operation_control::OperationAction::Continue,
            context,
        )
        .await
    }

    async fn skip_operation_with_context(
        &self,
        repo: &RepoPath,
        context: fjord_ports::GitOperationContext,
    ) -> Result<fjord_domain::RepoOperationState, GitError> {
        operation_control::run(
            self.commands.clone(),
            self.operation_origins.clone(),
            repo,
            operation_control::OperationAction::Skip,
            context,
        )
        .await
    }

    async fn abort_operation_with_context(
        &self,
        repo: &RepoPath,
        context: fjord_ports::GitOperationContext,
    ) -> Result<fjord_domain::RepoOperationState, GitError> {
        operation_control::run(
            self.commands.clone(),
            self.operation_origins.clone(),
            repo,
            operation_control::OperationAction::Abort,
            context,
        )
        .await
    }

    async fn branches(&self, repo: &RepoPath) -> Result<Vec<BranchInfo>, GitError> {
        refs::branches(repo).await
    }

    async fn merge_preflight(
        &self,
        repo: &RepoPath,
        source: &MergeSource,
    ) -> Result<MergePreflight, GitError> {
        merge::preflight(self.operation_origins.clone(), repo, source).await
    }

    async fn merge_branch(
        &self,
        repo: &RepoPath,
        source: &MergeSource,
        mode: MergeMode,
        dirty_policy: MergeDirtyPolicy,
        context: fjord_ports::GitOperationContext,
    ) -> Result<MergeResult, GitError> {
        merge::run(
            self.commands.clone(),
            self.operation_origins.clone(),
            repo,
            source,
            mode,
            dirty_policy,
            context,
        )
        .await
    }

    async fn squash_merge_branch(
        &self,
        repo: &RepoPath,
        source: &MergeSource,
        dirty_policy: MergeDirtyPolicy,
        context: fjord_ports::GitOperationContext,
    ) -> Result<fjord_domain::SquashMergeResult, GitError> {
        merge::run_squash(
            self.commands.clone(),
            self.operation_origins.clone(),
            repo,
            source,
            dirty_policy,
            context,
        )
        .await
    }

    async fn tags(&self, repo: &RepoPath) -> Result<Vec<TagInfo>, GitError> {
        refs::tags(repo).await
    }

    async fn log(
        &self,
        repo: &RepoPath,
        from: Option<LogCursor>,
        limit: u32,
    ) -> Result<CommitPage, GitError> {
        history::log(repo, from, limit).await
    }

    async fn reflog(
        &self,
        repo: &RepoPath,
        ref_name: Option<&str>,
        from: Option<LogCursor>,
        limit: u32,
    ) -> Result<ReflogPage, GitError> {
        reflog::reflog(repo, ref_name, from, limit).await
    }

    async fn reflog_refs(&self, repo: &RepoPath) -> Result<Vec<String>, GitError> {
        reflog::reflog_refs(repo).await
    }

    async fn search_commits(
        &self,
        repo: &RepoPath,
        query: &str,
        limit: u32,
    ) -> Result<Vec<CommitSummary>, GitError> {
        history::search_commits(repo, query, limit).await
    }

    async fn commits_unreachable_from_head(
        &self,
        repo: &RepoPath,
        tip: &str,
        sample_limit: u32,
    ) -> Result<(u32, Vec<CommitSummary>), GitError> {
        history::commits_unreachable_from_head(repo, tip, sample_limit).await
    }

    async fn destructive_action_facts(
        &self,
        repo: &RepoPath,
        action: &DestructiveAction,
        sample_limit: u32,
    ) -> Result<DestructiveActionFacts, GitError> {
        destructive_preflight::facts(repo, action, sample_limit).await
    }

    async fn diff_files(
        &self,
        repo: &RepoPath,
        commit_id: &str,
    ) -> Result<Vec<FileDiff>, GitError> {
        diff::diff_files(repo, commit_id).await
    }

    async fn diff(&self, repo: &RepoPath, commit_id: &str) -> Result<Vec<FileDiff>, GitError> {
        diff::diff(&self.commands, repo, commit_id).await
    }

    async fn diff_against_head(
        &self,
        repo: &RepoPath,
        commit_id: &str,
    ) -> Result<Vec<FileDiff>, GitError> {
        diff::diff_against_head(&self.commands, repo, commit_id).await
    }

    async fn file_diff(
        &self,
        repo: &RepoPath,
        commit_id: &str,
        path: &str,
    ) -> Result<FileDiffDetail, GitError> {
        diff::file_diff(repo, commit_id, path).await
    }

    async fn file_diff_window(
        &self,
        repo: &RepoPath,
        commit_id: &str,
        path: &str,
        options: DiffWindowOptions,
    ) -> Result<FileDiffWindow, GitError> {
        diff::file_diff_window(
            repo,
            commit_id,
            path,
            options.offset,
            options.limit,
            options.max_file_bytes,
            options.whitespace,
        )
        .await
    }

    async fn working_changes(&self, repo: &RepoPath) -> Result<WorkingChanges, GitError> {
        working_tree::working_changes(repo).await
    }

    async fn working_file_diff(
        &self,
        repo: &RepoPath,
        path: &str,
        staged: bool,
    ) -> Result<FileDiffDetail, GitError> {
        working_tree::working_file_diff(repo, path, staged).await
    }

    async fn working_file_diff_window(
        &self,
        repo: &RepoPath,
        path: &str,
        staged: bool,
        options: DiffWindowOptions,
    ) -> Result<FileDiffWindow, GitError> {
        working_tree::working_file_diff_window(
            repo,
            path,
            staged,
            options.offset,
            options.limit,
            options.max_file_bytes,
            options.whitespace,
        )
        .await
    }

    async fn preview_ignore_rule(
        &self,
        repo: &RepoPath,
        path: &str,
        kind: IgnoreRuleKind,
    ) -> Result<IgnoreRulePreview, GitError> {
        ignore::preview(repo, path, kind).await
    }

    async fn add_ignore_rule(
        &self,
        repo: &RepoPath,
        path: &str,
        kind: IgnoreRuleKind,
    ) -> Result<IgnoreRuleOutcome, GitError> {
        ignore::add(repo, path, kind).await
    }

    async fn checkout(&self, repo: &RepoPath, branch: &str) -> Result<(), GitError> {
        refs::checkout(repo, branch).await?;
        runtime::bump_mutation(repo, MutationKind::Checkout);
        Ok(())
    }

    async fn checkout_overwrite_paths(
        &self,
        repo: &RepoPath,
        branch: &str,
    ) -> Result<Vec<String>, GitError> {
        refs::checkout_overwrite_paths(repo, branch).await
    }

    async fn remote_checkout_refspec(
        &self,
        repo: &RepoPath,
        branch: &str,
    ) -> Result<Option<(String, String)>, GitError> {
        refs::remote_checkout_refspec(repo, branch).await
    }

    async fn checkout_local(&self, repo: &RepoPath, branch: &str) -> Result<(), GitError> {
        refs::checkout_local(repo, branch).await?;
        runtime::bump_mutation(repo, MutationKind::Checkout);
        Ok(())
    }

    async fn stash_and_checkout(
        &self,
        repo: &RepoPath,
        branch: &str,
        message: &str,
    ) -> Result<(), GitError> {
        let result = refs::stash_and_checkout(&self.commands, repo, branch, message).await;
        runtime::bump_mutation(repo, MutationKind::StashPush);
        runtime::bump_mutation(repo, MutationKind::Checkout);
        result
    }

    async fn create_branch(
        &self,
        repo: &RepoPath,
        name: &str,
        checkout: bool,
    ) -> Result<(), GitError> {
        refs::create_branch(repo, name, checkout).await?;
        runtime::bump_mutation(repo, MutationKind::CreateBranch { checkout });
        Ok(())
    }

    async fn create_branch_at(
        &self,
        repo: &RepoPath,
        name: &str,
        target: &str,
        checkout: bool,
    ) -> Result<(), GitError> {
        refs::create_branch_at(&self.commands, repo, name, target, checkout).await?;
        runtime::bump_mutation(repo, MutationKind::CreateBranchAt { checkout });
        Ok(())
    }

    async fn rename_branch(
        &self,
        repo: &RepoPath,
        old_name: &str,
        new_name: &str,
    ) -> Result<(), GitError> {
        refs::rename_branch(&self.commands, repo, old_name, new_name).await?;
        runtime::bump_mutation(repo, MutationKind::RenameBranch);
        Ok(())
    }

    async fn delete_branch(&self, repo: &RepoPath, name: &str) -> Result<(), GitError> {
        refs::delete_branch(&self.commands, repo, name).await?;
        runtime::bump_mutation(repo, MutationKind::DeleteBranch);
        Ok(())
    }

    async fn set_branch_upstream(
        &self,
        repo: &RepoPath,
        branch: &str,
        upstream: &str,
    ) -> Result<(), GitError> {
        refs::set_branch_upstream(repo, branch, upstream).await?;
        runtime::bump_mutation(repo, MutationKind::SetUpstream);
        Ok(())
    }

    async fn unset_branch_upstream(&self, repo: &RepoPath, branch: &str) -> Result<(), GitError> {
        refs::unset_branch_upstream(repo, branch).await?;
        runtime::bump_mutation(repo, MutationKind::SetUpstream);
        Ok(())
    }

    async fn create_tag(&self, repo: &RepoPath, name: &str, target: &str) -> Result<(), GitError> {
        refs::create_tag(&self.commands, repo, name, target).await?;
        runtime::bump_mutation(repo, MutationKind::CreateTag);
        Ok(())
    }

    async fn delete_tag(&self, repo: &RepoPath, name: &str) -> Result<(), GitError> {
        refs::delete_tag(&self.commands, repo, name).await?;
        runtime::bump_mutation(repo, MutationKind::DeleteTag);
        Ok(())
    }

    async fn cherry_pick(&self, repo: &RepoPath, commit_id: &str) -> Result<(), GitError> {
        let result = mutations::cherry_pick(&self.commands, repo, commit_id).await;
        if result.is_err() {
            self.operation_origins
                .record_if_in_progress(repo, operation_state::OperationFamily::CherryPick);
        } else {
            self.operation_origins.clear(repo);
        }
        result?;
        runtime::bump_mutation(repo, MutationKind::CherryPick);
        Ok(())
    }

    async fn revert(&self, repo: &RepoPath, commit_id: &str) -> Result<(), GitError> {
        let result = mutations::revert(&self.commands, repo, commit_id).await;
        if result.is_err() {
            self.operation_origins
                .record_if_in_progress(repo, operation_state::OperationFamily::Revert);
        } else {
            self.operation_origins.clear(repo);
        }
        result?;
        runtime::bump_mutation(repo, MutationKind::Revert);
        Ok(())
    }

    async fn reset(&self, repo: &RepoPath, commit_id: &str, mode: &str) -> Result<(), GitError> {
        mutations::reset(&self.commands, repo, commit_id, mode).await?;
        runtime::bump_mutation(
            repo,
            MutationKind::Reset {
                touches_working_tree: mode != "soft",
            },
        );
        Ok(())
    }

    async fn stashes(&self, repo: &RepoPath) -> Result<Vec<StashEntry>, GitError> {
        stash::stashes(repo).await
    }

    async fn stash_files(
        &self,
        repo: &RepoPath,
        stash_id: &StashId,
        limit: u32,
    ) -> Result<StashFiles, GitError> {
        stash::files(&self.commands, repo, stash_id, limit).await
    }

    async fn stash_file_diff_window(
        &self,
        repo: &RepoPath,
        stash_id: &StashId,
        group: StashFileGroup,
        path: &str,
        options: DiffWindowOptions,
    ) -> Result<FileDiffWindow, GitError> {
        stash::file_diff_window(
            repo,
            stash_id,
            group,
            path,
            options.offset,
            options.limit,
            options.max_file_bytes,
            options.whitespace,
        )
        .await
    }

    async fn create_stash(
        &self,
        repo: &RepoPath,
        request: &CreateStashRequest,
    ) -> Result<CreateStashResult, GitError> {
        let entry = stash::create(&self.commands, repo, request).await?;
        runtime::bump_mutation(repo, MutationKind::StashPush);
        Ok(CreateStashResult {
            entry,
            generations: runtime::generations(repo)?,
        })
    }

    async fn stash_paths_supported(&self) -> Result<bool, GitError> {
        stash::paths_supported(&self.commands).await
    }

    async fn stash_pop(&self, repo: &RepoPath) -> Result<(), GitError> {
        mutations::stash_pop(repo).await?;
        runtime::bump_mutation(repo, MutationKind::StashPop);
        Ok(())
    }

    async fn stage(&self, repo: &RepoPath, paths: &[PathBuf]) -> Result<(), GitError> {
        working_tree::stage(repo, paths).await?;
        runtime::bump_mutation(repo, MutationKind::Stage);
        Ok(())
    }

    async fn stage_patch(
        &self,
        repo: &RepoPath,
        selection: &PatchSelection,
        expected_generations: crate::GenerationSet,
    ) -> Result<crate::GenerationSet, GitError> {
        working_tree::stage_patch(&self.commands, repo, selection, expected_generations).await
    }

    async fn unstage(&self, repo: &RepoPath, paths: &[PathBuf]) -> Result<(), GitError> {
        working_tree::unstage(repo, paths).await?;
        runtime::bump_mutation(repo, MutationKind::Unstage);
        Ok(())
    }

    async fn unstage_patch(
        &self,
        repo: &RepoPath,
        selection: &PatchSelection,
        expected_generations: crate::GenerationSet,
    ) -> Result<crate::GenerationSet, GitError> {
        working_tree::unstage_patch(&self.commands, repo, selection, expected_generations).await
    }

    async fn issue_discard_confirmation(
        &self,
        repo: &RepoPath,
        action: &DestructiveAction,
        selection: &PatchSelection,
        generations: crate::GenerationSet,
    ) -> Result<String, GitError> {
        working_tree::issue_discard_confirmation(
            &self.destructive_confirmations,
            repo,
            action,
            selection,
            generations,
        )
        .await
    }

    async fn issue_action_confirmation(
        &self,
        repo: &RepoPath,
        action: &DestructiveAction,
        generations: crate::GenerationSet,
    ) -> Result<String, GitError> {
        if runtime::generations(repo)? != generations {
            return Err(GitError::PreflightStale);
        }
        self.destructive_confirmations
            .issue_action(repo, action, generations)
    }

    async fn consume_action_confirmation(
        &self,
        repo: &RepoPath,
        action: &DestructiveAction,
        expected_generations: crate::GenerationSet,
        confirmation_token: &str,
    ) -> Result<(), GitError> {
        if runtime::generations(repo)? != expected_generations {
            return Err(GitError::PreflightStale);
        }
        self.destructive_confirmations.consume_action(
            confirmation_token,
            repo,
            action,
            expected_generations,
        )
    }

    async fn execute_confirmed_destructive_action(
        &self,
        repo: &RepoPath,
        action: &DestructiveAction,
        expected_generations: crate::GenerationSet,
        confirmation_token: &str,
        context: fjord_ports::GitOperationContext,
    ) -> Result<Option<fjord_domain::RepoOperationState>, GitError> {
        destructive_execution::execute(
            destructive_execution::ExecutionDependencies {
                commands: &self.commands,
                confirmations: &self.destructive_confirmations,
                origins: &self.operation_origins,
            },
            repo,
            action,
            expected_generations,
            confirmation_token,
            context,
        )
        .await
    }

    async fn discard_patch(
        &self,
        repo: &RepoPath,
        action: &DestructiveAction,
        selection: &PatchSelection,
        expected_generations: crate::GenerationSet,
        confirmation_token: &str,
    ) -> Result<crate::GenerationSet, GitError> {
        working_tree::discard_patch(
            &self.commands,
            &self.destructive_confirmations,
            repo,
            action,
            selection,
            expected_generations,
            confirmation_token,
        )
        .await
    }

    async fn export_patch(
        &self,
        repo: &RepoPath,
        selection: &PatchSelection,
    ) -> Result<Vec<u8>, GitError> {
        working_tree::export_patch(repo, selection).await
    }

    async fn amend_info(&self, repo: &RepoPath) -> Result<fjord_domain::AmendInfo, GitError> {
        refs::amend_info(repo).await
    }

    async fn commit(&self, repo: &RepoPath, message: &str) -> Result<String, GitError> {
        let commit_id = mutations::commit(repo, message, false).await?;
        runtime::bump_mutation(repo, MutationKind::Commit);
        Ok(commit_id)
    }

    async fn amend(&self, repo: &RepoPath, message: &str) -> Result<String, GitError> {
        let commit_id = mutations::commit(repo, message, true).await?;
        runtime::bump_mutation(repo, MutationKind::Commit);
        Ok(commit_id)
    }

    async fn upstream_remote(&self, repo: &RepoPath) -> Result<String, GitError> {
        refs::upstream_remote(repo).await
    }

    async fn integrate_upstream(&self, repo: &RepoPath) -> Result<(), GitError> {
        let result = mutations::integrate_upstream(repo).await;
        if result.is_err() {
            self.operation_origins
                .record_if_in_progress(repo, operation_state::OperationFamily::Merge);
        } else {
            self.operation_origins.clear(repo);
        }
        result?;
        runtime::bump_mutation(repo, MutationKind::IntegrateUpstream);
        Ok(())
    }

    async fn current_push_target(&self, repo: &RepoPath) -> Result<PushTarget, GitError> {
        refs::current_push_target(repo).await
    }

    async fn force_push_plan(&self, repo: &RepoPath) -> Result<ForcePushPlan, GitError> {
        refs::force_push_plan(repo).await
    }

    async fn issue_force_push_confirmation(
        &self,
        repo: &RepoPath,
        action: &DestructiveAction,
        plan: &ForcePushPlan,
        generations: crate::GenerationSet,
    ) -> Result<String, GitError> {
        self.destructive_confirmations
            .issue_force_push(repo, action, plan, generations)
    }

    async fn consume_force_push_confirmation(
        &self,
        repo: &RepoPath,
        action: &DestructiveAction,
        expected_generations: crate::GenerationSet,
        confirmation_token: &str,
    ) -> Result<ForcePushPlan, GitError> {
        if runtime::generations(repo)? != expected_generations {
            return Err(GitError::PreflightStale);
        }
        let current_plan = refs::force_push_plan(repo).await?;
        self.destructive_confirmations.consume_force_push(
            confirmation_token,
            repo,
            action,
            &current_plan,
            expected_generations,
        )
    }

    async fn current_branch_ref(&self, repo: &RepoPath) -> Result<String, GitError> {
        refs::current_branch_ref(repo).await
    }

    async fn open_merge_tool(&self, repo: &RepoPath) -> Result<(), GitError> {
        mutations::open_merge_tool(&self.commands, repo).await
    }

    async fn diff_tool_availability(
        &self,
        repo: &RepoPath,
        preference: Option<&str>,
    ) -> Result<bool, GitError> {
        diff_tool::availability(&self.commands, repo, preference).await
    }

    async fn open_external_diff(
        &self,
        repo: &RepoPath,
        path: &str,
        source: PatchSource,
        preference: Option<&str>,
    ) -> Result<(), GitError> {
        diff_tool::open(&self.commands, repo, path, source, preference).await
    }

    fn set_git_executable(&self, resolution: GitExecutableResolution) {
        self.commands.apply(resolution);
    }
}

#[cfg(test)]
mod tests;
