//! Repository-derived stash identity and metadata reads.

use fjord_domain::{CommitId, StashEntry, StashId};
use fjord_ports::{GitError, RepoPath};
use git2::{ErrorCode, ObjectType, Oid, Repository, Tree};
use time::OffsetDateTime;

use super::LocalGitBackend;

const STASH_REF: &str = "refs/stash";

#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(dead_code)] // Introduced for P10-STASH-06 mutations; exercised directly in P10-STASH-01 tests.
pub(super) struct ResolvedStash {
    pub id: StashId,
    pub index: u32,
    pub ref_name: String,
}

pub(super) async fn stashes(repo: &RepoPath) -> Result<Vec<StashEntry>, GitError> {
    let repo = repo.clone();
    let _repo_guard = LocalGitBackend::acquire_repo_read_lock(&repo).await;
    tokio::task::spawn_blocking(move || {
        super::runtime::registry()
            .resolve(&repo)?
            .stashes(read_stashes)
    })
    .await
    .map_err(|error| GitError::Git2(error.to_string()))?
}

fn read_stashes(git: &mut Repository) -> Result<Vec<StashEntry>, GitError> {
    let Some(reflog) = stash_reflog(git)? else {
        return Ok(Vec::new());
    };
    let mut entries = Vec::with_capacity(reflog.len());
    for index in 0..reflog.len() {
        let reflog_entry = reflog
            .get(index)
            .ok_or_else(|| malformed(format!("refs/stash reflog entry {index} is missing")))?;
        let message = reflog_entry
            .message()
            .map_err(LocalGitBackend::map_git2_error)?
            .ok_or_else(|| malformed(format!("refs/stash reflog entry {index} has no message")))?
            .to_string();
        entries.push(build_entry(git, index, reflog_entry.id_new(), message)?);
    }
    Ok(entries)
}

fn build_entry(
    git: &Repository,
    index: usize,
    oid: Oid,
    message: String,
) -> Result<StashEntry, GitError> {
    let commit = git
        .find_commit(oid)
        .map_err(LocalGitBackend::map_git2_error)?;
    if !(2..=3).contains(&commit.parent_count()) {
        return Err(malformed(format!(
            "stash commit {oid} has {} parents; expected two or three",
            commit.parent_count()
        )));
    }

    let base = commit.parent(0).map_err(LocalGitBackend::map_git2_error)?;
    let index_parent = commit.parent(1).map_err(LocalGitBackend::map_git2_error)?;
    let base_tree = base.tree().map_err(LocalGitBackend::map_git2_error)?;
    let stash_tree = commit.tree().map_err(LocalGitBackend::map_git2_error)?;
    let tracked_files = git
        .diff_tree_to_tree(Some(&base_tree), Some(&stash_tree), None)
        .map_err(LocalGitBackend::map_git2_error)?
        .deltas()
        .len();

    let untracked_files = if commit.parent_count() == 3 {
        let untracked_parent = commit.parent(2).map_err(LocalGitBackend::map_git2_error)?;
        let untracked_tree = untracked_parent
            .tree()
            .map_err(LocalGitBackend::map_git2_error)?;
        count_tree_files(git, &untracked_tree)?
    } else {
        0
    };
    let total_files = tracked_files.checked_add(untracked_files).ok_or_else(|| {
        malformed(format!(
            "stash commit {oid} contains too many changed paths"
        ))
    })?;
    let files_changed = u32::try_from(total_files).map_err(|_| {
        malformed(format!(
            "stash commit {oid} contains too many changed paths"
        ))
    })?;
    let index = u32::try_from(index)
        .map_err(|_| malformed("refs/stash contains more entries than supported"))?;
    let created_at = OffsetDateTime::from_unix_timestamp(commit.committer().when().seconds())
        .map_err(|_| malformed(format!("stash commit {oid} has an invalid committer time")))?;
    let (title, branch) = parse_message(&message);

    Ok(StashEntry {
        id: StashId(oid.to_string()),
        index,
        ref_name: stash_ref_name(index),
        message,
        title,
        base: CommitId(base.id().to_string()),
        branch,
        created_at,
        files_changed,
        has_index_state: index_parent.tree_id() != base.tree_id(),
        has_untracked: untracked_files > 0,
    })
}

