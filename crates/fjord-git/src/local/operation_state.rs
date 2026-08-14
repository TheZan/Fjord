//! Detection of Git operations recorded in the resolved per-worktree git-dir.
//!
//! The marker files are Git's ground truth. Reading them directly preserves
//! progress and operation-kind details that `git2::Repository::state()` does
//! not expose, and also detects work started by another client.

use super::*;
use fjord_domain::{OperationControl, RebaseKind, RepoOperation, RepoOperationState};
use std::path::Path;
use std::sync::Mutex;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum OperationFamily {
    Merge,
    Rebase,
    CherryPick,
    Revert,
    Bisect,
}

#[derive(Default)]
pub(super) struct OperationOriginTracker {
    started_here: Mutex<HashMap<PathBuf, OperationFamily>>,
}

impl OperationOriginTracker {
    /// Remember a failed Fjord mutation only when it actually left the matching
    /// Git marker behind. A validation or executable error must not make a
    /// later external operation look like Fjord created it.
    pub(super) fn record_if_in_progress(&self, repo: &RepoPath, expected: OperationFamily) {
        let Ok(git) = git2::Repository::open(&repo.0) else {
            return;
        };
        if operation_family(git.path()) == Some(expected) {
            self.started_here
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .insert(repository_key(repo), expected);
        }
    }

    pub(super) fn clear(&self, repo: &RepoPath) {
        self.started_here
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&repository_key(repo));
    }

    fn detected_externally(&self, repo: &RepoPath, operation: &RepoOperation) -> bool {
        let Some(family) = family_of(operation) else {
            self.clear(repo);
            return !matches!(operation, RepoOperation::Normal);
        };

        let mut origins = self
            .started_here
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let key = repository_key(repo);
        let detected_externally = origins.get(&key) != Some(&family);
        if detected_externally {
            // A stale marker for a different operation must not affect a later
            // state transition in this repository.
            origins.remove(&key);
        }
        detected_externally
    }
}

pub(super) async fn state(
    origins: Arc<OperationOriginTracker>,
    repo: &RepoPath,
) -> Result<RepoOperationState, GitError> {
    let repo = repo.clone();
    let _repo_guard = LocalGitBackend::acquire_repo_read_lock(&repo).await;
    tokio::task::spawn_blocking(move || {
        LocalGitBackend::with_runtime_git2(&repo, |git| detect(git, &repo, &origins))
    })
    .await
    .map_err(|error| GitError::Git2(error.to_string()))?
}

pub(super) fn detect(
    git: &mut git2::Repository,
    repo: &RepoPath,
    origins: &OperationOriginTracker,
) -> Result<RepoOperationState, GitError> {
    let git_dir = git.path();
    let conflicted_paths = LocalGitBackend::conflict_paths(&LocalGitBackend::fresh_index(git)?);
    let operation = detect_operation(git, git_dir)?;
    let available = available_controls(&operation, conflicted_paths.is_empty());
    let detected_externally = origins.detected_externally(repo, &operation);

    Ok(RepoOperationState {
        operation,
        conflicted_paths,
        available,
        detected_externally,
    })
}

fn detect_operation(git: &git2::Repository, git_dir: &Path) -> Result<RepoOperation, GitError> {
    if git_dir.join("rebase-merge").is_dir() {
        return detect_rebase(git_dir, "rebase-merge", true);
    }
    if git_dir.join("rebase-apply").is_dir() {
        return detect_rebase(git_dir, "rebase-apply", false);
    }
    if let Some(incoming) = read_marker_lines(git_dir, "MERGE_HEAD")? {
        return Ok(RepoOperation::Merge {
            head: current_head_id(git).unwrap_or_default(),
            incoming,
        });
    }
    if let Some(commit) = read_marker(git_dir, "CHERRY_PICK_HEAD")? {
        return Ok(RepoOperation::CherryPick { commit });
    }
    if let Some(commit) = read_marker(git_dir, "REVERT_HEAD")? {
        return Ok(RepoOperation::Revert { commit });
    }
    if let Some(log) = read_marker(git_dir, "BISECT_LOG")? {
        let (good, bad) = bisect_counts(&log);
        return Ok(RepoOperation::Bisect { good, bad });
    }

    match git.head() {
        Ok(head) if !head.is_branch() => Ok(RepoOperation::Detached {
            head: head
                .target()
                .map(|oid| oid.to_string())
                .or_else(|| {
                    head.peel_to_commit()
                        .ok()
                        .map(|commit| commit.id().to_string())
                })
                .unwrap_or_default(),
        }),
        Ok(_) => Ok(RepoOperation::Normal),
        Err(error) if matches!(error.code(), ErrorCode::UnbornBranch | ErrorCode::NotFound) => {
            Ok(RepoOperation::UnbornBranch)
        }
        Err(error) => Err(LocalGitBackend::map_git2_error(error)),
    }
}

