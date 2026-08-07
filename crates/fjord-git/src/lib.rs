#![cfg_attr(test, allow(linker_messages))]

//! `GitBackend` implementation: `gix` for the hot read paths, `git2` for
//! what `gix` doesn't cover yet (fetch/pull/push today). See
//! docs/specs/git-backend.md for the full routing table and rationale.

mod locking;
pub mod remote;

pub use remote::backend::SystemGitRemoteBackend;

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Arc;

use async_trait::async_trait;
use fjord_domain::{
    BranchInfo, CommitId, CommitPage, CommitSummary, DiffHunk, DiffLine, DiffLineKind,
    FileChangeType, FileDiff, FileDiffDetail, LogCursor, RemoteRef, RepoStatus, StashEntry,
    TagInfo, WorkingChanges, WorkingFile,
};
use fjord_ports::{
    GitBackend, GitError, GitOperationContext, GitProgress, GitRemoteBackend, GitRemoteError,
    RepoPath,
};
use git2::build::CheckoutBuilder;
use git2::{Cred, ErrorCode, IndexAddOption, Oid, PushOptions, RemoteCallbacks, Sort, StashFlags};
use gix::diff::blob::platform::prepare_diff::Operation;
use gix::diff::blob::unified_diff::{ConsumeHunk, ContextSize, HunkHeader};
use gix::diff::blob::UnifiedDiff;
use gix::object::tree::diff::{Change, ChangeDetached};
use gix::prelude::TreeDiffChangeExt;
use time::OffsetDateTime;

pub struct GixGitBackend;

/// Migration-only adapter used while service call sites move from the legacy
/// remote methods on `GitBackend` to `GitRemoteBackend`.
pub struct LegacyGitRemoteBackend {
    backend: Arc<dyn GitBackend>,
}

impl LegacyGitRemoteBackend {
    pub fn new(backend: Arc<dyn GitBackend>) -> Self {
        Self { backend }
    }
}

fn legacy_remote_error(error: GitError) -> GitRemoteError {
    match error {
        GitError::AuthenticationFailed => GitRemoteError::AuthenticationFailed {
            stderr_tail: String::new(),
        },
        GitError::Cancelled => GitRemoteError::Cancelled,
        other => GitRemoteError::ProcessFailed {
            exit_code: None,
            summary: other.to_string(),
            stderr_tail: String::new(),
        },
    }
}

#[async_trait]
impl GitRemoteBackend for LegacyGitRemoteBackend {
    async fn fetch(
        &self,
        repo: &RepoPath,
        remote: &str,
        refspecs: &[String],
        context: GitOperationContext,
    ) -> Result<(), GitRemoteError> {
        if !refspecs.is_empty() {
            return Err(GitRemoteError::ProcessFailed {
                exit_code: None,
                summary: "legacy backend does not support explicit fetch refspecs".into(),
                stderr_tail: String::new(),
            });
        }
        self.backend
            .fetch_with_context(repo, remote, context)
            .await
            .map_err(legacy_remote_error)
    }

    async fn push(
        &self,
        repo: &RepoPath,
        remote: &str,
        refspecs: &[String],
        context: GitOperationContext,
    ) -> Result<(), GitRemoteError> {
        if remote != "origin" || refspecs.len() > 1 {
            return Err(GitRemoteError::ProcessFailed {
                exit_code: None,
                summary: "legacy backend supports one refspec on origin".into(),
                stderr_tail: String::new(),
            });
        }
        self.backend
            .push_with_context(
                repo,
                refspecs.first().map(String::as_str).unwrap_or(""),
                context,
            )
            .await
            .map_err(legacy_remote_error)
    }

    async fn delete_remote_branch(
        &self,
        repo: &RepoPath,
        remote: &str,
        branch: &str,
        _context: GitOperationContext,
    ) -> Result<(), GitRemoteError> {
        self.backend
            .delete_remote_branch(repo, &format!("{remote}/{branch}"))
            .await
            .map_err(legacy_remote_error)
    }

    async fn ls_remote(
        &self,
        _repo: &RepoPath,
        _remote: &str,
        _context: GitOperationContext,
    ) -> Result<Vec<RemoteRef>, GitRemoteError> {
        Err(GitRemoteError::ProcessFailed {
            exit_code: None,
            summary: "ls-remote is unavailable on the legacy adapter".into(),
            stderr_tail: String::new(),
        })
    }
}

impl GixGitBackend {
    pub fn new() -> Self {
        Self
    }

    fn open(repo: &RepoPath) -> Result<gix::Repository, GitError> {
        gix::open(&repo.0).map_err(|e| match e {
            gix::open::Error::NotARepository { .. } => GitError::NotAGitRepository(repo.0.clone()),
            other => GitError::Gix(other.to_string()),
        })
    }

    fn open_git2(repo: &RepoPath) -> Result<git2::Repository, GitError> {
        git2::Repository::open(&repo.0).map_err(Self::map_git2_error)
    }

    fn background_git_command() -> Command {
        let mut command = Command::new("git");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;

            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        command
    }

    /// Shared guard for operations that only read. Concurrent readers
    /// overlap; a writer still excludes them.
    ///
    /// This was an exclusive mutex taken by *every* method, reads included,
    /// which quietly serialized repository opening: the UI fires status,
    /// branches, tags, log and working-changes together, so their wall-clock
    /// cost was the sum rather than the slowest one. On a repo with 826
    /// refs and 922 tags that measured 861 ms concurrent against a 518 ms
    /// slowest read (`cargo run -p fjord-bench -- --repo <path>
    /// --profile-open`).
    async fn acquire_repo_read_lock(repo: &RepoPath) -> tokio::sync::OwnedRwLockReadGuard<()> {
        locking::read(repo).await
    }

    /// Exclusive guard for operations that mutate the repository — checkout,
    /// staging, commit, fetch/pull/push, stash. Two of these interleaving
    /// (or running while a read observes a half-applied state) is what the
    /// lock exists to prevent.
    async fn acquire_repo_write_lock(repo: &RepoPath) -> tokio::sync::OwnedRwLockWriteGuard<()> {
        locking::write(repo).await
    }

    fn map_git2_error(err: git2::Error) -> GitError {
        match err.code() {
            ErrorCode::Auth => GitError::AuthenticationFailed,
            ErrorCode::Conflict | ErrorCode::MergeConflict | ErrorCode::Unmerged => {
                GitError::Conflict { paths: vec![] }
            }
            _ => GitError::Git2(err.message().to_string()),
        }
    }

