//! Commit, stash, merge, and the other operations that rewrite repository state.

use super::*;

impl LocalGitBackend {
    pub(super) fn fast_forward(
        git: &git2::Repository,
        local_refname: &str,
        remote_commit: &git2::AnnotatedCommit<'_>,
    ) -> Result<(), GitError> {
        // Update the index/worktree while HEAD still points at the old tree.
        // Moving the reference first makes libgit2 see an already-current HEAD
        // and leaves the worktree stale even though the ref advanced.
        let target = git
            .find_object(remote_commit.id(), Some(git2::ObjectType::Commit))
            .map_err(Self::map_git2_error)?;
        let mut checkout = CheckoutBuilder::new();
        checkout.safe();
        git.checkout_tree(&target, Some(&mut checkout))
            .map_err(Self::map_git2_error)?;

        let mut local_ref = git
            .find_reference(local_refname)
            .map_err(Self::map_git2_error)?;
        local_ref
            .set_target(
                remote_commit.id(),
                &format!("Fast-forward {local_refname} to {}", remote_commit.id()),
            )
            .map_err(Self::map_git2_error)?;
        git.set_head(local_refname).map_err(Self::map_git2_error)
    }

    pub(super) fn normal_merge(
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
        let mut checkout = CheckoutBuilder::new();
        checkout
            .safe()
            .allow_conflicts(true)
            .conflict_style_merge(true);
        git.merge(&[remote_commit], None, Some(&mut checkout))
            .map_err(Self::map_git2_error)?;
        let mut index = Self::fresh_index(git)?;

        if index.has_conflicts() {
            let paths = Self::conflict_paths(&index);
            return Err(GitError::Conflict { paths });
        }

        let tree_oid = index.write_tree().map_err(Self::map_git2_error)?;
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
        git.cleanup_state().map_err(Self::map_git2_error)?;
        Ok(())
    }
}

pub(super) async fn cherry_pick(
    commands: &GitCommandFactory,
    repo: &RepoPath,
    commit_id: &str,
) -> Result<(), GitError> {
    let commands = commands.clone();
    let repo = repo.clone();
    let commit_id = commit_id.to_string();
    let _repo_guard = LocalGitBackend::acquire_repo_write_lock(&repo).await;
    tokio::task::spawn_blocking(move || {
        LocalGitBackend::run_local_git(&commands, &repo, &["cherry-pick", &commit_id])
    })
    .await
    .map_err(|e| GitError::Git2(e.to_string()))?
}

pub(super) async fn revert(
    commands: &GitCommandFactory,
    repo: &RepoPath,
    commit_id: &str,
) -> Result<(), GitError> {
    let commands = commands.clone();
    let repo = repo.clone();
    let commit_id = commit_id.to_string();
    let _repo_guard = LocalGitBackend::acquire_repo_write_lock(&repo).await;
    tokio::task::spawn_blocking(move || {
        LocalGitBackend::run_local_git(&commands, &repo, &["revert", "--no-edit", &commit_id])
    })
    .await
    .map_err(|e| GitError::Git2(e.to_string()))?
}

pub(super) async fn reset(
    commands: &GitCommandFactory,
    repo: &RepoPath,
    commit_id: &str,
    mode: &str,
) -> Result<(), GitError> {
    let commands = commands.clone();
    let repo = repo.clone();
    let commit_id = commit_id.to_string();
    let mode = mode.to_string();
    let _repo_guard = LocalGitBackend::acquire_repo_write_lock(&repo).await;
    tokio::task::spawn_blocking(move || {
        let flag = match mode.as_str() {
            "soft" => "--soft",
            "mixed" => "--mixed",
            "hard" => "--hard",
            _ => return Err(GitError::Git2(format!("unknown reset mode: {mode}"))),
        };
        LocalGitBackend::run_local_git(&commands, &repo, &["reset", flag, &commit_id])
    })
    .await
    .map_err(|e| GitError::Git2(e.to_string()))?
}

pub(super) async fn stash_push(repo: &RepoPath, message: Option<&str>) -> Result<(), GitError> {
    let repo = repo.clone();
    let message = message.map(ToString::to_string);
    let _repo_guard = LocalGitBackend::acquire_repo_write_lock(&repo).await;
    tokio::task::spawn_blocking(move || {
        LocalGitBackend::with_runtime_git2(&repo, |git| {
            let signature = LocalGitBackend::owned_signature(git)?;

            match git.stash_save2(
                &signature,
                message.as_deref(),
                Some(StashFlags::INCLUDE_UNTRACKED),
            ) {
                Ok(_) => Ok(()),
                // git2 reports "there is nothing to stash" as NotFound.
                Err(err) if err.code() == ErrorCode::NotFound => Err(GitError::NothingToStash),
                Err(err) => Err(LocalGitBackend::map_git2_error(err)),
            }
        })
    })
    .await
    .map_err(|e| GitError::Git2(e.to_string()))?
}

pub(super) async fn stash_pop(repo: &RepoPath) -> Result<(), GitError> {
    let repo = repo.clone();
    let _repo_guard = LocalGitBackend::acquire_repo_write_lock(&repo).await;
    tokio::task::spawn_blocking(move || {
        LocalGitBackend::with_runtime_git2(&repo, |git| match git.stash_pop(0, None) {
            Ok(()) => Ok(()),
            Err(err) if err.code() == ErrorCode::NotFound => Err(GitError::StashEmpty),
            Err(err) => Err(LocalGitBackend::map_git2_error(err)),
        })
    })
    .await
    .map_err(|e| GitError::Git2(e.to_string()))?
}