fn detect_rebase(
    git_dir: &Path,
    directory: &str,
    merge_backend: bool,
) -> Result<RepoOperation, GitError> {
    let base = git_dir.join(directory);
    // Modern Git creates `rebase-merge/interactive` for the entire merge
    // backend, even when `--interactive` was not requested. Treat the state as
    // interactive only when its persisted sequence actually contains an
    // interactive instruction; an all-pick sequence has ordinary merge-backend
    // semantics and is otherwise indistinguishable after Git exits.
    let kind = if merge_backend && has_interactive_steps(&base)? {
        RebaseKind::Interactive
    } else if merge_backend {
        RebaseKind::Merge
    } else {
        RebaseKind::Apply
    };
    let (current_names, total_names): (&[&str], &[&str]) = if merge_backend {
        (&["msgnum"], &["end"])
    } else {
        (&["next", "msgnum"], &["last", "end"])
    };

    Ok(RepoOperation::Rebase {
        rebase_kind: kind,
        onto: read_first(&base, &["onto"])?.unwrap_or_default(),
        current: read_number(&base, current_names)?.unwrap_or_default(),
        total: read_number(&base, total_names)?.unwrap_or_default(),
        head_name: read_first(&base, &["head-name", "head_name"])?
            .filter(|value| !value.is_empty()),
    })
}