    fn remote_callbacks(context: GitOperationContext) -> RemoteCallbacks<'static> {
        let mut callbacks = RemoteCallbacks::new();
        callbacks.credentials(|_url, username_from_url, allowed| {
            if allowed.is_ssh_key() {
                if let Some(username) = username_from_url {
                    if let Ok(cred) = Cred::ssh_key_from_agent(username) {
                        return Ok(cred);
                    }
                }
            }

            Cred::default().or_else(|_| {
                username_from_url
                    .map(Cred::username)
                    .unwrap_or_else(Cred::default)
            })
        });
        callbacks.transfer_progress(move |stats| {
            context.emit(GitProgress {
                completed: stats.received_objects() as u32,
                total: stats.total_objects() as u32,
            });
            !context.is_cancelled()
        });
        callbacks
    }

    fn push_options(context: GitOperationContext) -> PushOptions<'static> {
        let push_context = context.clone();
        let update_context = context.clone();
        let mut callbacks = Self::remote_callbacks(context);
        callbacks.push_update_reference(move |refname, status| {
            if update_context.is_cancelled() {
                return Err(git2::Error::from_str("operation cancelled"));
            }
            status
                .map(|message| Err(git2::Error::from_str(&format!("{refname}: {message}"))))
                .unwrap_or(Ok(()))
        });
        callbacks.push_transfer_progress(move |current, total, _bytes| {
            push_context.emit(GitProgress {
                completed: current as u32,
                total: total as u32,
            });
        });

        let mut options = PushOptions::new();
        options.remote_callbacks(callbacks);
        options
    }

    fn fetch_remote_with_system_git(
        repo: &RepoPath,
        remote_name: &str,
        refspecs: &[&str],
        context: GitOperationContext,
    ) -> Result<(), GitError> {
        let mut args = vec!["fetch", "--prune", remote_name];
        args.extend(refspecs.iter().copied());
        Self::run_system_git(repo, &args, context)
    }

    fn run_system_git(
        repo: &RepoPath,
        args: &[&str],
        context: GitOperationContext,
    ) -> Result<(), GitError> {
        if context.is_cancelled() {
            return Err(GitError::Cancelled);
        }

        let output = Self::background_git_command()
            .args(args)
            .current_dir(&repo.0)
            .stdin(Stdio::null())
            .output()
            .map_err(|err| {
                GitError::Git2(format!("failed to run git {}: {err}", args.join(" ")))
            })?;

        if context.is_cancelled() {
            return Err(GitError::Cancelled);
        }
        if output.status.success() {
            return Ok(());
        }

        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let message = stderr
            .trim()
            .split('\n')
            .next()
            .filter(|line| !line.is_empty())
            .or_else(|| {
                stdout
                    .trim()
                    .split('\n')
                    .next()
                    .filter(|line| !line.is_empty())
            })
            .unwrap_or("git command failed");
        let lowered = message.to_ascii_lowercase();
        if lowered.contains("authentication failed")
            || lowered.contains("could not read username")
            || lowered.contains("permission denied")
        {
            return Err(GitError::AuthenticationFailed);
        }

        Err(GitError::Git2(format!(
            "git {} failed: {message}",
            args.join(" ")
        )))
    }

    fn current_branch_refname(git: &git2::Repository) -> Result<String, GitError> {
        let head = git.head().map_err(Self::map_git2_error)?;
        let head_refname = head.name().map_err(Self::map_git2_error)?.to_string();

        if !head_refname.starts_with("refs/heads/") {
            return Err(GitError::NoUpstream);
        }

        Ok(head_refname)
    }

    fn conflict_paths(index: &git2::Index) -> Vec<String> {
        index
            .conflicts()
            .map(|conflicts| {
                conflicts
                    .filter_map(Result::ok)
                    .filter_map(|conflict| conflict.our.or(conflict.their).or(conflict.ancestor))
                    .map(|entry| String::from_utf8_lossy(&entry.path).into_owned())
                    .collect()
            })
            .unwrap_or_default()
    }

    fn has_conflicts(repo: &RepoPath) -> Result<bool, GitError> {
        let git = Self::open_git2(repo)?;
        Ok(git.index().map_err(Self::map_git2_error)?.has_conflicts())
    }

    fn current_head_commit(git: &git2::Repository) -> Result<Option<git2::Commit<'_>>, GitError> {
        match git.head() {
            Ok(head) => Ok(Some(head.peel_to_commit().map_err(Self::map_git2_error)?)),
            Err(err) if matches!(err.code(), ErrorCode::UnbornBranch | ErrorCode::NotFound) => {
                Ok(None)
            }
            Err(err) => Err(Self::map_git2_error(err)),
        }
    }

    fn fast_forward(
        git: &git2::Repository,
        local_refname: &str,
        remote_commit: &git2::AnnotatedCommit<'_>,
    ) -> Result<(), GitError> {
        let mut local_ref = git
            .find_reference(local_refname)
            .map_err(Self::map_git2_error)?;
        local_ref
            .set_target(
                remote_commit.id(),
                &format!("Fast-forward {local_refname} to {}", remote_commit.id()),
            )
            .map_err(Self::map_git2_error)?;
        git.set_head(local_refname).map_err(Self::map_git2_error)?;

        let mut checkout = CheckoutBuilder::new();
        checkout.safe();
        git.checkout_head(Some(&mut checkout))
            .map_err(Self::map_git2_error)
    }

    fn normal_merge(
        git: &git2::Repository,
        local_commit: &git2::AnnotatedCommit<'_>,
        remote_commit: &git2::AnnotatedCommit<'_>,
    ) -> Result<(), GitError> {
        let local = git
            .find_commit(local_commit.id())
            .map_err(Self::map_git2_error)?;
        let remote = git
            .find_commit(remote_commit.id())
            .map_err(Self::map_git2_error)?;
        let ancestor = git
            .find_commit(
                git.merge_base(local_commit.id(), remote_commit.id())
                    .map_err(Self::map_git2_error)?,
            )
            .map_err(Self::map_git2_error)?;
        let mut index = git
            .merge_trees(
                &ancestor.tree().map_err(Self::map_git2_error)?,
                &local.tree().map_err(Self::map_git2_error)?,
                &remote.tree().map_err(Self::map_git2_error)?,
                None,
            )
            .map_err(Self::map_git2_error)?;

        if index.has_conflicts() {
            let paths = Self::conflict_paths(&index);
            let mut checkout = CheckoutBuilder::new();
            checkout.allow_conflicts(true).conflict_style_merge(true);
            git.checkout_index(Some(&mut index), Some(&mut checkout))
                .map_err(Self::map_git2_error)?;
            return Err(GitError::Conflict { paths });
        }

        let tree_oid = index.write_tree_to(git).map_err(Self::map_git2_error)?;
        let tree = git.find_tree(tree_oid).map_err(Self::map_git2_error)?;
        let signature = git.signature().map_err(Self::map_git2_error)?;
        let message = format!("Merge {} into {}", remote_commit.id(), local_commit.id());
        git.commit(
            Some("HEAD"),
            &signature,
            &signature,
            &message,
            &tree,
            &[&local, &remote],
        )
        .map_err(Self::map_git2_error)?;

        let mut checkout = CheckoutBuilder::new();
        checkout.safe();
        git.checkout_head(Some(&mut checkout))
            .map_err(Self::map_git2_error)
    }

    /// The commit's tree and its first parent's tree (`None` for a root commit), which
    /// together define the changeset shown for that commit — see docs/specs/git-backend.md.
    fn commit_trees<'r>(
        git: &'r gix::Repository,
        commit_id: &str,
    ) -> Result<(Option<gix::Tree<'r>>, gix::Tree<'r>), GitError> {
        let oid = gix::ObjectId::from_hex(commit_id.as_bytes())
            .map_err(|e| GitError::Gix(e.to_string()))?;
        let commit = git
            .find_object(oid)
            .map_err(|e| GitError::Gix(e.to_string()))?
            .try_into_commit()
            .map_err(|e| GitError::Gix(e.to_string()))?;
        let new_tree = commit.tree().map_err(|e| GitError::Gix(e.to_string()))?;

        let old_tree = match commit.parent_ids().next() {
            Some(parent_id) => {
                let parent = parent_id
                    .object()
                    .map_err(|e| GitError::Gix(e.to_string()))?
                    .try_into_commit()
                    .map_err(|e| GitError::Gix(e.to_string()))?;
                Some(parent.tree().map_err(|e| GitError::Gix(e.to_string()))?)
            }
            None => None,
        };

        Ok((old_tree, new_tree))
    }

    /// Changes between a commit and its first parent. Rewrite (rename/copy) tracking is
    /// deliberately disabled — it's config-dependent and turns this into a fuzzy, expensive
    /// N×M match; a rename shows up as a delete + an add, which P1-04 doesn't need to resolve.
    ///
    /// With path tracking on, `gix_diff::tree_with_rewrites` also emits an entry per changed
    /// *directory* (mode `Tree`) to make hierarchy reconstruction possible — those aren't
    /// diffable blobs and aren't "files" in any sense the frontend cares about, so they're
    /// filtered out here rather than in every caller.
    fn commit_changes(
        git: &gix::Repository,
        commit_id: &str,
    ) -> Result<Vec<ChangeDetached>, GitError> {
        let (old_tree, new_tree) = Self::commit_trees(git, commit_id)?;
        Self::tree_changes(git, old_tree.as_ref(), &new_tree)
    }

    fn tree_changes(
        git: &gix::Repository,
        old_tree: Option<&gix::Tree<'_>>,
        new_tree: &gix::Tree<'_>,
    ) -> Result<Vec<ChangeDetached>, GitError> {
        let mut options = gix::diff::Options::default();
        options.track_rewrites(None);
        let changes = git
            .diff_tree_to_tree(old_tree, new_tree, Some(options))
            .map_err(|e| GitError::Gix(e.to_string()))?;
        Ok(changes
            .into_iter()
            .filter(|change| change.attach(git, git).entry_mode().is_blob_or_symlink())
            .collect())
    }

    /// Collects every file's line counts in one Git process. The previous
    /// implementation prepared and diffed each blob separately, making the
    /// inspector latency proportional to N independent diff setups.
    fn commit_line_stats(
        repo: &RepoPath,
        commit_id: &str,
        old_tree: Option<&gix::Tree<'_>>,
        new_tree: &gix::Tree<'_>,
    ) -> Result<HashMap<String, (u32, u32)>, GitError> {
        let mut command = Self::background_git_command();
        command.current_dir(&repo.0).stdin(Stdio::null());

        if let Some(old_tree) = old_tree {
            command
                .args([
                    "diff",
                    "--numstat",
                    "--no-renames",
                    "--no-ext-diff",
                    "--no-textconv",
                    "-z",
                ])
                .arg(old_tree.id.to_string())
                .arg(new_tree.id.to_string());
        } else {
            command
                .args([
                    "diff-tree",
                    "--root",
                    "--no-commit-id",
                    "--numstat",
                    "--no-renames",
                    "--no-ext-diff",
                    "--no-textconv",
                    "-r",
                    "-z",
                ])
                .arg(commit_id);
        }

        let output = command.output().map_err(|error| {
            GitError::Git2(format!("failed to read commit statistics: {error}"))
        })?;
        if !output.status.success() {
            let message = String::from_utf8_lossy(&output.stderr);
            return Err(GitError::Git2(format!(
                "failed to read commit statistics: {}",
                message.trim()
            )));
        }

        Ok(Self::parse_numstat(&output.stdout))
    }

    fn parse_numstat(output: &[u8]) -> HashMap<String, (u32, u32)> {
        output
            .split(|byte| *byte == 0)
            .filter_map(|record| {
                if record.is_empty() {
                    return None;
                }
                let mut fields = record.splitn(3, |byte| *byte == b'\t');
                let additions = parse_numstat_count(fields.next()?)?;
                let deletions = parse_numstat_count(fields.next()?)?;
                let path = String::from_utf8_lossy(fields.next()?).into_owned();
                Some((path, (additions, deletions)))
            })
            .collect()
    }

    /// Point the worktree and HEAD at `refname`. Shared by `checkout` and by
    /// `create_branch`'s optional switch-to-the-new-branch step.
    fn checkout_refname(git: &git2::Repository, refname: &str) -> Result<(), GitError> {
        let target = git
            .find_reference(refname)
            .map_err(Self::map_git2_error)?
            .peel(git2::ObjectType::Commit)
            .map_err(Self::map_git2_error)?;
        let mut checkout = CheckoutBuilder::new();
        checkout.safe();
        git.checkout_tree(&target, Some(&mut checkout))
            .map_err(Self::map_git2_error)?;
        git.set_head(refname).map_err(Self::map_git2_error)
    }

    fn checkout_refname_for_branch(
        git: &git2::Repository,
        repo: &RepoPath,
        branch: &str,
    ) -> Result<String, GitError> {
        if let Some(remote_branch) = branch.strip_prefix("refs/remotes/") {
            return Self::checkout_remote_tracking_branch(git, repo, remote_branch);
        }

        if branch.starts_with("refs/") {
            git.find_reference(branch).map_err(Self::map_git2_error)?;
            return Ok(branch.to_string());
        }

        let local_refname = format!("refs/heads/{branch}");
        if git.find_reference(&local_refname).is_ok() {
            return Ok(local_refname);
        }

        if Self::remote_branch_parts(git, branch).is_some() {
            return Self::checkout_remote_tracking_branch(git, repo, branch);
        }

        git.find_reference(&local_refname)
            .map_err(Self::map_git2_error)?;
        Ok(local_refname)
    }

    fn checkout_remote_tracking_branch(
        git: &git2::Repository,
        repo: &RepoPath,
        remote_branch: &str,
    ) -> Result<String, GitError> {
        let (remote_name, local_name) =
            Self::remote_branch_parts(git, remote_branch).ok_or_else(|| {
                GitError::Git2(format!("remote branch name is invalid: {remote_branch}"))
            })?;
        let refspec = format!("+refs/heads/{local_name}:refs/remotes/{remote_branch}");
        Self::fetch_remote_with_system_git(
            repo,
            remote_name,
            &[refspec.as_str()],
            GitOperationContext::default(),
        )?;

        let local_refname = format!("refs/heads/{local_name}");
        if git.find_reference(&local_refname).is_ok() {
            if let Ok(mut local_branch) = git.find_branch(local_name, git2::BranchType::Local) {
                local_branch
                    .set_upstream(Some(remote_branch))
                    .map_err(Self::map_git2_error)?;
            }
            Self::fast_forward_local_to_remote(git, &local_refname, remote_branch)?;
            return Ok(local_refname);
        }

        let remote_refname = format!("refs/remotes/{remote_branch}");
        let remote_ref = git
            .find_reference(&remote_refname)
            .map_err(Self::map_git2_error)?;
        let target = remote_ref.peel_to_commit().map_err(Self::map_git2_error)?;
        let mut created = git
            .branch(local_name, &target, false)
            .map_err(Self::map_git2_error)?;
        created
            .set_upstream(Some(remote_branch))
            .map_err(Self::map_git2_error)?;
        Ok(local_refname)
    }

    fn fast_forward_local_to_remote(
        git: &git2::Repository,
        local_refname: &str,
        remote_branch: &str,
    ) -> Result<(), GitError> {
        let remote_refname = format!("refs/remotes/{remote_branch}");
        let mut local_ref = git
            .find_reference(local_refname)
            .map_err(Self::map_git2_error)?;
        let remote_ref = git
            .find_reference(&remote_refname)
            .map_err(Self::map_git2_error)?;
        let local_oid = local_ref
            .peel_to_commit()
            .map_err(Self::map_git2_error)?
            .id();
        let remote_oid = remote_ref
            .peel_to_commit()
            .map_err(Self::map_git2_error)?
            .id();
        let (ahead, behind) = git
            .graph_ahead_behind(local_oid, remote_oid)
            .map_err(Self::map_git2_error)?;

        if behind == 0 {
            return Ok(());
        }
        if ahead > 0 {
            return Err(GitError::Git2(format!(
                "{local_refname} has diverged from {remote_refname}"
            )));
        }

        if Self::current_branch_refname(git).is_ok_and(|current| current == local_refname) {
            let remote_commit = git
                .reference_to_annotated_commit(&remote_ref)
                .map_err(Self::map_git2_error)?;
            return Self::fast_forward(git, local_refname, &remote_commit);
        }

        local_ref
            .set_target(
                remote_oid,
                &format!("Fast-forward {local_refname} to {remote_oid}"),
            )
            .map_err(Self::map_git2_error)?;
        Ok(())
    }

    fn remote_branch_parts<'a>(
        git: &git2::Repository,
        remote_branch: &'a str,
    ) -> Option<(&'a str, &'a str)> {
        let (remote_name, local_name) = remote_branch.split_once('/')?;
        if local_name.trim().is_empty() || local_name == "HEAD" {
            return None;
        }
        git.find_remote(remote_name).ok()?;
        Some((remote_name, local_name))
    }

    fn collect_commit_refs(git: &git2::Repository) -> Result<HashMap<Oid, Vec<String>>, GitError> {
        let mut refs_by_commit: HashMap<Oid, Vec<String>> = HashMap::new();
        let references = git.references().map_err(Self::map_git2_error)?;

        for reference in references {
            let reference = reference.map_err(Self::map_git2_error)?;
            let name = reference.name().map_err(Self::map_git2_error)?;
            if name == "refs/remotes/origin/HEAD" || !Self::is_visible_refname(name) {
                continue;
            }
            let commit = reference.peel_to_commit().map_err(Self::map_git2_error)?;
            refs_by_commit
                .entry(commit.id())
                .or_default()
                .push(Self::short_refname(name).to_string());
        }

        for refs in refs_by_commit.values_mut() {
            refs.sort_by(|a, b| Self::ref_sort_key(a).cmp(&Self::ref_sort_key(b)));
            refs.dedup();
        }

        Ok(refs_by_commit)
    }

    fn is_visible_refname(name: &str) -> bool {
        name.starts_with("refs/heads/")
            || name.starts_with("refs/remotes/")
            || name.starts_with("refs/tags/")
    }

    fn short_refname(name: &str) -> &str {
        name.strip_prefix("refs/heads/")
            .or_else(|| name.strip_prefix("refs/remotes/"))
            .or_else(|| name.strip_prefix("refs/tags/"))
            .unwrap_or(name)
    }

    fn ref_sort_key(name: &str) -> (u8, &str) {
        if name.starts_with("origin/") {
            (1, name)
        } else {
            (0, name)
        }
    }

    fn log_offset(from: Option<LogCursor>) -> usize {
        from.and_then(|cursor| cursor.0.strip_prefix("offset:")?.parse().ok())
            .unwrap_or(0)
    }

    fn push_log_refs(git: &git2::Repository, walk: &mut git2::Revwalk<'_>) -> Result<(), GitError> {
        let references = git.references().map_err(Self::map_git2_error)?;
        let mut pushed = false;

        for glob in ["refs/heads/*", "refs/remotes/*", "refs/tags/*"] {
            walk.push_glob(glob).map_err(Self::map_git2_error)?;
            pushed = true;
        }
        if !pushed || references.count() == 0 {
            walk.push_head().map_err(Self::map_git2_error)?;
        }

        Ok(())
    }

    fn commit_summary(
        git: &git2::Repository,
        id: Oid,
        refs_by_commit: &mut HashMap<Oid, Vec<String>>,
    ) -> Result<CommitSummary, GitError> {
        let commit = git.find_commit(id).map_err(Self::map_git2_error)?;
        let author = commit.author();

        Ok(CommitSummary {
            id: CommitId(id.to_string()),
            parent_ids: commit
                .parent_ids()
                .map(|id| CommitId(id.to_string()))
                .collect(),
            message: commit.message().unwrap_or("").to_string(),
            author_name: author.name().unwrap_or("").to_string(),
            author_email: author.email().unwrap_or("").to_string(),
            authored_at: OffsetDateTime::from_unix_timestamp(author.when().seconds())
                .unwrap_or(OffsetDateTime::UNIX_EPOCH),
            refs: refs_by_commit.remove(&id).unwrap_or_default(),
        })
    }

    /// An owned signature. `Repository::signature` borrows the repo, which
    /// deadlocks the borrow checker against the `&mut Repository` the stash
    /// APIs require — so read the identity out and rebuild it detached.
    fn owned_signature(git: &git2::Repository) -> Result<git2::Signature<'static>, GitError> {
        let (name, email) = {
            let signature = git.signature().map_err(Self::map_git2_error)?;
            (
                signature.name().unwrap_or("Fjord").to_string(),
                signature.email().unwrap_or("").to_string(),
            )
        };
        git2::Signature::now(&name, &email).map_err(Self::map_git2_error)
    }

    fn classify_delta(status: git2::Delta) -> FileChangeType {
        match status {
            git2::Delta::Added | git2::Delta::Untracked | git2::Delta::Copied => {
                FileChangeType::Added
            }
            git2::Delta::Deleted => FileChangeType::Deleted,
            git2::Delta::Renamed => FileChangeType::Renamed,
            _ => FileChangeType::Modified,
        }
    }

    /// Collects a git2 diff into domain hunks. Used for uncommitted work,
    /// where `gix`'s tree-to-tree path doesn't apply — there's no second tree.
    fn collect_git2_diff(diff: &git2::Diff<'_>) -> Result<(bool, Vec<DiffHunk>), GitError> {
        // The hunk and line callbacks both need to reach the same buffer, and
        // `foreach` holds all of them at once — hence the shared cells rather
        // than plain `&mut` captures.
        let hunks: std::cell::RefCell<Vec<DiffHunk>> = std::cell::RefCell::new(Vec::new());
        let is_binary = std::cell::Cell::new(false);

        diff.foreach(
            &mut |_delta, _progress| true,
            Some(&mut |_delta, _binary| {
                is_binary.set(true);
                true
            }),
            Some(&mut |_delta, hunk| {
                hunks.borrow_mut().push(DiffHunk {
                    old_start: hunk.old_start(),
                    old_lines: hunk.old_lines(),
                    new_start: hunk.new_start(),
                    new_lines: hunk.new_lines(),
                    lines: Vec::new(),
                });
                true
            }),
            Some(&mut |_delta, _hunk, line| {
                let mut hunks = hunks.borrow_mut();
                let Some(current) = hunks.last_mut() else {
                    return true;
                };
                let kind = match line.origin() {
                    '+' => DiffLineKind::Addition,
                    '-' => DiffLineKind::Deletion,
                    _ => DiffLineKind::Context,
                };
                // git2 hands back the raw line including its newline; the
                // frontend renders one row per line and adds its own.
                let content = String::from_utf8_lossy(line.content())
                    .trim_end_matches(['\n', '\r'])
                    .to_string();
                current.lines.push(DiffLine {
                    kind,
                    old_lineno: line.old_lineno(),
                    new_lineno: line.new_lineno(),
                    content,
                });
                true
            }),
        )
        .map_err(Self::map_git2_error)?;

        Ok((is_binary.get(), hunks.into_inner()))
    }

    fn classify_change(change: &Change<'_, '_, '_>) -> FileChangeType {
        match change {
            Change::Addition { .. } => FileChangeType::Added,
            Change::Deletion { .. } => FileChangeType::Deleted,
            Change::Modification { .. } => FileChangeType::Modified,
            Change::Rewrite { .. } => FileChangeType::Renamed,
        }
    }
}

