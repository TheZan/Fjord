//! Branches, tags, and checkout — every operation that reads or moves a reference.

use super::*;

impl LocalGitBackend {
    /// Point the worktree and HEAD at `refname`. Shared by `checkout` and by
    /// `create_branch`'s optional switch-to-the-new-branch step.
    pub(super) fn checkout_refname(git: &git2::Repository, refname: &str) -> Result<(), GitError> {
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

    pub(super) fn checkout_refname_for_branch(
        git: &git2::Repository,
        branch: &str,
    ) -> Result<String, GitError> {
        if let Some(remote_branch) = branch.strip_prefix("refs/remotes/") {
            return Self::checkout_remote_tracking_branch(git, remote_branch);
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
            return Self::checkout_remote_tracking_branch(git, branch);
        }

        git.find_reference(&local_refname)
            .map_err(Self::map_git2_error)?;
        Ok(local_refname)
    }

    pub(super) fn checkout_remote_tracking_branch(
        git: &git2::Repository,
        remote_branch: &str,
    ) -> Result<String, GitError> {
        let (_remote_name, local_name) =
            Self::remote_branch_parts(git, remote_branch).ok_or_else(|| {
                GitError::Git2(format!("remote branch name is invalid: {remote_branch}"))
            })?;

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

    pub(super) fn fast_forward_local_to_remote(
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

    pub(super) fn remote_branch_parts<'a>(
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

    pub(super) fn is_visible_refname(name: &str) -> bool {
        name.starts_with("refs/heads/")
            || name.starts_with("refs/remotes/")
            || name.starts_with("refs/tags/")
    }

    pub(super) fn short_refname(name: &str) -> &str {
        name.strip_prefix("refs/heads/")
            .or_else(|| name.strip_prefix("refs/remotes/"))
            .or_else(|| name.strip_prefix("refs/tags/"))
            .unwrap_or(name)
    }

    pub(super) fn ref_sort_key(name: &str) -> (u8, &str) {
        if name.starts_with("origin/") {
            (1, name)
        } else {
            (0, name)
        }
    }
}

pub(super) async fn branches(repo: &RepoPath) -> Result<Vec<BranchInfo>, GitError> {
    let repo = repo.clone();
    let _repo_guard = LocalGitBackend::acquire_repo_read_lock(&repo).await;
    tokio::task::spawn_blocking(move || {
        let git = LocalGitBackend::open(&repo)?;
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
                ahead: 0,
                behind: 0,
                target_commit_id: CommitId(target.id().to_string()),
            });
        }

        LocalGitBackend::with_runtime_git2(&repo, |git| {
            for branch in &mut out {
                let local_ref = format!("refs/heads/{}", branch.name);
                let upstream_ref = match git.branch_upstream_name(&local_ref) {
                    Ok(name) => name
                        .as_str()
                        .map_err(LocalGitBackend::map_git2_error)?
                        .to_string(),
                    Err(error) if error.code() == ErrorCode::NotFound => continue,
                    Err(error) => return Err(LocalGitBackend::map_git2_error(error)),
                };
                branch.upstream = Some(short_upstream_name(&upstream_ref));
                let Ok(upstream) = git.find_reference(&upstream_ref) else {
                    continue;
                };
                let upstream_oid = upstream
                    .peel_to_commit()
                    .map_err(LocalGitBackend::map_git2_error)?
                    .id();
                let local_oid = git2::Oid::from_str(&branch.target_commit_id.0)
                    .map_err(LocalGitBackend::map_git2_error)?;
                let (ahead, behind) = git
                    .graph_ahead_behind(local_oid, upstream_oid)
                    .map_err(LocalGitBackend::map_git2_error)?;
                branch.ahead = ahead as u32;
                branch.behind = behind as u32;
            }
            Ok(())
        })?;

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
                ahead: 0,
                behind: 0,
                target_commit_id: CommitId(target.id().to_string()),
            });
        }

        Ok(out)
    })
    .await
    .map_err(|e| GitError::Gix(e.to_string()))?
}

