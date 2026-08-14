//! Bounded, newest-first reference-log reads for the Recovery Center.

use super::*;
use std::collections::HashMap;

const REFLOG_PAGE_MAX: usize = 200;

pub(super) async fn reflog(
    repo: &RepoPath,
    ref_name: Option<&str>,
    from: Option<LogCursor>,
    limit: u32,
) -> Result<ReflogPage, GitError> {
    let repo = repo.clone();
    let ref_name = ref_name.unwrap_or("HEAD").to_string();
    let _repo_guard = LocalGitBackend::acquire_repo_read_lock(&repo).await;
    tokio::task::spawn_blocking(move || {
        LocalGitBackend::with_runtime_git2(&repo, |git| {
            let reflog = git
                .reflog(&ref_name)
                .map_err(LocalGitBackend::map_git2_error)?;
            let offset = reflog_offset(from);
            let limit = usize::try_from(limit)
                .unwrap_or(usize::MAX)
                .min(REFLOG_PAGE_MAX);
            if limit == 0 || offset >= reflog.len() {
                return Ok(ReflogPage {
                    entries: vec![],
                    next_cursor: None,
                });
            }

            let refs_by_commit = refs_by_commit(git)?;
            let end = offset.saturating_add(limit).min(reflog.len());
            let mut entries = Vec::with_capacity(end - offset);
            for index in offset..end {
                let entry = reflog.get(index).ok_or_else(|| {
                    GitError::Git2(format!("reflog entry {index} disappeared during read"))
                })?;
                let raw_message =
                    String::from_utf8_lossy(entry.message_bytes().unwrap_or_default());
                let (operation, message) = split_message(&raw_message);
                let committer = entry.committer();
                let timestamp = OffsetDateTime::from_unix_timestamp(committer.when().seconds())
                    .unwrap_or(OffsetDateTime::UNIX_EPOCH);
                let new_id = entry.id_new();
                entries.push(ReflogEntry {
                    index: u32::try_from(index).unwrap_or(u32::MAX),
                    old_id: CommitId(entry.id_old().to_string()),
                    new_id: CommitId(new_id.to_string()),
                    committer_name: committer.name().unwrap_or_default().to_string(),
                    timestamp,
                    operation,
                    message,
                    commit: commit_summary(git, new_id, &refs_by_commit).ok(),
                });
            }

            Ok(ReflogPage {
                entries,
                next_cursor: (end < reflog.len()).then(|| LogCursor(format!("offset:{end}"))),
            })
        })
    })
    .await
    .map_err(|error| GitError::Git2(error.to_string()))?
}

pub(super) async fn reflog_refs(repo: &RepoPath) -> Result<Vec<String>, GitError> {
    let repo = repo.clone();
    let _repo_guard = LocalGitBackend::acquire_repo_read_lock(&repo).await;
    tokio::task::spawn_blocking(move || {
        LocalGitBackend::with_runtime_git2(&repo, |git| {
            let references = git
                .references_glob("refs/heads/*")
                .map_err(LocalGitBackend::map_git2_error)?;
            let mut refs = Vec::new();
            for reference in references {
                let reference = reference.map_err(LocalGitBackend::map_git2_error)?;
                let Ok(name) = reference.name() else {
                    continue;
                };
                if git.reflog(name).is_ok() {
                    refs.push(name.to_string());
                }
            }
            refs.sort();
            refs.dedup();
            Ok(refs)
        })
    })
    .await
    .map_err(|error| GitError::Git2(error.to_string()))?
}

fn reflog_offset(cursor: Option<LogCursor>) -> usize {
    cursor
        .and_then(|cursor| {
            cursor
                .0
                .strip_prefix("offset:")
                .and_then(|value| value.parse().ok())
        })
        .unwrap_or(0)
}

fn split_message(raw: &str) -> (String, String) {
    let raw = raw.lines().next().unwrap_or_default().trim();
    raw.split_once(": ")
        .map(|(operation, message)| (operation.to_string(), message.to_string()))
        .unwrap_or_else(|| (raw.to_string(), String::new()))
}

fn refs_by_commit(git: &git2::Repository) -> Result<HashMap<git2::Oid, Vec<String>>, GitError> {
    let references = git.references().map_err(LocalGitBackend::map_git2_error)?;
    let mut refs_by_commit: HashMap<git2::Oid, Vec<String>> = HashMap::new();
    for reference in references {
        let reference = reference.map_err(LocalGitBackend::map_git2_error)?;
        let Ok(name) = reference.name() else {
            continue;
        };
        if name == "refs/remotes/origin/HEAD" || !LocalGitBackend::is_visible_refname(name) {
            continue;
        }
        let Ok(commit) = reference.peel_to_commit() else {
            continue;
        };
        refs_by_commit
            .entry(commit.id())
            .or_default()
            .push(LocalGitBackend::short_refname(name).to_string());
    }
    for refs in refs_by_commit.values_mut() {
        refs.sort_by(|left, right| {
            LocalGitBackend::ref_sort_key(left).cmp(&LocalGitBackend::ref_sort_key(right))
        });
        refs.dedup();
    }
    Ok(refs_by_commit)
}

fn commit_summary(
    git: &git2::Repository,
    id: git2::Oid,
    refs_by_commit: &HashMap<git2::Oid, Vec<String>>,
) -> Result<CommitSummary, GitError> {
    let commit = git
        .find_commit(id)
        .map_err(LocalGitBackend::map_git2_error)?;
    let author = commit.author();
    let authored_at = OffsetDateTime::from_unix_timestamp(author.when().seconds())
        .unwrap_or(OffsetDateTime::UNIX_EPOCH);
    Ok(CommitSummary {
        id: CommitId(id.to_string()),
        parent_ids: commit
            .parent_ids()
            .map(|id| CommitId(id.to_string()))
            .collect(),
        message: String::from_utf8_lossy(commit.message_bytes()).into_owned(),
        author_name: author.name().unwrap_or_default().to_string(),
        author_email: author.email().unwrap_or_default().to_string(),
        authored_at,
        refs: refs_by_commit.get(&id).cloned().unwrap_or_default(),
    })
}
