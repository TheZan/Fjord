//! First-class Git worktree reads and mutations.

use super::*;
use fjord_domain::{CommitId, Consequence, Recoverability, Worktree, WorktreeBranch};
use fjord_ports::DestructiveActionFacts;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

const BLOCKER_MAIN: &str = "main_worktree_cannot_be_removed";
const BLOCKER_LOCKED: &str = "worktree_locked";
const BLOCKER_DIRTY: &str = "worktree_has_uncommitted_changes";

pub(super) async fn list(
    commands: &GitCommandFactory,
    repo: &RepoPath,
) -> Result<Vec<Worktree>, GitError> {
    let commands = commands.clone();
    let repo = repo.clone();
    let _guard = LocalGitBackend::acquire_repo_read_lock(&repo).await;
    tokio::task::spawn_blocking(move || {
        runtime::worktrees(&repo, || list_uncached(&commands, &repo))
    })
    .await
    .map_err(|error| GitError::Git2(error.to_string()))?
}

pub(super) async fn create(
    commands: &GitCommandFactory,
    repo: &RepoPath,
    name: &str,
    path: &Path,
    branch: WorktreeBranch,
) -> Result<Worktree, GitError> {
    validate_name(name)?;
    validate_branch(&branch)?;
    let commands = commands.clone();
    let repo = repo.clone();
    let name = name.to_string();
    let requested_path = path.to_path_buf();
    let _guard = LocalGitBackend::acquire_repo_write_lock(&repo).await;

    let result = tokio::task::spawn_blocking({
        let repo = repo.clone();
        move || {
            let current = list_uncached(&commands, &repo)?;
            if current.iter().any(|entry| entry.name == name) {
                return Err(GitError::InvalidWorktree(format!(
                    "worktree name already exists: {name}"
                )));
            }
            let destination = validate_destination(&requested_path, &current)?;
            let mut args = vec![OsString::from("worktree"), OsString::from("add")];
            match branch {
                WorktreeBranch::Existing { name } => {
                    args.push(OsString::from("--"));
                    args.push(destination.as_os_str().to_owned());
                    args.push(OsString::from(name));
                }
                WorktreeBranch::New { name, start_point } => {
                    args.push(OsString::from("-b"));
                    args.push(OsString::from(name));
                    args.push(OsString::from("--"));
                    args.push(destination.as_os_str().to_owned());
                    args.push(OsString::from(start_point));
                }
            }
            run_git(&commands, &repo, &args)?;
            runtime::bump_mutation(&repo, MutationKind::CreateWorktree);
            list_uncached(&commands, &repo)?
                .into_iter()
                .find(|entry| same_path(&entry.path, &destination))
                .ok_or_else(|| {
                    GitError::WorktreeFailed(
                        "Git created the worktree but did not list it afterwards".into(),
                    )
                })
        }
    })
    .await
    .map_err(|error| GitError::Git2(error.to_string()))?;

    // The mutation bump happens immediately after Git succeeds, even if the
    // postcondition read reports an error.
    result
}

pub(super) async fn remove(
    commands: &GitCommandFactory,
    repo: &RepoPath,
    name: &str,
    force: bool,
) -> Result<(), GitError> {
    let commands = commands.clone();
    let repo = repo.clone();
    let name = name.to_string();
    let _guard = LocalGitBackend::acquire_repo_write_lock(&repo).await;
    tokio::task::spawn_blocking(move || remove_locked(&commands, &repo, &name, force))
        .await
        .map_err(|error| GitError::Git2(error.to_string()))?
}

