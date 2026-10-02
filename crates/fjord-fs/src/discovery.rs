use std::fs;
use std::path::{Path, PathBuf};

use thiserror::Error;

#[derive(Debug, Error)]
pub enum DiscoveryError {
    #[error("repository discovery root is not a directory: {0}")]
    RootNotDirectory(PathBuf),
    #[error("failed to read repository discovery root {path}: {source}")]
    ReadRoot {
        path: PathBuf,
        source: std::io::Error,
    },
}

pub fn discover_git_repositories(
    root: &Path,
    limit: usize,
) -> Result<Vec<PathBuf>, DiscoveryError> {
    if !root.is_dir() {
        return Err(DiscoveryError::RootNotDirectory(root.to_path_buf()));
    }

    let mut repos = Vec::new();
    let mut stack = vec![root.to_path_buf()];

    while let Some(path) = stack.pop() {
        // Linked worktrees use a `.git` indirection file whose git-dir has a
        // `commondir`. They belong to the parent repository and must never
        // become duplicate workspace entries.
        if is_linked_worktree(&path) {
            continue;
        }
        // Any other `.git` — a directory, or an indirection file such as
        // `git init --separate-git-dir` writes — is a repository of its own.
        if path.join(".git").exists() {
            repos.push(path);
            if repos.len() >= limit {
                break;
            }
            continue;
        }

        let entries = match fs::read_dir(&path) {
            Ok(entries) => entries,
            Err(source) if path == root => {
                return Err(DiscoveryError::ReadRoot { path, source });
            }
            Err(_) => continue,
        };

        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_dir() {
                continue;
            }

            let file_name = entry.file_name();
            let file_name = file_name.to_string_lossy();
            if should_skip_dir(&file_name) {
                continue;
            }

            stack.push(entry.path());
        }
    }

    repos.sort();
    Ok(repos)
}

/// Whether `path` is the root of a linked worktree: its `.git` is a file
/// naming a git-dir that contains `commondir`. A repository created with
/// `--separate-git-dir` also uses a `.git` file, but its git-dir is a complete
/// repository without `commondir`, so it is not mistaken for a worktree.
pub fn is_linked_worktree(path: &Path) -> bool {
    let marker = path.join(".git");
    if !marker.is_file() {
        return false;
    }
    let Some(target) = fs::read_to_string(marker).ok().and_then(|value| {
        value
            .lines()
            .next()?
            .trim()
            .strip_prefix("gitdir:")
            .map(str::trim)
            .filter(|target| !target.is_empty())
            .map(PathBuf::from)
    }) else {
        return false;
    };
    let git_dir = if target.is_absolute() {
        target
    } else {
        path.join(target)
    };
    git_dir.join("commondir").is_file()
}

fn should_skip_dir(name: &str) -> bool {
    matches!(
        name,
        ".git" | ".hg" | ".svn" | ".venv" | "build" | "dist" | "node_modules" | "target" | "vendor"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn discovers_nested_git_repositories() {
        let root = TempDir::new().unwrap();
        let app = root.path().join("app");
        let nested = root.path().join("libs").join("core");
        fs::create_dir_all(app.join(".git")).unwrap();
        fs::create_dir_all(nested.join(".git")).unwrap();

        let repos = discover_git_repositories(root.path(), 10).unwrap();

        assert_eq!(repos, vec![app, nested]);
    }

    #[test]
    fn does_not_descend_into_known_heavy_directories() {
        let root = TempDir::new().unwrap();
        fs::create_dir_all(root.path().join("target").join("generated").join(".git")).unwrap();

        let repos = discover_git_repositories(root.path(), 10).unwrap();

        assert!(repos.is_empty());
    }

    #[test]
    fn imports_parent_repository_but_not_its_linked_worktrees() {
        let root = TempDir::new().unwrap();
        let repository = root.path().join("repository");
        let linked = root.path().join("repository-feature");
        let admin = repository.join(".git").join("worktrees").join("feature");
        fs::create_dir_all(&admin).unwrap();
        fs::write(admin.join("commondir"), "../..\n").unwrap();
        fs::create_dir_all(&linked).unwrap();
        fs::write(
            linked.join(".git"),
            format!(
                "gitdir: {}\n",
                repository
                    .join(".git")
                    .join("worktrees")
                    .join("feature")
                    .display()
            ),
        )
        .unwrap();

        let repos = discover_git_repositories(root.path(), 10).unwrap();

        assert_eq!(repos, vec![repository]);
        assert!(is_linked_worktree(&linked));
    }

    #[test]
    fn a_separate_git_dir_repository_is_imported_not_skipped_as_a_worktree() {
        let root = TempDir::new().unwrap();
        let work = root.path().join("work");
        let store = root.path().join("store");
        fs::create_dir_all(&work).unwrap();
        fs::create_dir_all(store.join("refs")).unwrap();
        fs::write(store.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        fs::write(work.join(".git"), format!("gitdir: {}\n", store.display())).unwrap();

        assert!(!is_linked_worktree(&work));
        assert_eq!(
            discover_git_repositories(root.path(), 10).unwrap(),
            vec![work]
        );
    }
}
