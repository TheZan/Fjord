//! Commit log, search, and the ref decorations attached to each commit.

use super::*;
use gix::bstr::ByteSlice;
use gix::revision::walk::Sorting;

type CommitRefs = HashMap<gix::ObjectId, Vec<String>>;
const LOG_CURSOR_WINDOW_PAGES: usize = 10;

enum ParsedLogCursor {
    Offset(usize),
    Window {
        continuation_offset: Option<usize>,
        ids: Vec<gix::ObjectId>,
    },
}

impl LocalGitBackend {
    /// Reads traversal tips and decorations in one pass. `peeled()` is
    /// important for annotated tags: both traversal and the UI decoration must
    /// point at the commit rather than the tag object.
    fn collect_log_refs(
        git: &gix::Repository,
    ) -> Result<(Vec<gix::ObjectId>, CommitRefs), GitError> {
        let mut tips = Vec::new();
        let mut refs_by_commit: CommitRefs = HashMap::new();
        let reference_platform = git.references().map_err(Self::map_gix_error)?;
        let references = reference_platform
            .all()
            .map_err(Self::map_gix_error)?
            .peeled()
            .map_err(Self::map_gix_error)?;

        for reference in references {
            let reference = reference.map_err(Self::map_gix_error)?;
            let name = reference.name().as_bstr().to_str_lossy();
            if name == "refs/remotes/origin/HEAD" || !Self::is_visible_refname(&name) {
                continue;
            }

            let id = reference.id().detach();
            tips.push(id);
            refs_by_commit
                .entry(id)
                .or_default()
                .push(Self::short_refname(&name).to_string());
        }

        if tips.is_empty() {
            tips.push(git.head_id().map_err(Self::map_gix_error)?.detach());
        }
        tips.sort();
        tips.dedup();

        for refs in refs_by_commit.values_mut() {
            refs.sort_by(|a, b| Self::ref_sort_key(a).cmp(&Self::ref_sort_key(b)));
            refs.dedup();
        }

        Ok((tips, refs_by_commit))
    }

    fn parse_log_cursor(from: Option<LogCursor>) -> ParsedLogCursor {
        let Some(cursor) = from else {
            return ParsedLogCursor::Offset(0);
        };
        if let Some(offset) = cursor
            .0
            .strip_prefix("offset:")
            .and_then(|value| value.parse().ok())
        {
            return ParsedLogCursor::Offset(offset);
        }

        let Some(payload) = cursor.0.strip_prefix("window:") else {
            return ParsedLogCursor::Offset(0);
        };
        let Some((continuation, ids)) = payload.split_once(':') else {
            return ParsedLogCursor::Offset(0);
        };
        let continuation_offset = if continuation == "-" {
            None
        } else {
            continuation.parse().ok()
        };
        let ids = ids
            .split(',')
            .filter(|id| !id.is_empty())
            .map(|id| gix::ObjectId::from_hex(id.as_bytes()))
            .collect::<Result<Vec<_>, _>>();
        match ids {
            Ok(ids) if !ids.is_empty() => ParsedLogCursor::Window {
                continuation_offset,
                ids,
            },
            _ => ParsedLogCursor::Offset(0),
        }
    }

    fn window_cursor(
        continuation_offset: Option<usize>,
        ids: &[gix::ObjectId],
    ) -> Option<LogCursor> {
        if ids.is_empty() {
            return continuation_offset.map(|offset| LogCursor(format!("offset:{offset}")));
        }
        let continuation = continuation_offset
            .map(|offset| offset.to_string())
            .unwrap_or_else(|| "-".to_string());
        let ids = ids
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join(",");
        Some(LogCursor(format!("window:{continuation}:{ids}")))
    }

