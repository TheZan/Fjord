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

use async_trait::async_trait;
use fjord_domain::{
    BranchInfo, CommitId, CommitPage, CommitSummary, DiffHunk, DiffLine, DiffLineKind,
    FileChangeType, FileDiff, FileDiffDetail, FileDiffWindow, LogCursor, RepoStatus, StashEntry,
    TagInfo, WorkingChanges, WorkingFile,
};
use fjord_ports::{GitBackend, GitError, GitExecutableResolution, PushTarget, RepoPath};
use git2::build::CheckoutBuilder;
use git2::{ErrorCode, IndexAddOption, StashFlags};
use gix::diff::blob::platform::prepare_diff::Operation;
use gix::diff::blob::unified_diff::{ConsumeHunk, ContextSize, HunkHeader};
use gix::diff::blob::UnifiedDiff;
use gix::object::tree::diff::{Change, ChangeDetached};
use gix::prelude::TreeDiffChangeExt;
use time::OffsetDateTime;

mod diff;
mod history;
mod mutations;
mod refs;
mod repository;
mod runtime;
mod status;
mod working_tree;

pub struct LocalGitBackend {
    /// Shared with the application so a Git executable chosen in Settings is
    /// used by local subprocess commands too, not just remote transport.
    commands: GitCommandFactory,
}

impl LocalGitBackend {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_commands(commands: GitCommandFactory) -> Self {
        Self { commands }
    }
}

impl Default for LocalGitBackend {
    fn default() -> Self {
        Self {
            commands: GitCommandFactory::new(),
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

    async fn status(&self, repo: &RepoPath) -> Result<RepoStatus, GitError> {
        status::status(repo).await
    }

    async fn branches(&self, repo: &RepoPath) -> Result<Vec<BranchInfo>, GitError> {
        refs::branches(repo).await
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
        offset: u32,
        limit: u32,
        max_file_bytes: u64,
    ) -> Result<FileDiffWindow, GitError> {
        diff::file_diff_window(repo, commit_id, path, offset, limit, max_file_bytes).await
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
        offset: u32,
        limit: u32,
        max_file_bytes: u64,
    ) -> Result<FileDiffWindow, GitError> {
        working_tree::working_file_diff_window(repo, path, staged, offset, limit, max_file_bytes)
            .await
    }

    async fn checkout(&self, repo: &RepoPath, branch: &str) -> Result<(), GitError> {
        refs::checkout(repo, branch).await?;
        runtime::bump_mutation(repo, MutationKind::Checkout);
        Ok(())
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
        mutations::cherry_pick(&self.commands, repo, commit_id).await?;
        runtime::bump_mutation(repo, MutationKind::CherryPick);
        Ok(())
    }

    async fn revert(&self, repo: &RepoPath, commit_id: &str) -> Result<(), GitError> {
        mutations::revert(&self.commands, repo, commit_id).await?;
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
        mutations::stashes(repo).await
    }

    async fn stash_push(&self, repo: &RepoPath, message: Option<&str>) -> Result<(), GitError> {
        mutations::stash_push(repo, message).await?;
        runtime::bump_mutation(repo, MutationKind::StashPush);
        Ok(())
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

    async fn unstage(&self, repo: &RepoPath, paths: &[PathBuf]) -> Result<(), GitError> {
        working_tree::unstage(repo, paths).await?;
        runtime::bump_mutation(repo, MutationKind::Unstage);
        Ok(())
    }

    async fn commit(&self, repo: &RepoPath, message: &str) -> Result<String, GitError> {
        let commit_id = mutations::commit(repo, message).await?;
        runtime::bump_mutation(repo, MutationKind::Commit);
        Ok(commit_id)
    }

    async fn upstream_remote(&self, repo: &RepoPath) -> Result<String, GitError> {
        refs::upstream_remote(repo).await
    }

    async fn integrate_upstream(&self, repo: &RepoPath) -> Result<(), GitError> {
        mutations::integrate_upstream(repo).await?;
        runtime::bump_mutation(repo, MutationKind::IntegrateUpstream);
        Ok(())
    }

    async fn current_push_target(&self, repo: &RepoPath) -> Result<PushTarget, GitError> {
        refs::current_push_target(repo).await
    }

    async fn current_branch_ref(&self, repo: &RepoPath) -> Result<String, GitError> {
        refs::current_branch_ref(repo).await
    }

    async fn open_merge_tool(&self, repo: &RepoPath) -> Result<(), GitError> {
        mutations::open_merge_tool(&self.commands, repo).await
    }

    fn set_git_executable(&self, resolution: GitExecutableResolution) {
        self.commands.apply(resolution);
    }
}

#[cfg(test)]
mod tests;
