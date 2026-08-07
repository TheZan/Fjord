//! Commit log, search, and the ref decorations attached to each commit.

use super::*;

impl LocalGitBackend {
    pub(super) fn collect_commit_refs(
        git: &git2::Repository,
    ) -> Result<HashMap<Oid, Vec<String>>, GitError> {
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

    pub(super) fn log_offset(from: Option<LogCursor>) -> usize {
        from.and_then(|cursor| cursor.0.strip_prefix("offset:")?.parse().ok())
            .unwrap_or(0)
    }

    pub(super) fn push_log_refs(
        git: &git2::Repository,
        walk: &mut git2::Revwalk<'_>,
    ) -> Result<(), GitError> {
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

    pub(super) fn commit_summary(
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
}

pub(super) async fn log(
    repo: &RepoPath,
    from: Option<LogCursor>,
    limit: u32,
) -> Result<CommitPage, GitError> {
    let repo = repo.clone();
    let _repo_guard = LocalGitBackend::acquire_repo_read_lock(&repo).await;
    tokio::task::spawn_blocking(move || {
        if limit == 0 {
            return Ok(CommitPage {
                commits: vec![],
                next_cursor: None,
            });
        }

        let git = LocalGitBackend::open_git2(&repo)?;
        let mut refs_by_commit = LocalGitBackend::collect_commit_refs(&git)?;
        let offset = LocalGitBackend::log_offset(from);

        let mut walk = git.revwalk().map_err(LocalGitBackend::map_git2_error)?;
        walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME)
            .map_err(LocalGitBackend::map_git2_error)?;
        LocalGitBackend::push_log_refs(&git, &mut walk)?;

        let mut commits = Vec::new();
        let limit = limit as usize;
        let mut next_cursor = None;

        for (index, id) in walk.enumerate().skip(offset) {
            let id = id.map_err(LocalGitBackend::map_git2_error)?;
            if commits.len() >= limit {
                next_cursor = Some(LogCursor(format!("offset:{index}")));
                break;
            }
            commits.push(LocalGitBackend::commit_summary(
                &git,
                id,
                &mut refs_by_commit,
            )?);
        }

        Ok(CommitPage {
            commits,
            next_cursor,
        })
    })
    .await
    .map_err(|e| GitError::Git2(e.to_string()))?
}

pub(super) async fn search_commits(
    repo: &RepoPath,
    query: &str,
    limit: u32,
) -> Result<Vec<CommitSummary>, GitError> {
    let repo = repo.clone();
    let query = query.trim().to_lowercase();
    let _repo_guard = LocalGitBackend::acquire_repo_read_lock(&repo).await;
    tokio::task::spawn_blocking(move || {
        if query.is_empty() || limit == 0 {
            return Ok(vec![]);
        }

        let git = LocalGitBackend::open_git2(&repo)?;
        let mut refs_by_commit = LocalGitBackend::collect_commit_refs(&git)?;
        let mut walk = git.revwalk().map_err(LocalGitBackend::map_git2_error)?;
        walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME)
            .map_err(LocalGitBackend::map_git2_error)?;
        LocalGitBackend::push_log_refs(&git, &mut walk)?;

        let mut commits = Vec::new();
        for id in walk {
            let id = id.map_err(LocalGitBackend::map_git2_error)?;
            let commit = git
                .find_commit(id)
                .map_err(LocalGitBackend::map_git2_error)?;
            let title = commit.summary().ok().flatten().unwrap_or("").to_lowercase();
            if !title.contains(&query) {
                continue;
            }

            commits.push(LocalGitBackend::commit_summary(
                &git,
                id,
                &mut refs_by_commit,
            )?);
            if commits.len() >= limit as usize {
                break;
            }
        }

        Ok(commits)
    })
    .await
    .map_err(|e| GitError::Git2(e.to_string()))?
}
