//! Repository status: dirty count, conflicts, and ahead/behind against the
//! locally known upstream ref.

use super::*;
impl LocalGitBackend {
    pub(super) fn current_ahead_behind(git: &git2::Repository) -> Result<(u32, u32), GitError> {
        let head = match git.head() {
            Ok(head) if head.is_branch() => head,
            Ok(_) => return Ok((0, 0)),
            Err(error) if error.code() == ErrorCode::UnbornBranch => return Ok((0, 0)),
            Err(error) => return Err(Self::map_git2_error(error)),
        };
        let head_name = head.name().map_err(Self::map_git2_error)?;
        let upstream_name = match git.branch_upstream_name(head_name) {
            Ok(name) => name,
            Err(error) if error.code() == ErrorCode::NotFound => return Ok((0, 0)),
            Err(error) => return Err(Self::map_git2_error(error)),
        };
        let upstream_name = upstream_name.as_str().map_err(Self::map_git2_error)?;
        let local_oid = head.peel_to_commit().map_err(Self::map_git2_error)?.id();
        let upstream_oid = git
            .find_reference(upstream_name)
            .map_err(Self::map_git2_error)?
            .peel_to_commit()
            .map_err(Self::map_git2_error)?
            .id();
        let (ahead, behind) = git
            .graph_ahead_behind(local_oid, upstream_oid)
            .map_err(Self::map_git2_error)?;
        Ok((ahead as u32, behind as u32))
    }

    pub(super) fn conflict_paths(index: &git2::Index) -> Vec<String> {
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

    pub(super) fn has_conflicts(repo: &RepoPath) -> Result<bool, GitError> {
        Self::with_runtime_git2(repo, |git| Ok(Self::fresh_index(git)?.has_conflicts()))
    }
}

pub(super) async fn status(repo: &RepoPath) -> Result<RepoStatus, GitError> {
    let repo = repo.clone();
    let _repo_guard = LocalGitBackend::acquire_repo_read_lock(&repo).await;
    tokio::task::spawn_blocking(move || {
        let git = LocalGitBackend::open(&repo)?;

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

        // Compare only local refs. Network freshness is owned explicitly by
        // System Git fetch; status never performs hidden network access.
        let (has_conflict, ahead, behind) = LocalGitBackend::with_runtime_git2(&repo, |git| {
            let has_conflict = LocalGitBackend::fresh_index(git)?.has_conflicts();
            let (ahead, behind) = LocalGitBackend::current_ahead_behind(git)?;
            Ok((has_conflict, ahead, behind))
        })?;
        Ok(RepoStatus {
            branch,
            ahead,
            behind,
            dirty_count,
            has_conflict,
        })
    })
    .await
    .map_err(|e| GitError::Gix(e.to_string()))?
}