/// Collects unified-diff hunks into `fjord_domain::DiffHunk`s, assigning old/new line numbers
/// as it walks each hunk's context/addition/deletion lines in order.
#[derive(Default)]
struct HunkCollector {
    hunks: Vec<DiffHunk>,
}

impl ConsumeHunk for HunkCollector {
    type Out = Vec<DiffHunk>;

    fn consume_hunk(
        &mut self,
        header: HunkHeader,
        lines: &[(gix::diff::blob::unified_diff::DiffLineKind, &[u8])],
    ) -> std::io::Result<()> {
        use gix::diff::blob::unified_diff::DiffLineKind as GixLineKind;

        let mut old_line = header.before_hunk_start;
        let mut new_line = header.after_hunk_start;
        let mut out_lines = Vec::with_capacity(lines.len());

        for (kind, content) in lines {
            let content = String::from_utf8_lossy(content).into_owned();
            let (kind, old_lineno, new_lineno) = match kind {
                GixLineKind::Context => {
                    let line = (Some(old_line), Some(new_line));
                    old_line += 1;
                    new_line += 1;
                    (DiffLineKind::Context, line.0, line.1)
                }
                GixLineKind::Add => {
                    let n = new_line;
                    new_line += 1;
                    (DiffLineKind::Addition, None, Some(n))
                }
                GixLineKind::Remove => {
                    let o = old_line;
                    old_line += 1;
                    (DiffLineKind::Deletion, Some(o), None)
                }
            };
            out_lines.push(DiffLine {
                kind,
                old_lineno,
                new_lineno,
                content,
            });
        }

        self.hunks.push(DiffHunk {
            old_start: header.before_hunk_start,
            old_lines: header.before_hunk_len,
            new_start: header.after_hunk_start,
            new_lines: header.after_hunk_len,
            lines: out_lines,
        });
        Ok(())
    }

    fn finish(self) -> Self::Out {
        self.hunks
    }
}

impl Default for GixGitBackend {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl GitBackend for GixGitBackend {
    async fn status(&self, repo: &RepoPath) -> Result<RepoStatus, GitError> {
        let repo = repo.clone();
        let _repo_guard = Self::acquire_repo_read_lock(&repo).await;
        tokio::task::spawn_blocking(move || {
            let git = Self::open(&repo)?;

            let branch = git
                .head_name()
                .map_err(|e| GitError::Gix(e.to_string()))?
                .map(|name| name.shorten().to_string());

            let dirty_count = git
                .status(gix::progress::Discard)
                .map_err(|e| GitError::Gix(e.to_string()))?
                .into_iter(None)
                .map_err(|e| GitError::Gix(e.to_string()))?
                .filter(|entry| entry.is_ok())
                .count() as u32;

            let has_conflict = Self::has_conflicts(&repo)?;

            // Ahead/behind against the branch's upstream is left at 0 until
            // P2 status-cache work wires up remote-tracking comparison —
            // status/dirty/conflict detection is what the single-repo phases
            // need to prove out first.
            Ok(RepoStatus {
                branch,
                ahead: 0,
                behind: 0,
                dirty_count,
                has_conflict,
            })
        })
        .await
        .map_err(|e| GitError::Gix(e.to_string()))?
    }

    async fn branches(&self, repo: &RepoPath) -> Result<Vec<BranchInfo>, GitError> {
        let repo = repo.clone();
        let _repo_guard = Self::acquire_repo_read_lock(&repo).await;
        tokio::task::spawn_blocking(move || {
            let git = Self::open(&repo)?;
            let current = git
                .head_name()
                .map_err(|e| GitError::Gix(e.to_string()))?
                .map(|name| name.shorten().to_string());

            let platform = git.references().map_err(|e| GitError::Gix(e.to_string()))?;
            let mut out = Vec::new();

            for branch in platform
                .local_branches()
                .map_err(|e| GitError::Gix(e.to_string()))?
            {
                let mut branch = branch.map_err(|e| GitError::Gix(e.to_string()))?;
                let name = branch.name().shorten().to_string();
                let target = branch
                    .peel_to_commit()
                    .map_err(|e| GitError::Gix(e.to_string()))?;
                out.push(BranchInfo {
                    is_current: Some(&name) == current.as_ref(),
                    name,
                    is_remote: false,
                    upstream: None,
                    target_commit_id: CommitId(target.id().to_string()),
                });
            }

            for branch in platform
                .remote_branches()
                .map_err(|e| GitError::Gix(e.to_string()))?
            {
                let mut branch = branch.map_err(|e| GitError::Gix(e.to_string()))?;
                let name = branch.name().shorten().to_string();
                if name
                    .split_once('/')
                    .is_some_and(|(_, local_name)| local_name == "HEAD")
                {
                    continue;
                }
                let target = branch
                    .peel_to_commit()
                    .map_err(|e| GitError::Gix(e.to_string()))?;
                out.push(BranchInfo {
                    name,
                    is_current: false,
                    is_remote: true,
                    upstream: None,
                    target_commit_id: CommitId(target.id().to_string()),
                });
            }

            Ok(out)
        })
        .await
        .map_err(|e| GitError::Gix(e.to_string()))?
    }

    async fn tags(&self, repo: &RepoPath) -> Result<Vec<TagInfo>, GitError> {
        let repo = repo.clone();
        let _repo_guard = Self::acquire_repo_read_lock(&repo).await;
        tokio::task::spawn_blocking(move || {
            let git = Self::open(&repo)?;
            let platform = git.references().map_err(|e| GitError::Gix(e.to_string()))?;
            let mut out = Vec::new();

            for tag in platform.tags().map_err(|e| GitError::Gix(e.to_string()))? {
                let mut tag = tag.map_err(|e| GitError::Gix(e.to_string()))?;
                let name = tag.name().shorten().to_string();
                // Handles both lightweight tags (already a commit) and
                // annotated tags (peels the tag object down to its commit),
                // same as `head.peel_to_commit()` elsewhere in this file.
                let target = tag
                    .peel_to_commit()
                    .map_err(|e| GitError::Gix(e.to_string()))?;
                out.push(TagInfo {
                    name,
                    target_commit_id: CommitId(target.id().to_string()),
                });
            }

            Ok(out)
        })
        .await
        .map_err(|e| GitError::Gix(e.to_string()))?
    }

    async fn log(
        &self,
        repo: &RepoPath,
        from: Option<LogCursor>,
        limit: u32,
    ) -> Result<CommitPage, GitError> {
        let repo = repo.clone();
        let _repo_guard = Self::acquire_repo_read_lock(&repo).await;
        tokio::task::spawn_blocking(move || {
            if limit == 0 {
                return Ok(CommitPage {
                    commits: vec![],
                    next_cursor: None,
                });
            }

            let git = Self::open_git2(&repo)?;
            let mut refs_by_commit = Self::collect_commit_refs(&git)?;
            let offset = Self::log_offset(from);

            let mut walk = git.revwalk().map_err(Self::map_git2_error)?;
            walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME)
                .map_err(Self::map_git2_error)?;
            Self::push_log_refs(&git, &mut walk)?;

            let mut commits = Vec::new();
            let limit = limit as usize;
            let mut next_cursor = None;

            for (index, id) in walk.enumerate().skip(offset) {
                let id = id.map_err(Self::map_git2_error)?;
                if commits.len() >= limit {
                    next_cursor = Some(LogCursor(format!("offset:{index}")));
                    break;
                }
                commits.push(Self::commit_summary(&git, id, &mut refs_by_commit)?);
            }

            Ok(CommitPage {
                commits,
                next_cursor,
            })
        })
        .await
        .map_err(|e| GitError::Git2(e.to_string()))?
    }