pub(super) fn remove_locked(
    commands: &GitCommandFactory,
    repo: &RepoPath,
    name: &str,
    force: bool,
) -> Result<(), GitError> {
    let entry = find_uncached(commands, repo, name)?;
    if entry.is_main {
        return Err(GitError::MainWorktreeCannotBeRemoved);
    }
    if entry.is_locked {
        return Err(GitError::WorktreeLocked(
            entry
                .lock_reason
                .unwrap_or_else(|| "Git did not provide a lock reason".into()),
        ));
    }
    if entry.is_prunable {
        run_git(
            commands,
            repo,
            &[
                OsString::from("worktree"),
                OsString::from("prune"),
                OsString::from("--expire"),
                OsString::from("now"),
            ],
        )?;
        runtime::bump_mutation(repo, MutationKind::RemoveWorktree);
        return Ok(());
    }
    if !force && dirty_count(&entry.path)? > 0 {
        return Err(GitError::WorktreeDirty);
    }

    let mut args = vec![OsString::from("worktree"), OsString::from("remove")];
    if force {
        args.push(OsString::from("--force"));
    }
    args.push(OsString::from("--"));
    args.push(entry.path.as_os_str().to_owned());
    run_git(commands, repo, &args)?;
    runtime::bump_mutation(repo, MutationKind::RemoveWorktree);
    Ok(())
}

pub(super) fn removal_facts_locked(
    commands: &GitCommandFactory,
    repo: &RepoPath,
    name: &str,
    force: bool,
) -> Result<DestructiveActionFacts, GitError> {
    let entry = find_uncached(commands, repo, name)?;
    let dirty_count = if entry.is_prunable {
        0
    } else {
        dirty_count(&entry.path)?
    };
    let mut blockers = Vec::new();
    if entry.is_main {
        blockers.push(BLOCKER_MAIN.to_string());
    }
    if entry.is_locked {
        blockers.push(BLOCKER_LOCKED.to_string());
    }
    if dirty_count > 0 && !force {
        blockers.push(BLOCKER_DIRTY.to_string());
    }
    Ok(DestructiveActionFacts {
        consequences: vec![Consequence::WorktreeRemoved {
            name: entry.name,
            path: entry.path,
            dirty_count,
        }],
        recoverable: Recoverability::NotRecoverable,
        blockers,
    })
}

fn validate_name(name: &str) -> Result<(), GitError> {
    let trimmed = name.trim();
    if trimmed.is_empty()
        || trimmed != name
        || trimmed.contains('\0')
        || trimmed.contains(['/', '\\'])
        || matches!(trimmed, "." | "..")
    {
        return Err(GitError::InvalidWorktree("invalid worktree name".into()));
    }
    Ok(())
}

fn validate_branch(branch: &WorktreeBranch) -> Result<(), GitError> {
    let values: &[&str] = match branch {
        WorktreeBranch::Existing { name } => &[name],
        WorktreeBranch::New { name, start_point } => &[name, start_point],
    };
    if values
        .iter()
        .any(|value| value.trim().is_empty() || value.contains('\0'))
    {
        return Err(GitError::InvalidWorktree(
            "branch and start point must be non-empty".into(),
        ));
    }
    Ok(())
}

fn validate_destination(path: &Path, current: &[Worktree]) -> Result<PathBuf, GitError> {
    let destination = if path.exists() {
        if !path.is_dir() {
            return Err(GitError::InvalidWorktree(
                "destination must be a directory".into(),
            ));
        }
        if std::fs::read_dir(path)
            .map_err(|error| GitError::InvalidWorktree(error.to_string()))?
            .next()
            .is_some()
        {
            return Err(GitError::InvalidWorktree(
                "destination directory must be empty".into(),
            ));
        }
        fjord_fs::canonicalize_path(path)
            .map_err(|error| GitError::InvalidWorktree(error.to_string()))?
    } else {
        let parent = path.parent().ok_or_else(|| {
            GitError::InvalidWorktree("destination must have an existing parent".into())
        })?;
        let name = path.file_name().ok_or_else(|| {
            GitError::InvalidWorktree("destination must have a directory name".into())
        })?;
        fjord_fs::canonicalize_path(parent)
            .map_err(|_| GitError::InvalidWorktree("destination parent does not exist".into()))?
            .join(name)
    };

    if current.iter().any(|entry| {
        let root = fjord_fs::canonicalize_path(&entry.path).unwrap_or_else(|_| entry.path.clone());
        destination == root || destination.starts_with(&root)
    }) {
        return Err(GitError::InvalidWorktree(
            "destination is inside another working tree".into(),
        ));
    }
    Ok(destination)
}

