use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use fjord_domain::{GitExecutable, GitExecutableSource};
use thiserror::Error;
use tokio::process::Command;

const VERSION_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Error)]
pub enum GitExecutableError {
    #[error("configured Git executable is invalid: {0}")]
    InvalidConfiguredPath(PathBuf),
    #[error("system Git executable not found")]
    NotFound,
}

#[derive(Debug, Clone, Default)]
pub struct GitExecutableResolver;

impl GitExecutableResolver {
    pub async fn discover(
        &self,
        configured_path: Option<&Path>,
    ) -> Result<GitExecutable, GitExecutableError> {
        if let Some(path) = configured_path {
            return validate_candidate(path, GitExecutableSource::Settings)
                .await
                .ok_or_else(|| GitExecutableError::InvalidConfiguredPath(path.to_path_buf()));
        }

        for (path, source) in discovery_candidates() {
            if let Some(executable) = validate_candidate(&path, source).await {
                return Ok(executable);
            }
        }

        Err(GitExecutableError::NotFound)
    }
}

async fn validate_candidate(path: &Path, source: GitExecutableSource) -> Option<GitExecutable> {
    if !path.is_file() {
        return None;
    }

    let mut command = Command::new(path);
    command
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    suppress_console_window(&mut command);

    let output = tokio::time::timeout(VERSION_TIMEOUT, command.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let version = parse_git_version(&stdout)?;
    Some(GitExecutable {
        path: path.to_path_buf(),
        version,
        source,
    })
}

fn discovery_candidates() -> Vec<(PathBuf, GitExecutableSource)> {
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();

    if let Some(path) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path) {
            for name in executable_names() {
                push_unique(
                    &mut candidates,
                    &mut seen,
                    directory.join(name),
                    GitExecutableSource::Path,
                );
            }
        }
    }

    for path in standard_locations() {
        push_unique(
            &mut candidates,
            &mut seen,
            path,
            GitExecutableSource::StandardLocation,
        );
    }

    candidates
}

fn push_unique(
    candidates: &mut Vec<(PathBuf, GitExecutableSource)>,
    seen: &mut HashSet<PathBuf>,
    path: PathBuf,
    source: GitExecutableSource,
) {
    if seen.insert(path.clone()) {
        candidates.push((path, source));
    }
}

#[cfg(windows)]
fn executable_names() -> &'static [&'static str] {
    &["git.exe"]
}

#[cfg(not(windows))]
fn executable_names() -> &'static [&'static str] {
    &["git"]
}

fn standard_locations() -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        let mut paths = vec![
            PathBuf::from(r"C:\Program Files\Git\cmd\git.exe"),
            PathBuf::from(r"C:\Program Files\Git\bin\git.exe"),
        ];
        if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
            paths.push(
                PathBuf::from(local_app_data)
                    .join("Programs")
                    .join("Git")
                    .join("cmd")
                    .join("git.exe"),
            );
        }
        paths
    }

    #[cfg(target_os = "macos")]
    {
        vec![
            PathBuf::from("/usr/bin/git"),
            PathBuf::from("/opt/homebrew/bin/git"),
            PathBuf::from("/usr/local/bin/git"),
        ]
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        vec![
            PathBuf::from("/usr/bin/git"),
            PathBuf::from("/usr/local/bin/git"),
        ]
    }
}

fn parse_git_version(output: &str) -> Option<String> {
    let value = output.trim().strip_prefix("git version ")?.trim();
    if value.is_empty() || !value.chars().any(|character| character.is_ascii_digit()) {
        return None;
    }
    Some(value.to_string())
}

#[cfg(windows)]
fn suppress_console_window(command: &mut Command) {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn suppress_console_window(_command: &mut Command) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_recognizable_version_output() {
        assert_eq!(
            parse_git_version("git version 2.50.1.windows.1\n"),
            Some("2.50.1.windows.1".into())
        );
        assert_eq!(parse_git_version("not git"), None);
        assert_eq!(parse_git_version("git version unknown"), None);
    }

    #[tokio::test]
    async fn configured_path_has_priority_and_is_validated() {
        let path = discovery_candidates()
            .into_iter()
            .find_map(|(path, _)| path.is_file().then_some(path))
            .expect("test requires Git on PATH or in a standard location");
        let executable = GitExecutableResolver.discover(Some(&path)).await.unwrap();
        assert_eq!(executable.path, path);
        assert_eq!(executable.source, GitExecutableSource::Settings);
    }

    #[tokio::test]
    async fn invalid_configured_path_is_not_silently_ignored() {
        let path = PathBuf::from("definitely-missing-fjord-git");
        let result = GitExecutableResolver.discover(Some(&path)).await;
        assert!(matches!(
            result,
            Err(GitExecutableError::InvalidConfiguredPath(found)) if found == path
        ));
    }

    #[tokio::test]
    async fn discovers_git_from_the_environment() {
        let executable = GitExecutableResolver.discover(None).await.unwrap();
        assert!(!executable.version.is_empty());
        assert!(executable.path.is_file());
    }
}