pub(super) async fn commit(
    repo: &RepoPath,
    message: &str,
    amend: bool,
) -> Result<String, GitError> {
    let repo = repo.clone();
    let message = message.to_string();
    let _repo_guard = LocalGitBackend::acquire_repo_write_lock(&repo).await;
    tokio::task::spawn_blocking(move || {
        LocalGitBackend::with_runtime_git2(&repo, |git| {
            let mut index = LocalGitBackend::fresh_index(git)?;
            if index.has_conflicts() {
                return Err(GitError::Conflict {
                    paths: LocalGitBackend::conflict_paths(&index),
                });
            }

            let tree_oid = index
                .write_tree()
                .map_err(LocalGitBackend::map_git2_error)?;
            let tree = git
                .find_tree(tree_oid)
                .map_err(LocalGitBackend::map_git2_error)?;
            let head_commit = LocalGitBackend::current_head_commit(git)?;

            if !amend
                && head_commit
                    .as_ref()
                    .is_some_and(|parent| parent.tree_id() == tree_oid)
            {
                return Err(GitError::NothingToCommit);
            }

            let committer = git.signature().map_err(LocalGitBackend::map_git2_error)?;
            let author = if amend {
                head_commit
                    .as_ref()
                    .ok_or(GitError::NothingToCommit)?
                    .author()
            } else {
                committer.clone()
            };
            let parent_commits = if amend {
                head_commit
                    .as_ref()
                    .expect("amend HEAD checked above")
                    .parents()
                    .collect::<Vec<_>>()
            } else {
                head_commit.iter().cloned().collect::<Vec<_>>()
            };
            let parent_refs = parent_commits.iter().collect::<Vec<_>>();
            let update_ref = (!amend).then_some("HEAD");
            let oid = git
                .commit(
                    update_ref,
                    &author,
                    &committer,
                    &message,
                    &tree,
                    &parent_refs,
                )
                .map_err(LocalGitBackend::map_git2_error)?;
            if amend {
                // libgit2's convenience update rejects an amend because the
                // old HEAD is deliberately not the new commit's first parent.
                // Create the object first, then compare-and-update the resolved
                // branch (or detached HEAD) against the exact commit amended.
                let old_oid = head_commit.as_ref().expect("amend HEAD checked above").id();
                let head_ref = git.head().map_err(LocalGitBackend::map_git2_error)?;
                let refname = head_ref
                    .name()
                    .map_err(LocalGitBackend::map_git2_error)?
                    .to_string();
                drop(head_ref);
                git.reference_matching(&refname, oid, true, old_oid, "commit (amend)")
                    .map_err(LocalGitBackend::map_git2_error)?;
            }
            Ok(oid.to_string())
        })
    })
    .await
    .map_err(|e| GitError::Git2(e.to_string()))?
}

pub(super) async fn integrate_upstream(repo: &RepoPath) -> Result<(), GitError> {
    let repo = repo.clone();
    let _repo_guard = LocalGitBackend::acquire_repo_write_lock(&repo).await;
    tokio::task::spawn_blocking(move || {
        LocalGitBackend::with_runtime_git2(&repo, |git| {
            let head = git.head().map_err(LocalGitBackend::map_git2_error)?;
            let head_refname = LocalGitBackend::current_branch_refname(git)?;
            let upstream_refname = git
                .branch_upstream_name(&head_refname)
                .map_err(|error| match error.code() {
                    ErrorCode::NotFound => GitError::NoUpstream,
                    _ => LocalGitBackend::map_git2_error(error),
                })?
                .as_str()
                .map_err(LocalGitBackend::map_git2_error)?
                .to_string();
            let upstream_ref = git
                .find_reference(&upstream_refname)
                .map_err(LocalGitBackend::map_git2_error)?;
            let remote_commit = git
                .reference_to_annotated_commit(&upstream_ref)
                .map_err(LocalGitBackend::map_git2_error)?;
            let analysis = git
                .merge_analysis(&[&remote_commit])
                .map_err(LocalGitBackend::map_git2_error)?;

            if analysis.0.is_up_to_date() {
                return Ok(());
            }
            if analysis.0.is_fast_forward() {
                return LocalGitBackend::fast_forward(git, &head_refname, &remote_commit);
            }
            if analysis.0.is_normal() {
                let local_commit = git
                    .reference_to_annotated_commit(&head)
                    .map_err(LocalGitBackend::map_git2_error)?;
                return LocalGitBackend::normal_merge(git, &local_commit, &remote_commit);
            }
            Ok(())
        })
    })
    .await
    .map_err(|error| GitError::Git2(error.to_string()))?
}

pub(super) async fn open_merge_tool(
    commands: &GitCommandFactory,
    repo: &RepoPath,
) -> Result<(), GitError> {
    let commands = commands.clone();
    let repo = repo.clone();
    let _repo_guard = LocalGitBackend::acquire_repo_write_lock(&repo).await;
    tokio::task::spawn_blocking(move || {
        if !LocalGitBackend::has_conflicts(&repo)? {
            return Err(GitError::NoConflicts);
        }

        commands
            .command()?
            .args(["mergetool", "--no-prompt"])
            .current_dir(&repo.0)
            .spawn()
            .map(|_| ())
            .map_err(|e| GitError::MergeToolFailed(e.to_string()))
    })
    .await
    .map_err(|e| GitError::Git2(e.to_string()))?
}