fn has_interactive_steps(rebase_dir: &Path) -> Result<bool, GitError> {
    for name in ["git-rebase-todo", "done"] {
        let Some(contents) = read_optional(&rebase_dir.join(name), name)? else {
            continue;
        };
        if contents.lines().any(|line| {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                return false;
            }
            !matches!(line.split_whitespace().next(), Some("pick" | "p"))
        }) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn available_controls(operation: &RepoOperation, conflict_free: bool) -> Vec<OperationControl> {
    use OperationControl::{Abort, Continue, Skip};

    match operation {
        RepoOperation::Merge { .. } | RepoOperation::Revert { .. } => {
            let mut controls = Vec::with_capacity(2);
            if conflict_free {
                controls.push(Continue);
            }
            controls.push(Abort);
            controls
        }
        RepoOperation::Rebase { .. } | RepoOperation::CherryPick { .. } => {
            let mut controls = Vec::with_capacity(3);
            if conflict_free {
                controls.push(Continue);
            }
            controls.push(Skip);
            controls.push(Abort);
            controls
        }
        RepoOperation::Bisect { .. } => vec![Abort],
        RepoOperation::Normal | RepoOperation::Detached { .. } | RepoOperation::UnbornBranch => {
            Vec::new()
        }
    }
}

fn operation_family(git_dir: &Path) -> Option<OperationFamily> {
    if git_dir.join("rebase-merge").is_dir() || git_dir.join("rebase-apply").is_dir() {
        Some(OperationFamily::Rebase)
    } else if git_dir.join("MERGE_HEAD").is_file() {
        Some(OperationFamily::Merge)
    } else if git_dir.join("CHERRY_PICK_HEAD").is_file() {
        Some(OperationFamily::CherryPick)
    } else if git_dir.join("REVERT_HEAD").is_file() {
        Some(OperationFamily::Revert)
    } else if git_dir.join("BISECT_LOG").is_file() {
        Some(OperationFamily::Bisect)
    } else {
        None
    }
}

fn family_of(operation: &RepoOperation) -> Option<OperationFamily> {
    match operation {
        RepoOperation::Merge { .. } => Some(OperationFamily::Merge),
        RepoOperation::Rebase { .. } => Some(OperationFamily::Rebase),
        RepoOperation::CherryPick { .. } => Some(OperationFamily::CherryPick),
        RepoOperation::Revert { .. } => Some(OperationFamily::Revert),
        RepoOperation::Bisect { .. } => Some(OperationFamily::Bisect),
        RepoOperation::Normal | RepoOperation::Detached { .. } | RepoOperation::UnbornBranch => {
            None
        }
    }
}

fn current_head_id(git: &git2::Repository) -> Option<String> {
    git.head()
        .ok()
        .and_then(|head| head.peel_to_commit().ok())
        .map(|commit| commit.id().to_string())
}

fn bisect_counts(log: &str) -> (u32, u32) {
    log.lines().fold((0, 0), |(good, bad), line| {
        let line = line.trim_start();
        if line.starts_with("# good:") {
            (good + 1, bad)
        } else if line.starts_with("# bad:") {
            (good, bad + 1)
        } else {
            (good, bad)
        }
    })
}

fn read_marker(git_dir: &Path, name: &str) -> Result<Option<String>, GitError> {
    read_optional(&git_dir.join(name), name).map(|value| value.map(|text| text.trim().to_string()))
}

fn read_marker_lines(git_dir: &Path, name: &str) -> Result<Option<Vec<String>>, GitError> {
    Ok(read_marker(git_dir, name)?.map(|value| {
        value
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(str::to_string)
            .collect()
    }))
}

fn read_first(directory: &Path, names: &[&str]) -> Result<Option<String>, GitError> {
    for name in names {
        if let Some(value) = read_optional(&directory.join(name), name)? {
            return Ok(Some(value.trim().to_string()));
        }
    }
    Ok(None)
}

fn read_number(directory: &Path, names: &[&str]) -> Result<Option<u32>, GitError> {
    Ok(read_first(directory, names)?.and_then(|value| value.parse().ok()))
}

fn read_optional(path: &Path, marker_name: &str) -> Result<Option<String>, GitError> {
    match std::fs::read_to_string(path) {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(GitError::Git2(format!(
            "failed to read Git operation marker {marker_name}: {error}"
        ))),
    }
}

fn repository_key(repo: &RepoPath) -> PathBuf {
    fjord_fs::canonicalize_path(&repo.0).unwrap_or_else(|_| repo.0.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::{IndexAddOption, RepositoryInitOptions, Signature};
    use tempfile::TempDir;

    struct Fixture {
        _directory: TempDir,
        repo: RepoPath,
        head: String,
    }

    fn committed_fixture() -> Fixture {
        let directory = TempDir::new().unwrap();
        let mut options = RepositoryInitOptions::new();
        options.initial_head("main");
        let git = git2::Repository::init_opts(directory.path(), &options).unwrap();
        std::fs::write(directory.path().join("tracked.txt"), "base\n").unwrap();
        let mut index = git.index().unwrap();
        index
            .add_all(["tracked.txt"], IndexAddOption::DEFAULT, None)
            .unwrap();
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = git.find_tree(tree_id).unwrap();
        let signature = Signature::now("Fjord Test", "fjord@example.com").unwrap();
        let head = git
            .commit(Some("HEAD"), &signature, &signature, "base", &tree, &[])
            .unwrap()
            .to_string();
        drop(tree);
        drop(git);
        Fixture {
            repo: RepoPath(directory.path().to_path_buf()),
            _directory: directory,
            head,
        }
    }

    fn git_dir(fixture: &Fixture) -> PathBuf {
        git2::Repository::open(&fixture.repo.0)
            .unwrap()
            .path()
            .to_path_buf()
    }

    fn detected(fixture: &Fixture) -> RepoOperationState {
        let mut git = git2::Repository::open(&fixture.repo.0).unwrap();
        detect(&mut git, &fixture.repo, &OperationOriginTracker::default()).unwrap()
    }

    #[test]
    fn bisect_log_counts_classified_commits() {
        assert_eq!(
            bisect_counts("# bad: [aaa] broken\n# good: [bbb] works\n# good: [ccc] works\n"),
            (2, 1)
        );
    }

    #[test]
    fn controls_are_derived_from_operation_and_conflicts() {
        let rebase = RepoOperation::Rebase {
            rebase_kind: RebaseKind::Merge,
            onto: "onto".into(),
            current: 2,
            total: 3,
            head_name: Some("refs/heads/main".into()),
        };
        assert_eq!(
            available_controls(&rebase, true),
            vec![
                OperationControl::Continue,
                OperationControl::Skip,
                OperationControl::Abort
            ]
        );
        assert_eq!(
            available_controls(&rebase, false),
            vec![OperationControl::Skip, OperationControl::Abort]
        );
    }

    #[test]
    fn detects_synthesized_merge_layout() {
        let fixture = committed_fixture();
        std::fs::write(
            git_dir(&fixture).join("MERGE_HEAD"),
            "incoming-a\nincoming-b\n",
        )
        .unwrap();

        let state = detected(&fixture);

        assert_eq!(
            state.operation,
            RepoOperation::Merge {
                head: fixture.head,
                incoming: vec!["incoming-a".into(), "incoming-b".into()],
            }
        );
        assert_eq!(
            state.available,
            vec![OperationControl::Continue, OperationControl::Abort]
        );
        assert!(state.detected_externally);
    }

    #[test]
    fn detects_synthesized_rebase_layouts_and_progress() {
        for (directory, interactive, expected_kind, current_name, total_name) in [
            ("rebase-apply", false, RebaseKind::Apply, "next", "last"),
            ("rebase-merge", false, RebaseKind::Merge, "msgnum", "end"),
            (
                "rebase-merge",
                true,
                RebaseKind::Interactive,
                "msgnum",
                "end",
            ),
        ] {
            let fixture = committed_fixture();
            let rebase = git_dir(&fixture).join(directory);
            std::fs::create_dir(&rebase).unwrap();
            std::fs::write(rebase.join("onto"), "onto-id\n").unwrap();
            std::fs::write(rebase.join(current_name), "3\n").unwrap();
            std::fs::write(rebase.join(total_name), "7\n").unwrap();
            std::fs::write(rebase.join("head-name"), "refs/heads/topic\n").unwrap();
            if interactive {
                std::fs::write(rebase.join("interactive"), "").unwrap();
                std::fs::write(rebase.join("git-rebase-todo"), "edit abc subject\n").unwrap();
            }

            let state = detected(&fixture);
            assert_eq!(
                state.operation,
                RepoOperation::Rebase {
                    rebase_kind: expected_kind,
                    onto: "onto-id".into(),
                    current: 3,
                    total: 7,
                    head_name: Some("refs/heads/topic".into()),
                }
            );
            assert_eq!(
                state.available,
                vec![
                    OperationControl::Continue,
                    OperationControl::Skip,
                    OperationControl::Abort
                ]
            );
        }
    }

    #[test]
    fn partially_written_rebase_layout_is_still_described() {
        let fixture = committed_fixture();
        std::fs::create_dir(git_dir(&fixture).join("rebase-apply")).unwrap();

        assert_eq!(
            detected(&fixture).operation,
            RepoOperation::Rebase {
                rebase_kind: RebaseKind::Apply,
                onto: String::new(),
                current: 0,
                total: 0,
                head_name: None,
            }
        );
    }

    #[test]
    fn detects_synthesized_cherry_pick_revert_and_bisect_layouts() {
        let cherry_pick = committed_fixture();
        std::fs::write(
            git_dir(&cherry_pick).join("CHERRY_PICK_HEAD"),
            "cherry-id\n",
        )
        .unwrap();
        assert_eq!(
            detected(&cherry_pick).operation,
            RepoOperation::CherryPick {
                commit: "cherry-id".into()
            }
        );

        let revert = committed_fixture();
        std::fs::write(git_dir(&revert).join("REVERT_HEAD"), "revert-id\n").unwrap();
        assert_eq!(
            detected(&revert).operation,
            RepoOperation::Revert {
                commit: "revert-id".into()
            }
        );

        let bisect = committed_fixture();
        std::fs::write(
            git_dir(&bisect).join("BISECT_LOG"),
            "# bad: [aaa] broken\n# good: [bbb] works\n# good: [ccc] works\n",
        )
        .unwrap();
        assert_eq!(
            detected(&bisect).operation,
            RepoOperation::Bisect { good: 2, bad: 1 }
        );
        assert_eq!(detected(&bisect).available, vec![OperationControl::Abort]);
    }

    #[test]
    fn detects_detached_normal_and_unborn_head_layouts() {
        let fixture = committed_fixture();
        assert_eq!(detected(&fixture).operation, RepoOperation::Normal);
        assert!(!detected(&fixture).detected_externally);

        let git = git2::Repository::open(&fixture.repo.0).unwrap();
        git.set_head_detached(git2::Oid::from_str(&fixture.head).unwrap())
            .unwrap();
        assert_eq!(
            detected(&fixture).operation,
            RepoOperation::Detached {
                head: fixture.head.clone()
            }
        );
        assert!(detected(&fixture).detected_externally);

        let directory = TempDir::new().unwrap();
        let mut options = RepositoryInitOptions::new();
        options.initial_head("main");
        git2::Repository::init_opts(directory.path(), &options).unwrap();
        let unborn = Fixture {
            repo: RepoPath(directory.path().to_path_buf()),
            _directory: directory,
            head: String::new(),
        };
        assert_eq!(detected(&unborn).operation, RepoOperation::UnbornBranch);
    }
}
