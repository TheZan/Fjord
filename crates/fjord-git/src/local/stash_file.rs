//! File-scoped stash (`P10-WC-05`): `git stash push -u -m … -- <path>`.
//!
//! The invariant this module exists to uphold: stashing one selected file
//! preserves every unrelated staged, unstaged, and untracked change
//! byte-for-byte. That is Git's own pathspec-scoped stash behavior — `-u` is
//! passed unconditionally (harmless for a tracked path, required for an
//! untracked one) rather than branching per file state, because the
//! pathspec is what bounds the operation, not the flag. Never implemented by
//! hiding other changes, stashing everything, and restoring the rest: that
//! sequence has no atomic boundary and fails destructively on interruption.

use fjord_ports::{GitError, RepoPath};

use crate::executable::GitCommandFactory;
use crate::local::LocalGitBackend;

/// Git added pathspec-limited `stash push -- <path>` in 2.13.0.
const MINIMUM_VERSION: (u32, u32) = (2, 13);

fn meets_minimum_version(version_output: &str) -> bool {
    let Some(version) = version_output.trim().strip_prefix("git version ") else {
        return false;
    };
    let mut parts = version.split('.');
    let major: Option<u32> = parts.next().and_then(|part| part.parse().ok());
    let minor: Option<u32> = parts.next().and_then(|part| part.parse().ok());
    match (major, minor) {
        (Some(major), Some(minor)) => (major, minor) >= MINIMUM_VERSION,
        _ => false,
    }
}

pub(super) async fn supported(commands: &GitCommandFactory) -> Result<bool, GitError> {
    let commands = commands.clone();
    tokio::task::spawn_blocking(move || {
        let output = commands
            .command()?
            .arg("--version")
            .output()
            .map_err(|error| GitError::Git2(error.to_string()))?;
        Ok(meets_minimum_version(&String::from_utf8_lossy(
            &output.stdout,
        )))
    })
    .await
    .map_err(|error| GitError::Git2(error.to_string()))?
}

pub(super) async fn stash(
    commands: &GitCommandFactory,
    repo: &RepoPath,
    path: &str,
    message: &str,
) -> Result<(), GitError> {
    let commands = commands.clone();
    let repo = repo.clone();
    let path = path.to_string();
    let message = message.to_string();
    let _repo_guard = LocalGitBackend::acquire_repo_write_lock(&repo).await;
    tokio::task::spawn_blocking(move || {
        if !meets_minimum_version(&String::from_utf8_lossy(
            &commands
                .command()?
                .arg("--version")
                .output()
                .map_err(|error| GitError::Git2(error.to_string()))?
                .stdout,
        )) {
            return Err(GitError::StashFileUnsupportedGit);
        }

        LocalGitBackend::with_runtime_git2(&repo, |git| {
            if git
                .status_file(std::path::Path::new(&path))
                .map(|status| status.is_conflicted())
                .unwrap_or(false)
            {
                return Err(GitError::StashFileConflicted { path: path.clone() });
            }
            Ok(())
        })?;

        let output = commands
            .command()?
            .args(["stash", "push", "-u", "-m", &message, "--", &path])
            .current_dir(&repo.0)
            .output()
            .map_err(|error| GitError::Git2(error.to_string()))?;
        if !output.status.success() {
            return Err(GitError::Git2(
                String::from_utf8_lossy(&output.stderr).trim().to_string(),
            ));
        }
        Ok(())
    })
    .await
    .map_err(|error| GitError::Git2(error.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_supported_versions() {
        assert!(meets_minimum_version("git version 2.13.0"));
        assert!(meets_minimum_version("git version 2.50.1.windows.1"));
        assert!(meets_minimum_version("git version 3.0.0"));
    }

    #[test]
    fn rejects_unsupported_versions() {
        assert!(!meets_minimum_version("git version 2.12.9"));
        assert!(!meets_minimum_version("git version 1.9.0"));
        assert!(!meets_minimum_version("not git"));
        assert!(!meets_minimum_version(""));
    }
}