    async fn search_commits(
        &self,
        repo: &RepoPath,
        query: &str,
        limit: u32,
    ) -> Result<Vec<CommitSummary>, GitError> {
        let repo = repo.clone();
        let query = query.trim().to_lowercase();
        let _repo_guard = Self::acquire_repo_read_lock(&repo).await;
        tokio::task::spawn_blocking(move || {
            if query.is_empty() || limit == 0 {
                return Ok(vec![]);
            }

            let git = Self::open_git2(&repo)?;
            let mut refs_by_commit = Self::collect_commit_refs(&git)?;
            let mut walk = git.revwalk().map_err(Self::map_git2_error)?;
            walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME)
                .map_err(Self::map_git2_error)?;
            Self::push_log_refs(&git, &mut walk)?;

            let mut commits = Vec::new();
            for id in walk {
                let id = id.map_err(Self::map_git2_error)?;
                let commit = git.find_commit(id).map_err(Self::map_git2_error)?;
                let title = commit.summary().ok().flatten().unwrap_or("").to_lowercase();
                if !title.contains(&query) {
                    continue;
                }

                commits.push(Self::commit_summary(&git, id, &mut refs_by_commit)?);
                if commits.len() >= limit as usize {
                    break;
                }
            }

            Ok(commits)
        })
        .await
        .map_err(|e| GitError::Git2(e.to_string()))?
    }

    async fn diff_files(
        &self,
        repo: &RepoPath,
        commit_id: &str,
    ) -> Result<Vec<FileDiff>, GitError> {
        let repo = repo.clone();
        let commit_id = commit_id.to_string();
        let _repo_guard = Self::acquire_repo_read_lock(&repo).await;
        tokio::task::spawn_blocking(move || {
            let git = Self::open(&repo)?;
            let changes = Self::commit_changes(&git, &commit_id)?;
            Ok(changes
                .iter()
                .map(|change| {
                    let attached = change.attach(&git, &git);
                    FileDiff {
                        path: attached.location().to_string(),
                        change_type: Self::classify_change(&attached),
                        additions: 0,
                        deletions: 0,
                    }
                })
                .collect())
        })
        .await
        .map_err(|e| GitError::Gix(e.to_string()))?
    }

    async fn diff(&self, repo: &RepoPath, commit_id: &str) -> Result<Vec<FileDiff>, GitError> {
        let repo = repo.clone();
        let commit_id = commit_id.to_string();
        let _repo_guard = Self::acquire_repo_read_lock(&repo).await;
        tokio::task::spawn_blocking(move || {
            let git = Self::open(&repo)?;
            let (old_tree, new_tree) = Self::commit_trees(&git, &commit_id)?;
            let changes = Self::tree_changes(&git, old_tree.as_ref(), &new_tree)?;
            let mut line_stats =
                Self::commit_line_stats(&repo, &commit_id, old_tree.as_ref(), &new_tree)?;

            let mut out = Vec::with_capacity(changes.len());
            for change in &changes {
                let attached = change.attach(&git, &git);
                let path = attached.location().to_string();
                let change_type = Self::classify_change(&attached);
                let (additions, deletions) = line_stats.remove(&path).unwrap_or_default();
                out.push(FileDiff {
                    path,
                    change_type,
                    additions,
                    deletions,
                });
            }

            Ok(out)
        })
        .await
        .map_err(|e| GitError::Gix(e.to_string()))?
    }

    async fn file_diff(
        &self,
        repo: &RepoPath,
        commit_id: &str,
        path: &str,
    ) -> Result<FileDiffDetail, GitError> {
        let repo = repo.clone();
        let commit_id = commit_id.to_string();
        let path = path.to_string();
        let _repo_guard = Self::acquire_repo_read_lock(&repo).await;
        tokio::task::spawn_blocking(move || {
            let git = Self::open(&repo)?;
            let changes = Self::commit_changes(&git, &commit_id)?;

            let change = changes
                .iter()
                .find(|change| change.attach(&git, &git).location() == path)
                .ok_or_else(|| {
                    GitError::Gix(format!(
                        "no change found for path '{path}' in commit {commit_id}"
                    ))
                })?;
            let attached = change.attach(&git, &git);
            let change_type = Self::classify_change(&attached);

            let mut resource_cache = git
                .diff_resource_cache_for_tree_diff()
                .map_err(|e| GitError::Gix(e.to_string()))?;
            let platform = attached
                .diff(&mut resource_cache)
                .map_err(|e| GitError::Gix(e.to_string()))?;
            platform
                .resource_cache
                .options
                .skip_internal_diff_if_external_is_configured = false;

            let prep = platform
                .resource_cache
                .prepare_diff()
                .map_err(|e| GitError::Gix(e.to_string()))?;

            let (is_binary, hunks) = match prep.operation {
                Operation::InternalDiff { algorithm } => {
                    let input = prep.interned_input();
                    let diff = gix::diff::blob::diff_with_slider_heuristics(algorithm, &input);
                    let hunks = UnifiedDiff::new(
                        &diff,
                        &input,
                        HunkCollector::default(),
                        ContextSize::symmetrical(3),
                    )
                    .consume()
                    .map_err(|e| GitError::Gix(e.to_string()))?;
                    (false, hunks)
                }
                Operation::ExternalCommand { .. } | Operation::SourceOrDestinationIsBinary => {
                    (true, Vec::new())
                }
            };

            Ok(FileDiffDetail {
                path,
                change_type,
                is_binary,
                hunks,
            })
        })
        .await
        .map_err(|e| GitError::Gix(e.to_string()))?
    }

    async fn working_changes(&self, repo: &RepoPath) -> Result<WorkingChanges, GitError> {
        let repo = repo.clone();
        let _repo_guard = Self::acquire_repo_read_lock(&repo).await;
        tokio::task::spawn_blocking(move || {
            let git = Self::open_git2(&repo)?;
            let mut options = git2::StatusOptions::new();
            options
                .include_untracked(true)
                .recurse_untracked_dirs(true)
                .renames_head_to_index(true)
                .renames_index_to_workdir(true);

            let statuses = git
                .statuses(Some(&mut options))
                .map_err(Self::map_git2_error)?;
            let mut out = WorkingChanges::default();

            for entry in statuses.iter() {
                let status = entry.status();
                let conflicted = status.is_conflicted();

                if let Some(delta) = entry.head_to_index() {
                    let path = delta
                        .new_file()
                        .path()
                        .or_else(|| delta.old_file().path())
                        .map(|p| p.to_string_lossy().into_owned());
                    if let Some(path) = path {
                        out.staged.push(WorkingFile {
                            path,
                            change_type: Self::classify_delta(delta.status()),
                            conflicted,
                        });
                    }
                }

                if let Some(delta) = entry.index_to_workdir() {
                    let path = delta
                        .new_file()
                        .path()
                        .or_else(|| delta.old_file().path())
                        .map(|p| p.to_string_lossy().into_owned());
                    if let Some(path) = path {
                        out.unstaged.push(WorkingFile {
                            path,
                            change_type: Self::classify_delta(delta.status()),
                            conflicted,
                        });
                    }
                }
            }

            Ok(out)
        })
        .await
        .map_err(|e| GitError::Git2(e.to_string()))?
    }

    async fn working_file_diff(
        &self,
        repo: &RepoPath,
        path: &str,
        staged: bool,
    ) -> Result<FileDiffDetail, GitError> {
        let repo = repo.clone();
        let path = path.to_string();
        let _repo_guard = Self::acquire_repo_read_lock(&repo).await;
        tokio::task::spawn_blocking(move || {
            let git = Self::open_git2(&repo)?;
            let mut options = git2::DiffOptions::new();
            options
                .pathspec(&path)
                .include_untracked(true)
                .recurse_untracked_dirs(true)
                .show_untracked_content(true);

            let diff = if staged {
                let head_tree = Self::current_head_commit(&git)?
                    .map(|commit| commit.tree())
                    .transpose()
                    .map_err(Self::map_git2_error)?;
                git.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut options))
                    .map_err(Self::map_git2_error)?
            } else {
                git.diff_index_to_workdir(None, Some(&mut options))
                    .map_err(Self::map_git2_error)?
            };

            let change_type = diff
                .deltas()
                .next()
                .map(|delta| Self::classify_delta(delta.status()))
                .unwrap_or(FileChangeType::Modified);
            let (is_binary, hunks) = Self::collect_git2_diff(&diff)?;

            Ok(FileDiffDetail {
                path,
                change_type,
                is_binary,
                hunks,
            })
        })
        .await
        .map_err(|e| GitError::Git2(e.to_string()))?
    }

    async fn checkout(&self, repo: &RepoPath, branch: &str) -> Result<(), GitError> {
        let repo = repo.clone();
        let branch = branch.to_string();
        let _repo_guard = Self::acquire_repo_write_lock(&repo).await;
        tokio::task::spawn_blocking(move || {
            let git = Self::open_git2(&repo)?;
            let refname = Self::checkout_refname_for_branch(&git, &repo, &branch)?;

            Self::checkout_refname(&git, &refname)
        })
        .await
        .map_err(|e| GitError::Git2(e.to_string()))?
    }

    async fn create_branch(
        &self,
        repo: &RepoPath,
        name: &str,
        checkout: bool,
    ) -> Result<(), GitError> {
        let repo = repo.clone();
        let name = name.to_string();
        let _repo_guard = Self::acquire_repo_write_lock(&repo).await;
        tokio::task::spawn_blocking(move || {
            let git = Self::open_git2(&repo)?;
            let head = Self::current_head_commit(&git)?.ok_or_else(|| {
                GitError::Git2("cannot create a branch before the first commit".to_string())
            })?;

            git.branch(&name, &head, false)
                .map_err(|err| match err.code() {
                    ErrorCode::Exists => GitError::BranchExists(name.clone()),
                    _ => Self::map_git2_error(err),
                })?;

            if checkout {
                Self::checkout_refname(&git, &format!("refs/heads/{name}"))?;
            }
            Ok(())
        })
        .await
        .map_err(|e| GitError::Git2(e.to_string()))?
    }

    async fn create_branch_at(
        &self,
        repo: &RepoPath,
        name: &str,
        target: &str,
        checkout: bool,
    ) -> Result<(), GitError> {
        let repo = repo.clone();
        let name = name.to_string();
        let target = target.to_string();
        let _repo_guard = Self::acquire_repo_write_lock(&repo).await;
        tokio::task::spawn_blocking(move || {
            Self::run_system_git(
                &repo,
                &["branch", &name, &target],
                GitOperationContext::default(),
            )?;
            if checkout {
                Self::run_system_git(&repo, &["checkout", &name], GitOperationContext::default())?;
            }
            Ok(())
        })
        .await
        .map_err(|e| GitError::Git2(e.to_string()))?
    }

    async fn rename_branch(
        &self,
        repo: &RepoPath,
        old_name: &str,
        new_name: &str,
    ) -> Result<(), GitError> {
        let repo = repo.clone();
        let old_name = old_name.to_string();
        let new_name = new_name.to_string();
        let _repo_guard = Self::acquire_repo_write_lock(&repo).await;
        tokio::task::spawn_blocking(move || {
            Self::run_system_git(
                &repo,
                &["branch", "-m", &old_name, &new_name],
                GitOperationContext::default(),
            )
        })
        .await
        .map_err(|e| GitError::Git2(e.to_string()))?
    }

    async fn delete_branch(&self, repo: &RepoPath, name: &str) -> Result<(), GitError> {
        let repo = repo.clone();
        let name = name.to_string();
        let _repo_guard = Self::acquire_repo_write_lock(&repo).await;
        tokio::task::spawn_blocking(move || {
            Self::run_system_git(
                &repo,
                &["branch", "-d", &name],
                GitOperationContext::default(),
            )
        })
        .await
        .map_err(|e| GitError::Git2(e.to_string()))?
    }

    async fn delete_remote_branch(&self, repo: &RepoPath, name: &str) -> Result<(), GitError> {
        let repo = repo.clone();
        let name = name.to_string();
        let _repo_guard = Self::acquire_repo_write_lock(&repo).await;
        tokio::task::spawn_blocking(move || {
            let (remote, branch) = name
                .split_once('/')
                .ok_or_else(|| GitError::Git2(format!("remote branch name is invalid: {name}")))?;
            if remote.is_empty() || branch.is_empty() {
                return Err(GitError::Git2(format!(
                    "remote branch name is invalid: {name}"
                )));
            }
            Self::run_system_git(
                &repo,
                &["push", remote, "--delete", branch],
                GitOperationContext::default(),
            )
        })
        .await
        .map_err(|e| GitError::Git2(e.to_string()))?
    }

    async fn create_tag(&self, repo: &RepoPath, name: &str, target: &str) -> Result<(), GitError> {
        let repo = repo.clone();
        let name = name.to_string();
        let target = target.to_string();
        let _repo_guard = Self::acquire_repo_write_lock(&repo).await;
        tokio::task::spawn_blocking(move || {
            Self::run_system_git(
                &repo,
                &["tag", &name, &target],
                GitOperationContext::default(),
            )
        })
        .await
        .map_err(|e| GitError::Git2(e.to_string()))?
    }

    async fn delete_tag(&self, repo: &RepoPath, name: &str) -> Result<(), GitError> {
        let repo = repo.clone();
        let name = name.to_string();
        let _repo_guard = Self::acquire_repo_write_lock(&repo).await;
        tokio::task::spawn_blocking(move || {
            Self::run_system_git(&repo, &["tag", "-d", &name], GitOperationContext::default())
        })
        .await
        .map_err(|e| GitError::Git2(e.to_string()))?
    }

    async fn cherry_pick(&self, repo: &RepoPath, commit_id: &str) -> Result<(), GitError> {
        let repo = repo.clone();
        let commit_id = commit_id.to_string();
        let _repo_guard = Self::acquire_repo_write_lock(&repo).await;
        tokio::task::spawn_blocking(move || {
            Self::run_system_git(
                &repo,
                &["cherry-pick", &commit_id],
                GitOperationContext::default(),
            )
        })
        .await
        .map_err(|e| GitError::Git2(e.to_string()))?
    }

    async fn revert(&self, repo: &RepoPath, commit_id: &str) -> Result<(), GitError> {
        let repo = repo.clone();
        let commit_id = commit_id.to_string();
        let _repo_guard = Self::acquire_repo_write_lock(&repo).await;
        tokio::task::spawn_blocking(move || {
            Self::run_system_git(
                &repo,
                &["revert", "--no-edit", &commit_id],
                GitOperationContext::default(),
            )
        })
        .await
        .map_err(|e| GitError::Git2(e.to_string()))?
    }

    async fn reset(&self, repo: &RepoPath, commit_id: &str, mode: &str) -> Result<(), GitError> {
        let repo = repo.clone();
        let commit_id = commit_id.to_string();
        let mode = mode.to_string();
        let _repo_guard = Self::acquire_repo_write_lock(&repo).await;
        tokio::task::spawn_blocking(move || {
            let flag = match mode.as_str() {
                "soft" => "--soft",
                "mixed" => "--mixed",
                "hard" => "--hard",
                _ => return Err(GitError::Git2(format!("unknown reset mode: {mode}"))),
            };
            Self::run_system_git(
                &repo,
                &["reset", flag, &commit_id],
                GitOperationContext::default(),
            )
        })
        .await
        .map_err(|e| GitError::Git2(e.to_string()))?
    }

    async fn stashes(&self, repo: &RepoPath) -> Result<Vec<StashEntry>, GitError> {
        let repo = repo.clone();
        let _repo_guard = Self::acquire_repo_read_lock(&repo).await;
        tokio::task::spawn_blocking(move || {
            let mut git = Self::open_git2(&repo)?;
            let mut out = Vec::new();
            git.stash_foreach(|index, message, _oid| {
                out.push(StashEntry {
                    index: index as u32,
                    message: message.to_string(),
                });
                true
            })
            .map_err(Self::map_git2_error)?;
            Ok(out)
        })
        .await
        .map_err(|e| GitError::Git2(e.to_string()))?
    }

    async fn stash_push(&self, repo: &RepoPath, message: Option<&str>) -> Result<(), GitError> {
        let repo = repo.clone();
        let message = message.map(ToString::to_string);
        let _repo_guard = Self::acquire_repo_write_lock(&repo).await;
        tokio::task::spawn_blocking(move || {
            let mut git = Self::open_git2(&repo)?;
            let signature = Self::owned_signature(&git)?;

            match git.stash_save2(
                &signature,
                message.as_deref(),
                Some(StashFlags::INCLUDE_UNTRACKED),
            ) {
                Ok(_) => Ok(()),
                // git2 reports "there is nothing to stash" as NotFound.
                Err(err) if err.code() == ErrorCode::NotFound => Err(GitError::NothingToStash),
                Err(err) => Err(Self::map_git2_error(err)),
            }
        })
        .await
        .map_err(|e| GitError::Git2(e.to_string()))?
    }

    async fn stash_pop(&self, repo: &RepoPath) -> Result<(), GitError> {
        let repo = repo.clone();
        let _repo_guard = Self::acquire_repo_write_lock(&repo).await;
        tokio::task::spawn_blocking(move || {
            let mut git = Self::open_git2(&repo)?;
            match git.stash_pop(0, None) {
                Ok(()) => Ok(()),
                Err(err) if err.code() == ErrorCode::NotFound => Err(GitError::StashEmpty),
                Err(err) => Err(Self::map_git2_error(err)),
            }
        })
        .await
        .map_err(|e| GitError::Git2(e.to_string()))?
    }

    async fn stage(&self, repo: &RepoPath, paths: &[PathBuf]) -> Result<(), GitError> {
        let repo = repo.clone();
        let paths = paths.to_vec();
        let _repo_guard = Self::acquire_repo_write_lock(&repo).await;
        tokio::task::spawn_blocking(move || {
            let git = Self::open_git2(&repo)?;
            let mut index = git.index().map_err(Self::map_git2_error)?;

            // `add_all` rather than `add_path` even for explicit paths: it is
            // the only one that also records *deletions*, so staging a removed
            // file from the commit panel doesn't fail on the missing file.
            if paths.is_empty() {
                index
                    .add_all(["*"], IndexAddOption::DEFAULT, None)
                    .map_err(Self::map_git2_error)?;
            } else {
                index
                    .add_all(paths.iter(), IndexAddOption::DEFAULT, None)
                    .map_err(Self::map_git2_error)?;
            }

            index.write().map_err(Self::map_git2_error)
        })
        .await
        .map_err(|e| GitError::Git2(e.to_string()))?
    }

    async fn unstage(&self, repo: &RepoPath, paths: &[PathBuf]) -> Result<(), GitError> {
        let repo = repo.clone();
        let paths = paths.to_vec();
        let _repo_guard = Self::acquire_repo_write_lock(&repo).await;
        tokio::task::spawn_blocking(move || {
            let git = Self::open_git2(&repo)?;
            let head = git
                .head()
                .ok()
                .and_then(|head| head.peel(git2::ObjectType::Commit).ok());

            if paths.is_empty() {
                git.reset_default(head.as_ref(), ["*"])
                    .map_err(Self::map_git2_error)
            } else {
                git.reset_default(head.as_ref(), paths.iter())
                    .map_err(Self::map_git2_error)
            }
        })
        .await
        .map_err(|e| GitError::Git2(e.to_string()))?
    }

    async fn commit(&self, repo: &RepoPath, message: &str) -> Result<String, GitError> {
        let repo = repo.clone();
        let message = message.to_string();
        let _repo_guard = Self::acquire_repo_write_lock(&repo).await;
        tokio::task::spawn_blocking(move || {
            let git = Self::open_git2(&repo)?;
            let mut index = git.index().map_err(Self::map_git2_error)?;
            if index.has_conflicts() {
                return Err(GitError::Conflict {
                    paths: Self::conflict_paths(&index),
                });
            }

            let tree_oid = index.write_tree().map_err(Self::map_git2_error)?;
            let tree = git.find_tree(tree_oid).map_err(Self::map_git2_error)?;
            let parent_commit = Self::current_head_commit(&git)?;

            if parent_commit
                .as_ref()
                .is_some_and(|parent| parent.tree_id() == tree_oid)
            {
                return Err(GitError::NothingToCommit);
            }

            let signature = git.signature().map_err(Self::map_git2_error)?;
            let parent_refs = parent_commit.iter().collect::<Vec<_>>();
            let oid = git
                .commit(
                    Some("HEAD"),
                    &signature,
                    &signature,
                    &message,
                    &tree,
                    &parent_refs,
                )
                .map_err(Self::map_git2_error)?;
            Ok(oid.to_string())
        })
        .await
        .map_err(|e| GitError::Git2(e.to_string()))?
    }

    async fn upstream_remote(&self, repo: &RepoPath) -> Result<String, GitError> {
        let repo = repo.clone();
        let _repo_guard = Self::acquire_repo_read_lock(&repo).await;
        tokio::task::spawn_blocking(move || {
            let git = Self::open_git2(&repo)?;
            let head_refname = Self::current_branch_refname(&git)?;
            git.branch_upstream_remote(&head_refname)
                .map_err(|error| match error.code() {
                    ErrorCode::NotFound => GitError::NoUpstream,
                    _ => Self::map_git2_error(error),
                })?
                .as_str()
                .map_err(Self::map_git2_error)
                .map(ToString::to_string)
        })
        .await
        .map_err(|error| GitError::Git2(error.to_string()))?
    }

    async fn integrate_upstream(&self, repo: &RepoPath) -> Result<(), GitError> {
        let repo = repo.clone();
        let _repo_guard = Self::acquire_repo_write_lock(&repo).await;
        tokio::task::spawn_blocking(move || {
            let git = Self::open_git2(&repo)?;
            let head = git.head().map_err(Self::map_git2_error)?;
            let head_refname = Self::current_branch_refname(&git)?;
            let upstream_refname = git
                .branch_upstream_name(&head_refname)
                .map_err(|error| match error.code() {
                    ErrorCode::NotFound => GitError::NoUpstream,
                    _ => Self::map_git2_error(error),
                })?
                .as_str()
                .map_err(Self::map_git2_error)?
                .to_string();
            let upstream_ref = git
                .find_reference(&upstream_refname)
                .map_err(Self::map_git2_error)?;
            let remote_commit = git
                .reference_to_annotated_commit(&upstream_ref)
                .map_err(Self::map_git2_error)?;
            let analysis = git
                .merge_analysis(&[&remote_commit])
                .map_err(Self::map_git2_error)?;

            if analysis.0.is_up_to_date() {
                return Ok(());
            }
            if analysis.0.is_fast_forward() {
                return Self::fast_forward(&git, &head_refname, &remote_commit);
            }
            if analysis.0.is_normal() {
                let local_commit = git
                    .reference_to_annotated_commit(&head)
                    .map_err(Self::map_git2_error)?;
                return Self::normal_merge(&git, &local_commit, &remote_commit);
            }
            Ok(())
        })
        .await
        .map_err(|error| GitError::Git2(error.to_string()))?
    }

    async fn current_branch_refspec(&self, repo: &RepoPath) -> Result<String, GitError> {
        let repo = repo.clone();
        let _repo_guard = Self::acquire_repo_read_lock(&repo).await;
        tokio::task::spawn_blocking(move || {
            let git = Self::open_git2(&repo)?;
            let head_refname = Self::current_branch_refname(&git)?;
            Ok(format!("{head_refname}:{head_refname}"))
        })
        .await
        .map_err(|error| GitError::Git2(error.to_string()))?
    }

    async fn fetch(&self, repo: &RepoPath, remote: &str) -> Result<(), GitError> {
        self.fetch_with_context(repo, remote, GitOperationContext::default())
            .await
    }

    async fn fetch_with_context(
        &self,
        repo: &RepoPath,
        remote: &str,
        context: GitOperationContext,
    ) -> Result<(), GitError> {
        let repo = repo.clone();
        let remote = remote.to_string();
        let _repo_guard = Self::acquire_repo_write_lock(&repo).await;
        tokio::task::spawn_blocking(move || {
            Self::fetch_remote_with_system_git(&repo, &remote, &[], context)
        })
        .await
        .map_err(|e| GitError::Git2(e.to_string()))?
    }

    async fn pull(&self, repo: &RepoPath) -> Result<(), GitError> {
        self.pull_with_context(repo, GitOperationContext::default())
            .await
    }

    async fn pull_with_context(
        &self,
        repo: &RepoPath,
        context: GitOperationContext,
    ) -> Result<(), GitError> {
        let repo = repo.clone();
        let _repo_guard = Self::acquire_repo_write_lock(&repo).await;
        tokio::task::spawn_blocking(move || {
            if context.is_cancelled() {
                return Err(GitError::Cancelled);
            }

            let git = Self::open_git2(&repo)?;
            let head = git.head().map_err(Self::map_git2_error)?;
            let head_refname = Self::current_branch_refname(&git)?;

            let upstream_refname = git
                .branch_upstream_name(&head_refname)
                .map_err(|err| match err.code() {
                    ErrorCode::NotFound => GitError::NoUpstream,
                    _ => Self::map_git2_error(err),
                })?
                .as_str()
                .map_err(Self::map_git2_error)?
                .to_string();
            let remote_name = git
                .branch_upstream_remote(&head_refname)
                .map_err(Self::map_git2_error)?
                .as_str()
                .map_err(Self::map_git2_error)?
                .to_string();

            Self::fetch_remote_with_system_git(&repo, &remote_name, &[], context.clone())?;
            if context.is_cancelled() {
                return Err(GitError::Cancelled);
            }

            let upstream_ref = git
                .find_reference(&upstream_refname)
                .map_err(Self::map_git2_error)?;
            let remote_commit = git
                .reference_to_annotated_commit(&upstream_ref)
                .map_err(Self::map_git2_error)?;
            let analysis = git
                .merge_analysis(&[&remote_commit])
                .map_err(Self::map_git2_error)?;

            if analysis.0.is_up_to_date() {
                return Ok(());
            }

            if analysis.0.is_fast_forward() {
                return Self::fast_forward(&git, &head_refname, &remote_commit);
            }

            if analysis.0.is_normal() {
                let local_commit = git
                    .reference_to_annotated_commit(&head)
                    .map_err(Self::map_git2_error)?;
                return Self::normal_merge(&git, &local_commit, &remote_commit);
            }

            Ok(())
        })
        .await
        .map_err(|e| GitError::Git2(e.to_string()))?
    }

    async fn push(&self, repo: &RepoPath, refspec: &str) -> Result<(), GitError> {
        self.push_with_context(repo, refspec, GitOperationContext::default())
            .await
    }

    async fn push_with_context(
        &self,
        repo: &RepoPath,
        refspec: &str,
        context: GitOperationContext,
    ) -> Result<(), GitError> {
        let repo = repo.clone();
        let refspec = refspec.to_string();
        let _repo_guard = Self::acquire_repo_write_lock(&repo).await;
        tokio::task::spawn_blocking(move || {
            if context.is_cancelled() {
                return Err(GitError::Cancelled);
            }

            let git = Self::open_git2(&repo)?;
            let refspec = if refspec.trim().is_empty() {
                let head_refname = Self::current_branch_refname(&git)?;
                format!("{head_refname}:{head_refname}")
            } else {
                refspec
            };

            let mut remote = git.find_remote("origin").map_err(Self::map_git2_error)?;
            let mut options = Self::push_options(context.clone());
            match remote.push(&[refspec.as_str()], Some(&mut options)) {
                Ok(()) => Ok(()),
                Err(error) if error.code() == ErrorCode::Auth && !context.is_cancelled() => {
                    // libgit2 doesn't integrate with Git Credential Manager,
                    // which is the usual credential source for HTTPS remotes
                    // on Windows. Let the system Git ask GCM instead.
                    drop(remote);
                    Self::run_system_git(&repo, &["push", "origin", &refspec], context)
                }
                Err(_error) if context.is_cancelled() => Err(GitError::Cancelled),
                Err(error) => Err(Self::map_git2_error(error)),
            }
        })
        .await
        .map_err(|e| GitError::Git2(e.to_string()))?
    }

    async fn open_merge_tool(&self, repo: &RepoPath) -> Result<(), GitError> {
        let repo = repo.clone();
        let _repo_guard = Self::acquire_repo_write_lock(&repo).await;
        tokio::task::spawn_blocking(move || {
            if !Self::has_conflicts(&repo)? {
                return Err(GitError::NoConflicts);
            }

            Command::new("git")
                .args(["mergetool", "--no-prompt"])
                .current_dir(&repo.0)
                .spawn()
                .map(|_| ())
                .map_err(|e| GitError::MergeToolFailed(e.to_string()))
        })
        .await
        .map_err(|e| GitError::Git2(e.to_string()))?
    }
}