fn find_uncached(
    commands: &GitCommandFactory,
    repo: &RepoPath,
    name: &str,
) -> Result<Worktree, GitError> {
    list_uncached(commands, repo)?
        .into_iter()
        .find(|entry| entry.name == name)
        .ok_or_else(|| GitError::WorktreeNotFound(name.to_string()))
}

pub(super) fn list_uncached(
    commands: &GitCommandFactory,
    repo: &RepoPath,
) -> Result<Vec<Worktree>, GitError> {
    let output = git_output(
        commands,
        repo,
        &[
            OsString::from("worktree"),
            OsString::from("list"),
            OsString::from("--porcelain"),
            OsString::from("-z"),
        ],
    )?;
    parse_porcelain(&output.stdout, repo)
}

#[derive(Default)]
struct ParsedWorktree {
    path: Option<PathBuf>,
    head: Option<String>,
    branch: Option<String>,
    locked: bool,
    lock_reason: Option<String>,
    prunable: bool,
}

fn parse_porcelain(bytes: &[u8], repo: &RepoPath) -> Result<Vec<Worktree>, GitError> {
    let mut parsed = Vec::new();
    let mut current = ParsedWorktree::default();
    for field in bytes
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty())
    {
        let field = String::from_utf8_lossy(field);
        if let Some(path) = field.strip_prefix("worktree ") {
            if current.path.is_some() {
                parsed.push(std::mem::take(&mut current));
            }
            current.path = Some(PathBuf::from(path));
        } else if let Some(head) = field.strip_prefix("HEAD ") {
            current.head = Some(head.to_string());
        } else if let Some(branch) = field.strip_prefix("branch refs/heads/") {
            current.branch = Some(branch.to_string());
        } else if field == "locked" || field.starts_with("locked ") {
            current.locked = true;
            current.lock_reason = field
                .strip_prefix("locked ")
                .filter(|reason| !reason.is_empty())
                .map(ToString::to_string);
        } else if field == "prunable" || field.starts_with("prunable ") {
            current.prunable = true;
        }
    }
    if current.path.is_some() {
        parsed.push(current);
    }

    let admin_names = admin_names(repo)?;
    parsed
        .into_iter()
        .map(|entry| {
            let path = entry
                .path
                .ok_or_else(|| GitError::WorktreeFailed("worktree list omitted its path".into()))?;
            let is_main = same_path(&path, &repo.0);
            let name = if is_main {
                path.file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "main".into())
            } else {
                admin_names
                    .iter()
                    .find(|(candidate, _)| same_path(candidate, &path))
                    .map(|(_, name)| name.clone())
                    .or_else(|| {
                        path.file_name()
                            .map(|name| name.to_string_lossy().into_owned())
                    })
                    .unwrap_or_else(|| path.to_string_lossy().into_owned())
            };
            Ok(Worktree {
                name,
                path,
                branch: entry.branch,
                head: CommitId(entry.head.unwrap_or_default()),
                is_main,
                is_locked: entry.locked,
                lock_reason: entry.lock_reason,
                is_prunable: entry.prunable,
            })
        })
        .collect()
}

fn admin_names(repo: &RepoPath) -> Result<Vec<(PathBuf, String)>, GitError> {
    let git = git2::Repository::open(&repo.0).map_err(LocalGitBackend::map_git2_error)?;
    let directory = git.commondir().join("worktrees");
    let Ok(entries) = std::fs::read_dir(directory) else {
        return Ok(Vec::new());
    };
    let mut names = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(marker) = std::fs::read_to_string(entry.path().join("gitdir")) else {
            continue;
        };
        let mut path = PathBuf::from(marker.trim());
        if path.file_name().is_some_and(|part| part == ".git") {
            path.pop();
        }
        names.push((path, name));
    }
    Ok(names)
}

