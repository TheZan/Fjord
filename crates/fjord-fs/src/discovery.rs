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

fn should_skip_dir(name: &str) -> bool {
    matches!(
        name,
        ".git" | ".hg" | ".svn" | ".venv" | "build" | "dist" | "node_modules" | "target" | "vendor"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn discovers_nested_git_repositories() {
        let root = tempfile_dir();
        let app = root.join("app");
        let nested = root.join("libs").join("core");
        fs::create_dir_all(app.join(".git")).unwrap();
        fs::create_dir_all(nested.join(".git")).unwrap();

        let repos = discover_git_repositories(&root, 10).unwrap();

        assert_eq!(repos, vec![app, nested]);
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn does_not_descend_into_known_heavy_directories() {
        let root = tempfile_dir();
        fs::create_dir_all(root.join("target").join("generated").join(".git")).unwrap();

        let repos = discover_git_repositories(&root, 10).unwrap();

        assert!(repos.is_empty());
        fs::remove_dir_all(root).ok();
    }

    fn tempfile_dir() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("fjord-discovery-test-{nonce}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }
}