fn parse_numstat_count(value: &[u8]) -> Option<u32> {
    if value == b"-" {
        return Some(0);
    }
    std::str::from_utf8(value).ok()?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::{BranchType, Oid, Repository, RepositoryInitOptions, Status};
    use std::path::Path;
    use tempfile::TempDir;

    /// Runs `status`/`branches`/`log` against *this very repository* as the
    /// fixture — the cheapest possible real integration test, per
    /// docs/SDD.md §8 ("integration tests against real fixture
    /// repositories").
    fn this_repo_path() -> RepoPath {
        let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let repo_root = manifest_dir
            .parent()
            .and_then(|p| p.parent())
            .expect("crates/fjord-git is two levels under the repo root");
        RepoPath(repo_root.to_path_buf())
    }

    fn empty_repo() -> (TempDir, RepoPath) {
        let dir = TempDir::new().unwrap();
        let mut options = RepositoryInitOptions::new();
        options.initial_head("main");
        let repo = Repository::init_opts(dir.path(), &options).unwrap();
        let mut config = repo.config().unwrap();
        config.set_str("user.name", "Fjord Test").unwrap();
        config.set_str("user.email", "fjord@example.com").unwrap();
        // Pin end-of-line handling for the fixture. Without this the repo
        // inherits the developer's global `core.autocrlf`, which on Windows
        // is typically `true` — so git rewrites LF to CRLF when it restores
        // a file (stash pop, checkout) and byte-for-byte content assertions
        // fail on Windows while passing everywhere else. These tests are
        // about git operations, not about EOL conversion.
        config.set_bool("core.autocrlf", false).unwrap();
        let repo_path = RepoPath(dir.path().to_path_buf());
        (dir, repo_path)
    }

    fn write_file(repo: &RepoPath, path: &str, content: &str) {
        std::fs::write(repo.0.join(path), content).unwrap();
    }

    async fn repo_with_changed_head() -> (TempDir, RepoPath, String) {
        let (dir, repo_path) = empty_repo();
        let backend = GixGitBackend::new();

        write_file(&repo_path, "README.md", "base\n");
        backend
            .stage(&repo_path, &[PathBuf::from("README.md")])
            .await
            .unwrap();
        backend.commit(&repo_path, "Initial commit").await.unwrap();

        write_file(&repo_path, "README.md", "base\nupdated\n");
        backend
            .stage(&repo_path, &[PathBuf::from("README.md")])
            .await
            .unwrap();
        let head = backend.commit(&repo_path, "Update readme").await.unwrap();

        (dir, repo_path, head)
    }

    #[tokio::test]
    async fn status_reports_a_branch_name() {
        let backend = GixGitBackend::new();
        let status = backend.status(&this_repo_path()).await.unwrap();
        assert!(status.branch.is_some());
    }

    #[tokio::test]
    async fn branches_includes_the_current_branch() {
        let backend = GixGitBackend::new();
        let branches = backend.branches(&this_repo_path()).await.unwrap();
        assert!(branches.iter().any(|b| b.is_current));
        assert!(branches.iter().all(|b| !b.target_commit_id.0.is_empty()));
    }

    #[tokio::test]
    async fn branches_excludes_remote_head_aliases() {
        let (_dir, repo_path) = empty_repo();
        let backend = GixGitBackend::new();
        write_file(&repo_path, "README.md", "# Fjord\n");
        backend
            .stage(&repo_path, &[PathBuf::from("README.md")])
            .await
            .unwrap();
        backend.commit(&repo_path, "Initial commit").await.unwrap();

        let repo = Repository::open(&repo_path.0).unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        repo.reference("refs/remotes/origin/main", head.id(), true, "seed remote")
            .unwrap();
        repo.reference(
            "refs/remotes/origin/HEAD",
            head.id(),
            true,
            "seed remote head",
        )
        .unwrap();
        drop(head);
        drop(repo);

        let branches = backend.branches(&repo_path).await.unwrap();

        assert!(branches.iter().any(|branch| branch.name == "origin/main"));
        assert!(!branches.iter().any(|branch| branch.name == "origin/HEAD"));
    }

    #[tokio::test]
    async fn tags_resolves_lightweight_and_annotated_tags_to_their_commit() {
        let (_dir, repo_path) = empty_repo();
        let backend = GixGitBackend::new();
        write_file(&repo_path, "README.md", "# Fjord\n");
        backend
            .stage(&repo_path, &[PathBuf::from("README.md")])
            .await
            .unwrap();
        let oid = backend.commit(&repo_path, "Initial commit").await.unwrap();

        let repo = Repository::open(&repo_path.0).unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        repo.tag_lightweight("v1.0.0-lightweight", head.as_object(), false)
            .unwrap();
        let signature = repo.signature().unwrap();
        repo.tag(
            "v1.0.0-annotated",
            head.as_object(),
            &signature,
            "Release",
            false,
        )
        .unwrap();
        drop(head);
        drop(repo);

        let tags = backend.tags(&repo_path).await.unwrap();
        let names: Vec<_> = tags.iter().map(|t| t.name.as_str()).collect();
        assert!(names.contains(&"v1.0.0-lightweight"));
        assert!(names.contains(&"v1.0.0-annotated"));
        assert!(tags.iter().all(|t| t.target_commit_id.0 == oid));
    }

    #[tokio::test]
    async fn log_returns_at_least_one_commit() {
        let backend = GixGitBackend::new();
        let page = backend.log(&this_repo_path(), None, 5).await.unwrap();
        assert!(!page.commits.is_empty());
    }

    #[tokio::test]
    async fn log_includes_commits_from_non_current_branches_with_refs() {
        let (_dir, repo_path) = empty_repo();
        let backend = GixGitBackend::new();
        write_file(&repo_path, "README.md", "main\n");
        backend
            .stage(&repo_path, &[PathBuf::from("README.md")])
            .await
            .unwrap();
        backend.commit(&repo_path, "Initial commit").await.unwrap();

        backend
            .create_branch(&repo_path, "feature", true)
            .await
            .unwrap();
        write_file(&repo_path, "README.md", "feature\n");
        backend
            .stage(&repo_path, &[PathBuf::from("README.md")])
            .await
            .unwrap();
        let feature_oid = backend.commit(&repo_path, "Feature tip").await.unwrap();
        backend.checkout(&repo_path, "main").await.unwrap();

        let page = backend.log(&repo_path, None, 20).await.unwrap();
        let feature = page
            .commits
            .iter()
            .find(|commit| commit.id.0 == feature_oid)
            .expect("log should include non-current branch tip");

        assert!(feature.refs.iter().any(|name| name == "feature"));
    }

    #[tokio::test]
    async fn log_paginates_without_repeating_commits() {
        let (_dir, repo_path) = empty_repo();
        let backend = GixGitBackend::new();
        write_file(&repo_path, "README.md", "one\n");
        backend
            .stage(&repo_path, &[PathBuf::from("README.md")])
            .await
            .unwrap();
        backend.commit(&repo_path, "First").await.unwrap();
        write_file(&repo_path, "README.md", "two\n");
        backend
            .stage(&repo_path, &[PathBuf::from("README.md")])
            .await
            .unwrap();
        backend.commit(&repo_path, "Second").await.unwrap();

        let first = backend.log(&repo_path, None, 1).await.unwrap();
        let second = backend
            .log(&repo_path, first.next_cursor.clone(), 1)
            .await
            .unwrap();

        assert_eq!(first.commits.len(), 1);
        assert_eq!(second.commits.len(), 1);
        assert_ne!(first.commits[0].id, second.commits[0].id);
    }

    #[tokio::test]
    async fn search_commits_matches_titles_across_non_current_branches() {
        let (_dir, repo_path) = empty_repo();
        let backend = GixGitBackend::new();
        write_file(&repo_path, "README.md", "main\n");
        backend
            .stage(&repo_path, &[PathBuf::from("README.md")])
            .await
            .unwrap();
        backend.commit(&repo_path, "Initial commit").await.unwrap();

        backend
            .create_branch(&repo_path, "feature/search", true)
            .await
            .unwrap();
        write_file(&repo_path, "README.md", "feature\n");
        backend
            .stage(&repo_path, &[PathBuf::from("README.md")])
            .await
            .unwrap();
        let feature_oid = backend
            .commit(&repo_path, "Needle result commit")
            .await
            .unwrap();
        backend.checkout(&repo_path, "main").await.unwrap();

        let commits = backend
            .search_commits(&repo_path, "needle result", 10)
            .await
            .unwrap();

        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].id.0, feature_oid);
        assert!(commits[0].refs.iter().any(|name| name == "feature/search"));
    }

    #[tokio::test]
    async fn diff_reports_changed_files_for_head() {
        let (_dir, repo_path, head) = repo_with_changed_head().await;
        let backend = GixGitBackend::new();

        let files = backend.diff(&repo_path, &head).await.unwrap();

        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "README.md");
        assert_eq!(files[0].change_type, FileChangeType::Modified);
        assert_eq!(files[0].additions, 1);
        assert_eq!(files[0].deletions, 0);
    }

    #[tokio::test]
    async fn diff_files_returns_tree_metadata_without_line_work() {
        let (_dir, repo_path, head) = repo_with_changed_head().await;
        let backend = GixGitBackend::new();

        let files = backend.diff_files(&repo_path, &head).await.unwrap();

        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "README.md");
        assert_eq!(files[0].change_type, FileChangeType::Modified);
        assert_eq!((files[0].additions, files[0].deletions), (0, 0));
    }

    #[tokio::test]
    async fn diff_reports_files_for_a_root_commit() {
        let (_dir, repo_path) = empty_repo();
        let backend = GixGitBackend::new();
        write_file(&repo_path, "README.md", "first line\nsecond line\n");
        backend
            .stage(&repo_path, &[PathBuf::from("README.md")])
            .await
            .unwrap();
        let root = backend.commit(&repo_path, "Root commit").await.unwrap();

        let files = backend.diff(&repo_path, &root).await.unwrap();

        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "README.md");
        assert_eq!(files[0].change_type, FileChangeType::Added);
        assert_eq!(files[0].additions, 2);
        assert_eq!(files[0].deletions, 0);
    }

    #[test]
    fn numstat_parser_handles_binary_files_and_tabs_in_paths() {
        let parsed = GixGitBackend::parse_numstat(
            b"12\t3\tsrc/file.rs\0-\t-\tassets/image.png\x001\t0\tpath/with\ttab.txt\0",
        );

        assert_eq!(parsed.get("src/file.rs"), Some(&(12, 3)));
        assert_eq!(parsed.get("assets/image.png"), Some(&(0, 0)));
        assert_eq!(parsed.get("path/with\ttab.txt"), Some(&(1, 0)));
    }

    #[tokio::test]
    async fn file_diff_reports_hunks_for_a_file_changed_in_head() {
        let (_dir, repo_path, head) = repo_with_changed_head().await;
        let backend = GixGitBackend::new();

        let detail = backend
            .file_diff(&repo_path, &head, "README.md")
            .await
            .unwrap();
        assert_eq!(detail.path, "README.md");
        assert!(!detail.is_binary);
        assert!(!detail.hunks.is_empty());
        assert!(detail
            .hunks
            .iter()
            .flat_map(|hunk| hunk.lines.iter())
            .any(|line| line.kind == DiffLineKind::Addition && line.content == "updated"));
    }

    #[tokio::test]
    async fn stage_and_commit_create_head_commit() {
        let (_dir, repo_path) = empty_repo();
        let backend = GixGitBackend::new();
        write_file(&repo_path, "README.md", "# Fjord\n");

        backend
            .stage(&repo_path, &[PathBuf::from("README.md")])
            .await
            .unwrap();
        let oid = backend.commit(&repo_path, "Initial commit").await.unwrap();

        let repo = Repository::open(&repo_path.0).unwrap();
        assert_eq!(
            repo.head()
                .unwrap()
                .peel_to_commit()
                .unwrap()
                .id()
                .to_string(),
            oid
        );
    }

    #[tokio::test]
    async fn unstage_removes_index_change_without_touching_worktree() {
        let (_dir, repo_path) = empty_repo();
        let backend = GixGitBackend::new();
        write_file(&repo_path, "README.md", "first\n");
        backend
            .stage(&repo_path, &[PathBuf::from("README.md")])
            .await
            .unwrap();
        backend.commit(&repo_path, "Initial commit").await.unwrap();

        write_file(&repo_path, "README.md", "second\n");
        backend
            .stage(&repo_path, &[PathBuf::from("README.md")])
            .await
            .unwrap();
        backend
            .unstage(&repo_path, &[PathBuf::from("README.md")])
            .await
            .unwrap();

        let status = Repository::open(&repo_path.0)
            .unwrap()
            .status_file(Path::new("README.md"))
            .unwrap();
        assert!(!status.contains(Status::INDEX_MODIFIED));
        assert!(status.contains(Status::WT_MODIFIED));
    }

    #[tokio::test]
    async fn checkout_switches_local_branch() {
        let (_dir, repo_path) = empty_repo();
        let backend = GixGitBackend::new();
        write_file(&repo_path, "README.md", "# Fjord\n");
        backend
            .stage(&repo_path, &[PathBuf::from("README.md")])
            .await
            .unwrap();
        backend.commit(&repo_path, "Initial commit").await.unwrap();

        let repo = Repository::open(&repo_path.0).unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("feature", &head, false).unwrap();
        drop(head);
        drop(repo);

        backend.checkout(&repo_path, "feature").await.unwrap();

        let repo = Repository::open(&repo_path.0).unwrap();
        assert_eq!(repo.head().unwrap().shorthand().unwrap(), "feature");
    }

    #[tokio::test]
    async fn checkout_remote_branch_creates_local_tracking_branch() {
        let (_dir, repo_path) = empty_repo();
        let remote_dir = TempDir::new().unwrap();
        Repository::init_bare(remote_dir.path()).unwrap();

        let backend = GixGitBackend::new();
        write_file(&repo_path, "README.md", "# Fjord\n");
        backend
            .stage(&repo_path, &[PathBuf::from("README.md")])
            .await
            .unwrap();
        backend.commit(&repo_path, "Initial commit").await.unwrap();

        let repo = Repository::open(&repo_path.0).unwrap();
        repo.remote("origin", remote_dir.path().to_str().unwrap())
            .unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("feature", &head, false).unwrap();
        drop(head);
        drop(repo);

        backend
            .push(&repo_path, "refs/heads/feature:refs/heads/feature")
            .await
            .unwrap();

        Repository::open(&repo_path.0)
            .unwrap()
            .find_branch("feature", BranchType::Local)
            .unwrap()
            .delete()
            .unwrap();

        backend
            .checkout(&repo_path, "origin/feature")
            .await
            .unwrap();

        let repo = Repository::open(&repo_path.0).unwrap();
        assert_eq!(repo.head().unwrap().shorthand().unwrap(), "feature");
        let branch = repo.find_branch("feature", BranchType::Local).unwrap();
        assert_eq!(
            branch.upstream().unwrap().name().unwrap(),
            Some("origin/feature")
        );
    }

    #[tokio::test]
    async fn checkout_remote_branch_fast_forwards_existing_local_branch() {
        let (_dir, repo_path) = empty_repo();
        let remote_dir = TempDir::new().unwrap();
        Repository::init_bare(remote_dir.path()).unwrap();

        let backend = GixGitBackend::new();
        write_file(&repo_path, "README.md", "main\n");
        backend
            .stage(&repo_path, &[PathBuf::from("README.md")])
            .await
            .unwrap();
        backend.commit(&repo_path, "Initial commit").await.unwrap();

        Repository::open(&repo_path.0)
            .unwrap()
            .remote("origin", remote_dir.path().to_str().unwrap())
            .unwrap();
        backend
            .push(&repo_path, "refs/heads/main:refs/heads/main")
            .await
            .unwrap();

        backend
            .create_branch(&repo_path, "feature", true)
            .await
            .unwrap();
        write_file(&repo_path, "README.md", "feature v1\n");
        backend
            .stage(&repo_path, &[PathBuf::from("README.md")])
            .await
            .unwrap();
        let stale_oid = backend.commit(&repo_path, "Feature v1").await.unwrap();
        backend
            .push(&repo_path, "refs/heads/feature:refs/heads/feature")
            .await
            .unwrap();
        backend.checkout(&repo_path, "main").await.unwrap();

        let clone_dir = TempDir::new().unwrap();
        Repository::clone(remote_dir.path().to_str().unwrap(), clone_dir.path()).unwrap();
        let clone_path = RepoPath(clone_dir.path().to_path_buf());
        let clone = Repository::open(&clone_path.0).unwrap();
        let mut config = clone.config().unwrap();
        config.set_str("user.name", "Fjord Test").unwrap();
        config.set_str("user.email", "fjord@example.com").unwrap();
        config.set_bool("core.autocrlf", false).unwrap();
        let feature = clone
            .find_reference("refs/remotes/origin/feature")
            .unwrap()
            .peel_to_commit()
            .unwrap();
        clone.branch("feature", &feature, false).unwrap();
        clone.set_head("refs/heads/feature").unwrap();
        clone
            .checkout_head(Some(CheckoutBuilder::new().safe()))
            .unwrap();
        drop(feature);
        drop(config);
        drop(clone);

        write_file(&clone_path, "README.md", "feature v2\n");
        backend
            .stage(&clone_path, &[PathBuf::from("README.md")])
            .await
            .unwrap();
        let remote_oid = backend.commit(&clone_path, "Feature v2").await.unwrap();
        backend
            .push(&clone_path, "refs/heads/feature:refs/heads/feature")
            .await
            .unwrap();

        backend
            .checkout(&repo_path, "origin/feature")
            .await
            .unwrap();

        let repo = Repository::open(&repo_path.0).unwrap();
        assert_eq!(repo.head().unwrap().shorthand().unwrap(), "feature");
        assert_eq!(
            repo.find_reference("refs/heads/feature")
                .unwrap()
                .target()
                .unwrap(),
            Oid::from_str(&remote_oid).unwrap()
        );
        assert_ne!(stale_oid, remote_oid);
        assert_eq!(
            std::fs::read_to_string(repo_path.0.join("README.md")).unwrap(),
            "feature v2\n"
        );
    }

    #[tokio::test]
    async fn working_changes_separates_staged_from_unstaged() {
        let (_dir, repo_path) = empty_repo();
        let backend = GixGitBackend::new();
        write_file(&repo_path, "README.md", "first\n");
        backend
            .stage(&repo_path, &[PathBuf::from("README.md")])
            .await
            .unwrap();
        backend.commit(&repo_path, "Initial commit").await.unwrap();

        // One staged edit, one untracked file left alone.
        write_file(&repo_path, "README.md", "second\n");
        backend
            .stage(&repo_path, &[PathBuf::from("README.md")])
            .await
            .unwrap();
        write_file(&repo_path, "NOTES.md", "scratch\n");

        let changes = backend.working_changes(&repo_path).await.unwrap();

        assert_eq!(changes.staged.len(), 1);
        assert_eq!(changes.staged[0].path, "README.md");
        assert_eq!(changes.staged[0].change_type, FileChangeType::Modified);
        assert_eq!(changes.unstaged.len(), 1);
        assert_eq!(changes.unstaged[0].path, "NOTES.md");
        assert_eq!(changes.unstaged[0].change_type, FileChangeType::Added);
    }

    #[tokio::test]
    async fn working_file_diff_reads_staged_and_unstaged_sides_separately() {
        let (_dir, repo_path) = empty_repo();
        let backend = GixGitBackend::new();
        write_file(&repo_path, "README.md", "base\n");
        backend
            .stage(&repo_path, &[PathBuf::from("README.md")])
            .await
            .unwrap();
        backend.commit(&repo_path, "Initial commit").await.unwrap();

        write_file(&repo_path, "README.md", "staged\n");
        backend
            .stage(&repo_path, &[PathBuf::from("README.md")])
            .await
            .unwrap();
        write_file(&repo_path, "README.md", "worktree\n");

        let staged = backend
            .working_file_diff(&repo_path, "README.md", true)
            .await
            .unwrap();
        let unstaged = backend
            .working_file_diff(&repo_path, "README.md", false)
            .await
            .unwrap();

        let added = |detail: &FileDiffDetail| {
            detail
                .hunks
                .iter()
                .flat_map(|hunk| hunk.lines.iter())
                .filter(|line| line.kind == DiffLineKind::Addition)
                .map(|line| line.content.clone())
                .collect::<Vec<_>>()
        };

        assert_eq!(
            added(&staged),
            vec!["staged"],
            "staged side is index vs HEAD"
        );
        assert_eq!(
            added(&unstaged),
            vec!["worktree"],
            "unstaged side is worktree vs index"
        );
    }

    #[tokio::test]
    async fn staging_a_deleted_file_records_the_deletion() {
        let (_dir, repo_path) = empty_repo();
        let backend = GixGitBackend::new();
        write_file(&repo_path, "README.md", "base\n");
        backend
            .stage(&repo_path, &[PathBuf::from("README.md")])
            .await
            .unwrap();
        backend.commit(&repo_path, "Initial commit").await.unwrap();

        std::fs::remove_file(repo_path.0.join("README.md")).unwrap();
        backend
            .stage(&repo_path, &[PathBuf::from("README.md")])
            .await
            .unwrap();

        let changes = backend.working_changes(&repo_path).await.unwrap();
        assert_eq!(changes.staged.len(), 1);
        assert_eq!(changes.staged[0].change_type, FileChangeType::Deleted);
        assert!(changes.unstaged.is_empty());
    }

    #[tokio::test]
    async fn create_branch_optionally_switches_to_it() {
        let (_dir, repo_path) = empty_repo();
        let backend = GixGitBackend::new();
        write_file(&repo_path, "README.md", "# Fjord\n");
        backend
            .stage(&repo_path, &[PathBuf::from("README.md")])
            .await
            .unwrap();
        backend.commit(&repo_path, "Initial commit").await.unwrap();

        backend
            .create_branch(&repo_path, "feature/a", false)
            .await
            .unwrap();
        assert_eq!(
            Repository::open(&repo_path.0)
                .unwrap()
                .head()
                .unwrap()
                .shorthand()
                .unwrap(),
            "main",
            "creating without checkout must leave HEAD alone"
        );

        backend
            .create_branch(&repo_path, "feature/b", true)
            .await
            .unwrap();
        assert_eq!(
            Repository::open(&repo_path.0)
                .unwrap()
                .head()
                .unwrap()
                .shorthand()
                .unwrap(),
            "feature/b"
        );
    }

    #[tokio::test]
    async fn create_branch_rejects_an_existing_name() {
        let (_dir, repo_path) = empty_repo();
        let backend = GixGitBackend::new();
        write_file(&repo_path, "README.md", "# Fjord\n");
        backend
            .stage(&repo_path, &[PathBuf::from("README.md")])
            .await
            .unwrap();
        backend.commit(&repo_path, "Initial commit").await.unwrap();

        backend
            .create_branch(&repo_path, "feature", false)
            .await
            .unwrap();
        let result = backend.create_branch(&repo_path, "feature", false).await;

        assert!(matches!(result, Err(GitError::BranchExists(name)) if name == "feature"));
    }

    #[tokio::test]
    async fn context_menu_ref_operations_update_real_git_refs() {
        let (_dir, repo_path) = empty_repo();
        let backend = GixGitBackend::new();
        write_file(&repo_path, "README.md", "base\n");
        backend
            .stage(&repo_path, &[PathBuf::from("README.md")])
            .await
            .unwrap();
        let base = backend.commit(&repo_path, "Initial commit").await.unwrap();

        backend
            .create_branch_at(&repo_path, "feature/menu", &base, true)
            .await
            .unwrap();
        backend
            .rename_branch(&repo_path, "feature/menu", "feature/context-menu")
            .await
            .unwrap();
        backend
            .create_tag(&repo_path, "v-context", &base)
            .await
            .unwrap();

        let git = Repository::open(&repo_path.0).unwrap();
        assert_eq!(
            git.head().unwrap().shorthand().unwrap(),
            "feature/context-menu"
        );
        assert!(git.find_reference("refs/tags/v-context").is_ok());
        drop(git);

        backend.delete_tag(&repo_path, "v-context").await.unwrap();
        backend.checkout(&repo_path, "main").await.unwrap();
        backend
            .delete_branch(&repo_path, "feature/context-menu")
            .await
            .unwrap();

        let git = Repository::open(&repo_path.0).unwrap();
        assert!(git.find_reference("refs/tags/v-context").is_err());
        assert!(git
            .find_reference("refs/heads/feature/context-menu")
            .is_err());
    }

    #[tokio::test]
    async fn context_menu_commit_operations_cherry_pick_revert_and_reset() {
        let (_dir, repo_path) = empty_repo();
        let backend = GixGitBackend::new();
        write_file(&repo_path, "README.md", "base\n");
        backend
            .stage(&repo_path, &[PathBuf::from("README.md")])
            .await
            .unwrap();
        let base = backend.commit(&repo_path, "Initial commit").await.unwrap();
        write_file(&repo_path, "README.md", "next\n");
        backend
            .stage(&repo_path, &[PathBuf::from("README.md")])
            .await
            .unwrap();
        let next = backend.commit(&repo_path, "Second commit").await.unwrap();

        backend.reset(&repo_path, &base, "hard").await.unwrap();
        assert_eq!(
            std::fs::read_to_string(repo_path.0.join("README.md")).unwrap(),
            "base\n"
        );

        backend.cherry_pick(&repo_path, &next).await.unwrap();
        assert_eq!(
            std::fs::read_to_string(repo_path.0.join("README.md")).unwrap(),
            "next\n"
        );
        backend.revert(&repo_path, &next).await.unwrap();
        assert_eq!(
            std::fs::read_to_string(repo_path.0.join("README.md")).unwrap(),
            "base\n"
        );
    }

    #[tokio::test]
    async fn stash_push_then_pop_round_trips_a_dirty_worktree() {
        let (_dir, repo_path) = empty_repo();
        let backend = GixGitBackend::new();
        write_file(&repo_path, "README.md", "committed\n");
        backend
            .stage(&repo_path, &[PathBuf::from("README.md")])
            .await
            .unwrap();
        backend.commit(&repo_path, "Initial commit").await.unwrap();

        write_file(&repo_path, "README.md", "work in progress\n");
        backend.stash_push(&repo_path, Some("wip")).await.unwrap();

        assert_eq!(
            std::fs::read_to_string(repo_path.0.join("README.md")).unwrap(),
            "committed\n",
            "stashing must restore the committed content"
        );
        let stashes = backend.stashes(&repo_path).await.unwrap();
        assert_eq!(stashes.len(), 1);
        assert_eq!(stashes[0].index, 0);
        assert!(stashes[0].message.contains("wip"));

        backend.stash_pop(&repo_path).await.unwrap();

        assert_eq!(
            std::fs::read_to_string(repo_path.0.join("README.md")).unwrap(),
            "work in progress\n"
        );
        assert!(backend.stashes(&repo_path).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn stash_push_on_a_clean_worktree_reports_nothing_to_stash() {
        let (_dir, repo_path) = empty_repo();
        let backend = GixGitBackend::new();
        write_file(&repo_path, "README.md", "committed\n");
        backend
            .stage(&repo_path, &[PathBuf::from("README.md")])
            .await
            .unwrap();
        backend.commit(&repo_path, "Initial commit").await.unwrap();

        let result = backend.stash_push(&repo_path, None).await;

        assert!(matches!(result, Err(GitError::NothingToStash)));
    }

    #[tokio::test]
    async fn stash_pop_on_an_empty_stack_reports_stash_empty() {
        let (_dir, repo_path) = empty_repo();
        let backend = GixGitBackend::new();
        write_file(&repo_path, "README.md", "committed\n");
        backend
            .stage(&repo_path, &[PathBuf::from("README.md")])
            .await
            .unwrap();
        backend.commit(&repo_path, "Initial commit").await.unwrap();

        let result = backend.stash_pop(&repo_path).await;

        assert!(matches!(result, Err(GitError::StashEmpty)));
    }

    #[tokio::test]
    async fn failed_checkout_keeps_head_on_original_branch() {
        let (_dir, repo_path) = empty_repo();
        let backend = GixGitBackend::new();
        write_file(&repo_path, "README.md", "base\n");
        backend
            .stage(&repo_path, &[PathBuf::from("README.md")])
            .await
            .unwrap();
        backend.commit(&repo_path, "Initial commit").await.unwrap();

        let repo = Repository::open(&repo_path.0).unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("feature", &head, false).unwrap();
        drop(head);
        drop(repo);

        backend.checkout(&repo_path, "feature").await.unwrap();
        write_file(&repo_path, "README.md", "feature\n");
        backend
            .stage(&repo_path, &[PathBuf::from("README.md")])
            .await
            .unwrap();
        backend.commit(&repo_path, "Feature change").await.unwrap();

        backend.checkout(&repo_path, "main").await.unwrap();
        write_file(&repo_path, "README.md", "local edit\n");

        let result = backend.checkout(&repo_path, "feature").await;

        assert!(result.is_err());
        let repo = Repository::open(&repo_path.0).unwrap();
        assert_eq!(repo.head().unwrap().shorthand().unwrap(), "main");
        assert_eq!(
            std::fs::read_to_string(repo_path.0.join("README.md")).unwrap(),
            "local edit\n"
        );
    }

    #[tokio::test]
    async fn push_updates_origin_branch() {
        let (_local_dir, repo_path) = empty_repo();
        let remote_dir = TempDir::new().unwrap();
        Repository::init_bare(remote_dir.path()).unwrap();

        let backend = GixGitBackend::new();
        write_file(&repo_path, "README.md", "# Fjord\n");
        backend
            .stage(&repo_path, &[PathBuf::from("README.md")])
            .await
            .unwrap();
        let local_oid = backend.commit(&repo_path, "Initial commit").await.unwrap();

        Repository::open(&repo_path.0)
            .unwrap()
            .remote("origin", remote_dir.path().to_str().unwrap())
            .unwrap();

        backend.push(&repo_path, "").await.unwrap();

        let remote = Repository::open_bare(remote_dir.path()).unwrap();
        let remote_oid = remote
            .find_reference("refs/heads/main")
            .unwrap()
            .target()
            .unwrap();
        assert_eq!(remote_oid.to_string(), local_oid);
    }

    #[tokio::test]
    async fn delete_remote_branch_removes_the_origin_ref() {
        let (_local_dir, repo_path) = empty_repo();
        let remote_dir = TempDir::new().unwrap();
        Repository::init_bare(remote_dir.path()).unwrap();
        let backend = GixGitBackend::new();
        write_file(&repo_path, "README.md", "# Fjord\n");
        backend
            .stage(&repo_path, &[PathBuf::from("README.md")])
            .await
            .unwrap();
        backend.commit(&repo_path, "Initial commit").await.unwrap();

        let repo = Repository::open(&repo_path.0).unwrap();
        repo.remote("origin", remote_dir.path().to_str().unwrap())
            .unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("feature/remove-me", &head, false).unwrap();
        drop(head);
        drop(repo);
        backend
            .push(
                &repo_path,
                "refs/heads/feature/remove-me:refs/heads/feature/remove-me",
            )
            .await
            .unwrap();

        backend
            .delete_remote_branch(&repo_path, "origin/feature/remove-me")
            .await
            .unwrap();

        let remote = Repository::open_bare(remote_dir.path()).unwrap();
        assert!(remote
            .find_reference("refs/heads/feature/remove-me")
            .is_err());
    }

    #[tokio::test]
    async fn status_reports_merge_conflicts() {
        let (_dir, repo_path) = empty_repo();
        let backend = GixGitBackend::new();
        write_file(&repo_path, "README.md", "base\n");
        backend
            .stage(&repo_path, &[PathBuf::from("README.md")])
            .await
            .unwrap();
        backend.commit(&repo_path, "Initial commit").await.unwrap();

        let repo = Repository::open(&repo_path.0).unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("feature", &head, false).unwrap();
        drop(head);
        drop(repo);

        backend.checkout(&repo_path, "feature").await.unwrap();
        write_file(&repo_path, "README.md", "feature\n");
        backend
            .stage(&repo_path, &[PathBuf::from("README.md")])
            .await
            .unwrap();
        backend.commit(&repo_path, "Feature change").await.unwrap();

        backend.checkout(&repo_path, "main").await.unwrap();
        write_file(&repo_path, "README.md", "main\n");
        backend
            .stage(&repo_path, &[PathBuf::from("README.md")])
            .await
            .unwrap();
        backend.commit(&repo_path, "Main change").await.unwrap();

        let repo = Repository::open(&repo_path.0).unwrap();
        let feature_ref = repo.find_reference("refs/heads/feature").unwrap();
        let feature = repo.reference_to_annotated_commit(&feature_ref).unwrap();
        let mut checkout = CheckoutBuilder::new();
        checkout.allow_conflicts(true).conflict_style_merge(true);
        repo.merge(&[&feature], None, Some(&mut checkout)).unwrap();

        let status = backend.status(&repo_path).await.unwrap();
        assert!(status.has_conflict);
    }

    #[tokio::test]
    async fn open_merge_tool_requires_conflicts() {
        let (_dir, repo_path) = empty_repo();
        let backend = GixGitBackend::new();

        let result = backend.open_merge_tool(&repo_path).await;

        assert!(matches!(result, Err(GitError::NoConflicts)));
    }
}