    fn gix_commit_summary(
        git: &gix::Repository,
        id: gix::ObjectId,
        refs_by_commit: &mut CommitRefs,
    ) -> Result<CommitSummary, GitError> {
        let object = git.find_commit(id).map_err(Self::map_gix_error)?;
        let commit = object.decode().map_err(Self::map_gix_error)?;
        let author = commit.author().map_err(Self::map_gix_error)?;
        let authored_at = author.time().map_err(Self::map_gix_error)?.seconds;

        Ok(CommitSummary {
            id: CommitId(id.to_string()),
            parent_ids: commit
                .parents
                .iter()
                .map(|id| CommitId(id.to_str_lossy().into_owned()))
                .collect(),
            message: commit.message.to_str_lossy().into_owned(),
            author_name: author.name.to_str_lossy().into_owned(),
            author_email: author.email.to_str_lossy().into_owned(),
            authored_at: OffsetDateTime::from_unix_timestamp(authored_at)
                .unwrap_or(OffsetDateTime::UNIX_EPOCH),
            refs: refs_by_commit.remove(&id).unwrap_or_default(),
        })
    }

    fn history_walk<'repo>(
        git: &'repo gix::Repository,
        tips: Vec<gix::ObjectId>,
    ) -> Result<gix::revision::Walk<'repo>, GitError> {
        git.rev_walk(tips)
            // The UI draws topology from parent ids inside its bounded page;
            // it does not require git-log's global --topo-order guarantee.
            // ByCommitTime can yield immediately and uses commit-graph data,
            // unlike libgit2's TOPOLOGICAL sort which buffers all ancestors.
            .sorting(Sorting::ByCommitTime(Default::default()))
            .use_commit_graph(true)
            .all()
            .map_err(Self::map_gix_error)
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

        let mut git = LocalGitBackend::open(&repo)?;
        git.object_cache_size_if_unset(4 * 1024 * 1024);
        let limit = limit as usize;
        let cursor = LocalGitBackend::parse_log_cursor(from);
        let (tips, mut refs_by_commit) = LocalGitBackend::collect_log_refs(&git)?;
        let (page_ids, next_cursor) = match cursor {
            ParsedLogCursor::Window {
                continuation_offset,
                mut ids,
            } => {
                let rest = ids.split_off(ids.len().min(limit));
                let next = LocalGitBackend::window_cursor(continuation_offset, &rest);
                (ids, next)
            }
            ParsedLogCursor::Offset(offset) => {
                let walk = LocalGitBackend::history_walk(&git, tips)?;
                let window_size = limit.saturating_mul(LOG_CURSOR_WINDOW_PAGES);
                let mut ids = walk
                    .skip(offset)
                    .take(window_size.saturating_add(1))
                    .map(|info| {
                        info.map(|info| info.id)
                            .map_err(LocalGitBackend::map_gix_error)
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                let has_more = ids.len() > window_size;
                ids.truncate(window_size);
                let rest = ids.split_off(ids.len().min(limit));
                let continuation = has_more.then_some(offset.saturating_add(window_size));
                let next = LocalGitBackend::window_cursor(continuation, &rest);
                (ids, next)
            }
        };

        let commits = page_ids
            .into_iter()
            .map(|id| LocalGitBackend::gix_commit_summary(&git, id, &mut refs_by_commit))
            .collect::<Result<Vec<_>, _>>()?;

        Ok(CommitPage {
            commits,
            next_cursor,
        })
    })
    .await
    .map_err(|e| GitError::Gix(e.to_string()))?
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

        let mut git = LocalGitBackend::open(&repo)?;
        git.object_cache_size_if_unset(4 * 1024 * 1024);
        let (tips, mut refs_by_commit) = LocalGitBackend::collect_log_refs(&git)?;
        let walk = LocalGitBackend::history_walk(&git, tips)?;

        let mut commits = Vec::new();
        for info in walk {
            let info = info.map_err(LocalGitBackend::map_gix_error)?;
            let summary = LocalGitBackend::gix_commit_summary(&git, info.id, &mut refs_by_commit)?;
            let title = summary.message.lines().next().unwrap_or("").to_lowercase();
            if title.contains(&query) {
                commits.push(summary);
                if commits.len() >= limit as usize {
                    break;
                }
            }
        }

        Ok(commits)
    })
    .await
    .map_err(|e| GitError::Gix(e.to_string()))?
}