fn short_upstream_name(upstream_ref: &str) -> String {
    upstream_ref
        .strip_prefix("refs/remotes/")
        .or_else(|| upstream_ref.strip_prefix("refs/heads/"))
        .unwrap_or(upstream_ref)
        .to_string()
}

pub(super) async fn tags(repo: &RepoPath) -> Result<Vec<TagInfo>, GitError> {
    let repo = repo.clone();
    let _repo_guard = LocalGitBackend::acquire_repo_read_lock(&repo).await;
    tokio::task::spawn_blocking(move || {
        let git = LocalGitBackend::open(&repo)?;
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

pub(super) async fn checkout(repo: &RepoPath, branch: &str) -> Result<(), GitError> {
    let repo = repo.clone();
    let branch = branch.to_string();
    let _repo_guard = LocalGitBackend::acquire_repo_write_lock(&repo).await;
    tokio::task::spawn_blocking(move || {
        LocalGitBackend::with_runtime_git2(&repo, |git| {
            let refname = LocalGitBackend::checkout_refname_for_branch(git, &branch)?;
            LocalGitBackend::checkout_refname(git, &refname)
        })
    })
    .await
    .map_err(|e| GitError::Git2(e.to_string()))?
}

pub(super) async fn remote_checkout_refspec(
    repo: &RepoPath,
    branch: &str,
) -> Result<Option<(String, String)>, GitError> {
    let repo = repo.clone();
    let branch = branch.to_string();
    let _repo_guard = LocalGitBackend::acquire_repo_read_lock(&repo).await;
    tokio::task::spawn_blocking(move || {
        LocalGitBackend::with_runtime_git2(&repo, |git| {
            let remote_branch = branch.strip_prefix("refs/remotes/").unwrap_or(&branch);
            let Some((remote, local_name)) =
                LocalGitBackend::remote_branch_parts(git, remote_branch)
            else {
                return Ok(None);
            };
            Ok(Some((
                remote.to_string(),
                format!("+refs/heads/{local_name}:refs/remotes/{remote_branch}"),
            )))
        })
    })
    .await
    .map_err(|error| GitError::Git2(error.to_string()))?
}

pub(super) async fn checkout_local(repo: &RepoPath, branch: &str) -> Result<(), GitError> {
    let repo = repo.clone();
    let branch = branch.to_string();
    let _repo_guard = LocalGitBackend::acquire_repo_write_lock(&repo).await;
    tokio::task::spawn_blocking(move || {
        LocalGitBackend::with_runtime_git2(&repo, |git| {
            let refname = LocalGitBackend::checkout_refname_for_branch(git, &branch)?;
            LocalGitBackend::checkout_refname(git, &refname)
        })
    })
    .await
    .map_err(|error| GitError::Git2(error.to_string()))?
}

pub(super) async fn create_branch(
    repo: &RepoPath,
    name: &str,
    checkout: bool,
) -> Result<(), GitError> {
    let repo = repo.clone();
    let name = name.to_string();
    let _repo_guard = LocalGitBackend::acquire_repo_write_lock(&repo).await;
    tokio::task::spawn_blocking(move || {
        LocalGitBackend::with_runtime_git2(&repo, |git| {
            let head = LocalGitBackend::current_head_commit(git)?.ok_or_else(|| {
                GitError::Git2("cannot create a branch before the first commit".to_string())
            })?;

            git.branch(&name, &head, false)
                .map_err(|err| match err.code() {
                    ErrorCode::Exists => GitError::BranchExists(name.clone()),
                    _ => LocalGitBackend::map_git2_error(err),
                })?;

            if checkout {
                LocalGitBackend::checkout_refname(git, &format!("refs/heads/{name}"))?;
            }
            Ok(())
        })
    })
    .await
    .map_err(|e| GitError::Git2(e.to_string()))?
}

pub(super) async fn create_branch_at(
    commands: &GitCommandFactory,
    repo: &RepoPath,
    name: &str,
    target: &str,
    checkout: bool,
) -> Result<(), GitError> {
    let commands = commands.clone();
    let repo = repo.clone();
    let name = name.to_string();
    let target = target.to_string();
    let _repo_guard = LocalGitBackend::acquire_repo_write_lock(&repo).await;
    tokio::task::spawn_blocking(move || {
        LocalGitBackend::run_local_git(&commands, &repo, &["branch", &name, &target])?;
        if checkout {
            LocalGitBackend::run_local_git(&commands, &repo, &["checkout", &name])?;
        }
        Ok(())
    })
    .await
    .map_err(|e| GitError::Git2(e.to_string()))?
}

pub(super) async fn rename_branch(
    commands: &GitCommandFactory,
    repo: &RepoPath,
    old_name: &str,
    new_name: &str,
) -> Result<(), GitError> {
    let commands = commands.clone();
    let repo = repo.clone();
    let old_name = old_name.to_string();
    let new_name = new_name.to_string();
    let _repo_guard = LocalGitBackend::acquire_repo_write_lock(&repo).await;
    tokio::task::spawn_blocking(move || {
        LocalGitBackend::run_local_git(&commands, &repo, &["branch", "-m", &old_name, &new_name])
    })
    .await
    .map_err(|e| GitError::Git2(e.to_string()))?
}

pub(super) async fn delete_branch(
    commands: &GitCommandFactory,
    repo: &RepoPath,
    name: &str,
) -> Result<(), GitError> {
    let commands = commands.clone();
    let repo = repo.clone();
    let name = name.to_string();
    let _repo_guard = LocalGitBackend::acquire_repo_write_lock(&repo).await;
    tokio::task::spawn_blocking(move || {
        LocalGitBackend::run_local_git(&commands, &repo, &["branch", "-d", &name])
    })
    .await
    .map_err(|e| GitError::Git2(e.to_string()))?
}

pub(super) async fn set_branch_upstream(
    repo: &RepoPath,
    branch: &str,
    upstream: &str,
) -> Result<(), GitError> {
    let repo = repo.clone();
    let branch = branch.to_string();
    let upstream = upstream.to_string();
    let _repo_guard = LocalGitBackend::acquire_repo_write_lock(&repo).await;
    tokio::task::spawn_blocking(move || {
        LocalGitBackend::with_runtime_git2(&repo, |git| {
            git.find_branch(&upstream, git2::BranchType::Remote)
                .map_err(LocalGitBackend::map_git2_error)?;
            let mut local = git
                .find_branch(&branch, git2::BranchType::Local)
                .map_err(LocalGitBackend::map_git2_error)?;
            local
                .set_upstream(Some(&upstream))
                .map_err(LocalGitBackend::map_git2_error)
        })
    })
    .await
    .map_err(|error| GitError::Git2(error.to_string()))?
}

pub(super) async fn unset_branch_upstream(repo: &RepoPath, branch: &str) -> Result<(), GitError> {
    let repo = repo.clone();
    let branch = branch.to_string();
    let _repo_guard = LocalGitBackend::acquire_repo_write_lock(&repo).await;
    tokio::task::spawn_blocking(move || {
        LocalGitBackend::with_runtime_git2(&repo, |git| {
            let mut local = git
                .find_branch(&branch, git2::BranchType::Local)
                .map_err(LocalGitBackend::map_git2_error)?;
            local
                .set_upstream(None)
                .map_err(LocalGitBackend::map_git2_error)
        })
    })
    .await
    .map_err(|error| GitError::Git2(error.to_string()))?
}

pub(super) async fn create_tag(
    commands: &GitCommandFactory,
    repo: &RepoPath,
    name: &str,
    target: &str,
) -> Result<(), GitError> {
    let commands = commands.clone();
    let repo = repo.clone();
    let name = name.to_string();
    let target = target.to_string();
    let _repo_guard = LocalGitBackend::acquire_repo_write_lock(&repo).await;
    tokio::task::spawn_blocking(move || {
        LocalGitBackend::run_local_git(&commands, &repo, &["tag", &name, &target])
    })
    .await
    .map_err(|e| GitError::Git2(e.to_string()))?
}

pub(super) async fn delete_tag(
    commands: &GitCommandFactory,
    repo: &RepoPath,
    name: &str,
) -> Result<(), GitError> {
    let commands = commands.clone();
    let repo = repo.clone();
    let name = name.to_string();
    let _repo_guard = LocalGitBackend::acquire_repo_write_lock(&repo).await;
    tokio::task::spawn_blocking(move || {
        LocalGitBackend::run_local_git(&commands, &repo, &["tag", "-d", &name])
    })
    .await
    .map_err(|e| GitError::Git2(e.to_string()))?
}

pub(super) async fn upstream_remote(repo: &RepoPath) -> Result<String, GitError> {
    let repo = repo.clone();
    let _repo_guard = LocalGitBackend::acquire_repo_read_lock(&repo).await;
    tokio::task::spawn_blocking(move || {
        LocalGitBackend::with_runtime_git2(&repo, |git| {
            let head_refname = LocalGitBackend::current_branch_refname(git)?;
            git.branch_upstream_remote(&head_refname)
                .map_err(|error| match error.code() {
                    ErrorCode::NotFound => GitError::NoUpstream,
                    _ => LocalGitBackend::map_git2_error(error),
                })?
                .as_str()
                .map_err(LocalGitBackend::map_git2_error)
                .map(ToString::to_string)
        })
    })
    .await
    .map_err(|error| GitError::Git2(error.to_string()))?
}

pub(super) async fn amend_info(repo: &RepoPath) -> Result<fjord_domain::AmendInfo, GitError> {
    let repo = repo.clone();
    let _repo_guard = LocalGitBackend::acquire_repo_read_lock(&repo).await;
    tokio::task::spawn_blocking(move || {
        LocalGitBackend::with_runtime_git2(&repo, |git| {
            let head =
                LocalGitBackend::current_head_commit(git)?.ok_or(GitError::NothingToCommit)?;
            let message = head.message().unwrap_or_default().to_string();
            let published_upstream = published_upstream_containing_head(git, head.id())?;
            Ok(fjord_domain::AmendInfo {
                message,
                published_upstream,
            })
        })
    })
    .await
    .map_err(|error| GitError::Git2(error.to_string()))?
}

fn published_upstream_containing_head(
    git: &git2::Repository,
    head_oid: git2::Oid,
) -> Result<Option<String>, GitError> {
    let head_refname = LocalGitBackend::current_branch_refname(git)?;
    let upstream_name = match git.branch_upstream_name(&head_refname) {
        Ok(name) => name,
        Err(error) if error.code() == ErrorCode::NotFound => return Ok(None),
        Err(error) => return Err(LocalGitBackend::map_git2_error(error)),
    };
    let upstream = upstream_name
        .as_str()
        .map_err(LocalGitBackend::map_git2_error)?
        .to_string();
    let upstream_oid = git
        .find_reference(&upstream)
        .and_then(|reference| reference.peel_to_commit())
        .map_err(LocalGitBackend::map_git2_error)?
        .id();
    let contains_head = upstream_oid == head_oid
        || git
            .graph_descendant_of(upstream_oid, head_oid)
            .map_err(LocalGitBackend::map_git2_error)?;

    Ok(contains_head.then_some(
        upstream
            .strip_prefix("refs/remotes/")
            .unwrap_or(&upstream)
            .to_string(),
    ))
}

pub(super) async fn current_branch_ref(repo: &RepoPath) -> Result<String, GitError> {
    let repo = repo.clone();
    let _repo_guard = LocalGitBackend::acquire_repo_read_lock(&repo).await;
    tokio::task::spawn_blocking(move || {
        LocalGitBackend::with_runtime_git2(&repo, |git| {
            LocalGitBackend::current_branch_refname(git)
        })
    })
    .await
    .map_err(|error| GitError::Git2(error.to_string()))?
}

pub(super) async fn current_push_target(repo: &RepoPath) -> Result<PushTarget, GitError> {
    let repo = repo.clone();
    let _repo_guard = LocalGitBackend::acquire_repo_read_lock(&repo).await;
    tokio::task::spawn_blocking(move || {
        LocalGitBackend::with_runtime_git2(&repo, |git| {
            let local_ref = LocalGitBackend::current_branch_refname(git)?;
            let remote = git
                .branch_upstream_remote(&local_ref)
                .map_err(upstream_error)?
                .as_str()
                .map_err(LocalGitBackend::map_git2_error)?
                .to_string();
            let upstream = git
                .branch_upstream_name(&local_ref)
                .map_err(upstream_error)?
                .as_str()
                .map_err(LocalGitBackend::map_git2_error)?
                .to_string();

            Ok(PushTarget {
                remote_ref: remote_ref_for_upstream(git, &remote, &upstream),
                remote,
                local_ref,
            })
        })
    })
    .await
    .map_err(|error| GitError::Git2(error.to_string()))?
}

pub(super) async fn force_push_plan(
    repo: &RepoPath,
) -> Result<fjord_ports::ForcePushPlan, GitError> {
    let repo = repo.clone();
    let _repo_guard = LocalGitBackend::acquire_repo_read_lock(&repo).await;
    tokio::task::spawn_blocking(move || {
        LocalGitBackend::with_runtime_git2(&repo, |git| {
            let local_ref = LocalGitBackend::current_branch_refname(git)?;
            let remote = git
                .branch_upstream_remote(&local_ref)
                .map_err(upstream_error)?
                .as_str()
                .map_err(LocalGitBackend::map_git2_error)?
                .to_string();
            let upstream = git
                .branch_upstream_name(&local_ref)
                .map_err(upstream_error)?
                .as_str()
                .map_err(LocalGitBackend::map_git2_error)?
                .to_string();
            let expected_oid = git
                .find_reference(&upstream)
                .map_err(LocalGitBackend::map_git2_error)?
                .peel_to_commit()
                .map_err(LocalGitBackend::map_git2_error)?
                .id()
                .to_string();
            let source_oid = git
                .find_reference(&local_ref)
                .map_err(LocalGitBackend::map_git2_error)?
                .peel_to_commit()
                .map_err(LocalGitBackend::map_git2_error)?
                .id()
                .to_string();

            Ok(fjord_ports::ForcePushPlan {
                remote_ref: remote_ref_for_upstream(git, &remote, &upstream),
                remote,
                expected_oid,
                source_oid,
            })
        })
    })
    .await
    .map_err(|error| GitError::Git2(error.to_string()))?
}

fn upstream_error(error: git2::Error) -> GitError {
    match error.code() {
        ErrorCode::NotFound => GitError::NoUpstream,
        _ => LocalGitBackend::map_git2_error(error),
    }
}

/// Maps a remote-tracking ref back to the ref it mirrors on the remote. The
/// remote's own fetch refspecs answer this exactly, including non-default
/// layouts; the prefix strip is only a fallback for unusual configurations.
fn remote_ref_for_upstream(git: &git2::Repository, remote: &str, upstream: &str) -> String {
    if let Ok(configured) = git.find_remote(remote) {
        let reversed = configured
            .refspecs()
            .filter(|refspec| refspec.direction() == git2::Direction::Fetch)
            .find_map(|refspec| refspec.rtransform(upstream).ok());
        if let Some(reversed) = reversed {
            if let Ok(value) = std::str::from_utf8(&reversed) {
                return value.to_string();
            }
        }
    }

    match upstream.strip_prefix(&format!("refs/remotes/{remote}/")) {
        Some(branch) => format!("refs/heads/{branch}"),
        None => upstream.to_string(),
    }
}
