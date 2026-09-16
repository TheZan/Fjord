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
        let dot_git = path.join(".git");
        if dot_git.is_dir() {
            repos.push(path);
            if repos.len() >= limit {
                break;
            }
            continue;
        }
        // Linked worktrees (and submodules, deliberately outside this phase)
        // use a `.git` indirection file. They belong to the parent repository
        // and must never become duplicate workspace entries.
        if is_linked_worktree(&path) {
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

pub fn is_linked_worktree(path: &Path) -> bool {
    let marker = path.join(".git");
    marker.is_file()
        && fs::read_to_string(marker)
            .ok()
            .and_then(|value| {
                value
                    .trim()
                    .strip_prefix("gitdir:")
                    .map(str::trim)
                    .filter(|target| !target.is_empty())
                    .map(ToOwned::to_owned)
            })
            .is_some()
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
        fs::create_dir_all(repository.join(".git").join("worktrees").join("feature")).unwrap();
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
}