fn dirty_count(path: &Path) -> Result<u32, GitError> {
    let git = git2::Repository::open(path).map_err(LocalGitBackend::map_git2_error)?;
    let mut options = git2::StatusOptions::new();
    options.include_untracked(true).recurse_untracked_dirs(true);
    let count = git
        .statuses(Some(&mut options))
        .map_err(LocalGitBackend::map_git2_error)?
        .len() as u32;
    Ok(count)
}

fn same_path(left: &Path, right: &Path) -> bool {
    let left = fjord_fs::canonicalize_path(left).unwrap_or_else(|_| left.to_path_buf());
    let right = fjord_fs::canonicalize_path(right).unwrap_or_else(|_| right.to_path_buf());
    fjord_fs::paths_equal(&left, &right)
}

fn run_git(
    commands: &GitCommandFactory,
    repo: &RepoPath,
    args: &[OsString],
) -> Result<(), GitError> {
    git_output(commands, repo, args).map(|_| ())
}

fn git_output(
    commands: &GitCommandFactory,
    repo: &RepoPath,
    args: &[OsString],
) -> Result<std::process::Output, GitError> {
    let output = commands
        .command()?
        .args(args)
        .current_dir(&repo.0)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| GitError::WorktreeFailed(error.to_string()))?;
    if output.status.success() {
        return Ok(output);
    }
    let diagnostics = String::from_utf8_lossy(&output.stderr);
    let diagnostics = diagnostics.trim().chars().take(2_000).collect::<String>();
    Err(GitError::WorktreeFailed(if diagnostics.is_empty() {
        format!("Git exited with {:?}", output.status.code())
    } else {
        diagnostics
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use fjord_ports::GitBackend;

    fn fixture() -> (tempfile::TempDir, RepoPath, LocalGitBackend) {
        let root = tempfile::TempDir::new().unwrap();
        let repository = root.path().join("repository");
        std::fs::create_dir_all(&repository).unwrap();
        for args in [
            vec!["init", "-b", "main"],
            vec!["config", "user.name", "Fjord Test"],
            vec!["config", "user.email", "fjord@example.test"],
        ] {
            assert!(std::process::Command::new("git")
                .args(args)
                .current_dir(&repository)
                .status()
                .unwrap()
                .success());
        }
        std::fs::write(repository.join("README.md"), "base\n").unwrap();
        assert!(std::process::Command::new("git")
            .args(["add", "README.md"])
            .current_dir(&repository)
            .status()
            .unwrap()
            .success());
        assert!(std::process::Command::new("git")
            .args(["commit", "-m", "initial"])
            .current_dir(&repository)
            .status()
            .unwrap()
            .success());
        (root, RepoPath::new(repository), LocalGitBackend::new())
    }

    #[test]
    fn parses_porcelain_flags_and_branch_names() {
        let root = tempfile::TempDir::new().unwrap();
        git2::Repository::init(root.path()).unwrap();
        let repo = RepoPath::new(root.path().to_path_buf());
        let linked = root.path().parent().unwrap().join("linked");
        let input = format!(
            "worktree {}\0HEAD abc\0branch refs/heads/main\0worktree {}\0HEAD def\0detached\0locked agent\0prunable missing\0",
            root.path().display(),
            linked.display()
        );

        let parsed = parse_porcelain(input.as_bytes(), &repo).unwrap();

        assert_eq!(parsed.len(), 2);
        assert!(parsed[0].is_main);
        assert_eq!(parsed[0].branch.as_deref(), Some("main"));
        assert!(parsed[1].is_locked);
        assert_eq!(parsed[1].lock_reason.as_deref(), Some("agent"));
        assert!(parsed[1].is_prunable);
        assert_eq!(parsed[1].branch, None);
    }

    #[tokio::test]
    async fn lists_and_creates_a_new_branch_like_git_porcelain() {
        let (root, repo, backend) = fixture();
        let destination = root.path().join("feature");

        let created = backend
            .create_worktree(
                &repo,
                "feature",
                &destination,
                WorktreeBranch::New {
                    name: "feature/worktree".into(),
                    start_point: "main".into(),
                },
            )
            .await
            .unwrap();

        assert_eq!(created.name, "feature");
        assert_eq!(created.branch.as_deref(), Some("feature/worktree"));
        assert!(same_path(&created.path, &destination));
        let listed = backend.worktrees(&repo).await.unwrap();
        assert_eq!(listed.len(), 2);
        assert!(listed[0].is_main);
        assert_eq!(listed[1], created);
    }

    #[tokio::test]
    async fn rejects_a_destination_inside_an_existing_working_tree() {
        let (_root, repo, backend) = fixture();
        let destination = repo.0.join("nested-worktree");

        let error = backend
            .create_worktree(
                &repo,
                "nested-worktree",
                &destination,
                WorktreeBranch::New {
                    name: "nested".into(),
                    start_point: "main".into(),
                },
            )
            .await
            .unwrap_err();

        assert!(matches!(error, GitError::InvalidWorktree(_)));
        assert!(!destination.exists());
    }

    #[tokio::test]
    async fn refuses_to_remove_a_dirty_worktree_without_force() {
        let (root, repo, backend) = fixture();
        let destination = root.path().join("dirty");
        let created = backend
            .create_worktree(
                &repo,
                "dirty",
                &destination,
                WorktreeBranch::New {
                    name: "dirty".into(),
                    start_point: "main".into(),
                },
            )
            .await
            .unwrap();
        std::fs::write(destination.join("untracked.txt"), "local\n").unwrap();

        assert!(matches!(
            backend.remove_worktree(&repo, &created.name, false).await,
            Err(GitError::WorktreeDirty)
        ));
        assert!(destination.exists());

        backend
            .remove_worktree(&repo, &created.name, true)
            .await
            .unwrap();
        assert!(!destination.exists());
    }

    #[tokio::test]
    async fn locked_worktree_reports_the_git_reason_even_with_force() {
        let (root, repo, backend) = fixture();
        let destination = root.path().join("locked");
        let created = backend
            .create_worktree(
                &repo,
                "locked",
                &destination,
                WorktreeBranch::New {
                    name: "locked".into(),
                    start_point: "main".into(),
                },
            )
            .await
            .unwrap();
        assert!(std::process::Command::new("git")
            .args(["worktree", "lock", "--reason", "agent is using it"])
            .arg(&destination)
            .current_dir(&repo.0)
            .status()
            .unwrap()
            .success());
        runtime::bump_mutation(&repo, MutationKind::RemoveWorktree);
        let listed = backend.worktrees(&repo).await.unwrap();
        assert_eq!(listed[1].lock_reason.as_deref(), Some("agent is using it"));

        assert!(matches!(
            backend.remove_worktree(&repo, &created.name, true).await,
            Err(GitError::WorktreeLocked(reason)) if reason == "agent is using it"
        ));
    }

    #[tokio::test]
    async fn prunes_a_worktree_whose_path_is_missing() {
        let (root, repo, backend) = fixture();
        let destination = root.path().join("missing");
        let created = backend
            .create_worktree(
                &repo,
                "missing",
                &destination,
                WorktreeBranch::New {
                    name: "missing".into(),
                    start_point: "main".into(),
                },
            )
            .await
            .unwrap();
        std::fs::remove_dir_all(&destination).unwrap();
        runtime::bump_mutation(&repo, MutationKind::RemoveWorktree);

        let listed = backend.worktrees(&repo).await.unwrap();
        assert!(listed
            .iter()
            .any(|worktree| worktree.name == created.name && worktree.is_prunable));

        backend
            .remove_worktree(&repo, &created.name, false)
            .await
            .unwrap();
        assert_eq!(backend.worktrees(&repo).await.unwrap().len(), 1);
    }
}