/// Re-enumerates the current stack. Future mutation code must call this while
/// holding the repository write lock, immediately before invoking Git.
#[allow(dead_code)] // Deliberately has no production mutation caller until P10-STASH-06.
pub(super) fn resolve_stash(git: &Repository, id: &StashId) -> Result<ResolvedStash, GitError> {
    let Some(reflog) = stash_reflog(git)? else {
        return Err(GitError::StashNotFound);
    };
    let requested = Oid::from_str(&id.0).map_err(|_| GitError::StashNotFound)?;
    let mut matched_index = None;
    for index in 0..reflog.len() {
        let entry = reflog
            .get(index)
            .ok_or_else(|| malformed(format!("refs/stash reflog entry {index} is missing")))?;
        if entry.id_new() != requested {
            continue;
        }
        if matched_index.is_some() {
            return Err(GitError::StashAmbiguous);
        }
        matched_index = Some(index);
    }

    let index = u32::try_from(matched_index.ok_or(GitError::StashNotFound)?)
        .map_err(|_| malformed("refs/stash contains more entries than supported"))?;
    Ok(ResolvedStash {
        id: id.clone(),
        index,
        ref_name: stash_ref_name(index),
    })
}

fn stash_reflog(git: &Repository) -> Result<Option<git2::Reflog>, GitError> {
    match git.find_reference(STASH_REF) {
        Ok(_) => {}
        Err(error) if error.code() == ErrorCode::NotFound => return Ok(None),
        Err(error) => return Err(LocalGitBackend::map_git2_error(error)),
    }
    git.reflog(STASH_REF)
        .map(Some)
        .map_err(LocalGitBackend::map_git2_error)
}

fn count_tree_files(git: &Repository, tree: &Tree<'_>) -> Result<usize, GitError> {
    let mut count = 0usize;
    for entry in tree {
        match entry.kind() {
            Some(ObjectType::Tree) => {
                let child = git
                    .find_tree(entry.id())
                    .map_err(LocalGitBackend::map_git2_error)?;
                count = count
                    .checked_add(count_tree_files(git, &child)?)
                    .ok_or_else(|| malformed("stash untracked tree contains too many paths"))?;
            }
            Some(_) => {
                count = count
                    .checked_add(1)
                    .ok_or_else(|| malformed("stash untracked tree contains too many paths"))?;
            }
            None => {
                return Err(malformed(format!(
                    "stash tree entry {} has an unsupported file mode",
                    entry.id()
                )));
            }
        }
    }
    Ok(count)
}

fn stash_ref_name(index: u32) -> String {
    format!("stash@{{{index}}}")
}

fn parse_message(message: &str) -> (String, Option<String>) {
    for prefix in ["On ", "WIP on "] {
        let Some(remainder) = message.strip_prefix(prefix) else {
            continue;
        };
        let Some((branch, title)) = remainder.split_once(": ") else {
            continue;
        };
        if branch.is_empty() {
            continue;
        }
        return (
            title.to_string(),
            (branch != "(no branch)").then(|| branch.to_string()),
        );
    }
    (message.to_string(), None)
}

fn malformed(message: impl Into<String>) -> GitError {
    GitError::Git2(message.into())
}

#[cfg(test)]
mod tests {
    use super::parse_message;

    #[test]
    fn parses_only_gits_known_stash_message_shapes() {
        let cases = [
            (
                "On develop: Payment validation",
                "Payment validation",
                Some("develop"),
            ),
            (
                "WIP on develop: a123456 Add payments",
                "a123456 Add payments",
                Some("develop"),
            ),
            (
                "WIP on (no branch): a123456 Detached work",
                "a123456 Detached work",
                None,
            ),
            (
                "On feature/payments: keep slash",
                "keep slash",
                Some("feature/payments"),
            ),
            ("custom stash text", "custom stash text", None),
            ("On develop: ", "", Some("develop")),
            ("On : odd", "On : odd", None),
            (
                "WIP on develop:missing space",
                "WIP on develop:missing space",
                None,
            ),
        ];

        for (message, expected_title, expected_branch) in cases {
            let (title, branch) = parse_message(message);
            assert_eq!(title, expected_title, "message: {message}");
            assert_eq!(branch.as_deref(), expected_branch, "message: {message}");
        }
    }
}
