use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use fjord_domain::{
    CredentialHelperInfo, GitConnectionProtocol, GitConnectionTestResult, GitEnvironmentInfo,
};
use fjord_ports::{
    GitEnvironmentError, GitEnvironmentProvider, GitOperationContext, GitRemoteBackend,
    GitRemoteError, RepoPath,
};

use super::backend::SystemGitRemoteBackend;
use super::errors::sanitize_diagnostics;
use super::executable::{GitExecutableError, GitExecutableResolver};
use super::process_runner::{GitCommandResult, GitCommandSpec, GitProcessRunner};

const DIAGNOSTIC_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Default)]
pub struct SystemGitEnvironmentProvider {
    resolver: GitExecutableResolver,
    runner: GitProcessRunner,
    remote: SystemGitRemoteBackend,
}

impl SystemGitEnvironmentProvider {
    pub fn new() -> Self {
        Self::default()
    }

    async fn run(
        &self,
        executable: &Path,
        cwd: PathBuf,
        args: Vec<OsString>,
    ) -> Result<GitCommandResult, GitEnvironmentError> {
        self.runner
            .run(
                &GitCommandSpec {
                    executable: executable.to_path_buf(),
                    cwd,
                    args,
                    environment: vec![("LC_ALL".into(), "C".into()), ("LANG".into(), "C".into())],
                    timeout: Some(DIAGNOSTIC_TIMEOUT),
                },
                GitOperationContext::default(),
                None,
            )
            .await
            .map_err(|error| GitEnvironmentError::InspectionFailed(error.to_string()))
    }
}

#[async_trait]
impl GitEnvironmentProvider for SystemGitEnvironmentProvider {
    async fn inspect(
        &self,
        configured_path: Option<&Path>,
    ) -> Result<GitEnvironmentInfo, GitEnvironmentError> {
        let executable =
            self.resolver
                .discover(configured_path)
                .await
                .map_err(|error| match error {
                    GitExecutableError::InvalidConfiguredPath(_) => {
                        GitEnvironmentError::InvalidConfiguredPath
                    }
                    GitExecutableError::NotFound => GitEnvironmentError::GitExecutableNotFound,
                })?;
        let cwd = std::env::current_dir()
            .map_err(|error| GitEnvironmentError::InspectionFailed(error.to_string()))?;

        let helpers = self
            .run(
                &executable.path,
                cwd.clone(),
                vec![
                    "config".into(),
                    "--show-origin".into(),
                    "--get-all".into(),
                    "credential.helper".into(),
                ],
            )
            .await?;
        let ssh_command = self
            .run(
                &executable.path,
                cwd.clone(),
                vec![
                    "config".into(),
                    "--show-origin".into(),
                    "--get".into(),
                    "core.sshCommand".into(),
                ],
            )
            .await?;
        let proxy = self
            .run(
                &executable.path,
                cwd,
                vec![
                    "config".into(),
                    "--show-origin".into(),
                    "--get".into(),
                    "http.proxy".into(),
                ],
            )
            .await?;

        Ok(GitEnvironmentInfo {
            executable_path: Some(executable.path),
            version: Some(executable.version),
            executable_source: Some(executable.source),
            configured_path_valid: true,
            credential_helpers: parse_helpers(&helpers.stdout),
            ssh_command: successful_value(&ssh_command),
            ssh_agent_available: std::env::var_os("SSH_AUTH_SOCK")
                .is_some_and(|value| !value.is_empty()),
            proxy_configured: proxy.exit_code == Some(0) && !proxy.stdout.trim().is_empty(),
        })
    }

    async fn test_connection(
        &self,
        repo: &RepoPath,
        remote: &str,
        context: GitOperationContext,
    ) -> Result<GitConnectionTestResult, GitRemoteError> {
        let executable = self
            .resolver
            .discover(context.git_executable_path())
            .await
            .map_err(|_| GitRemoteError::GitExecutableNotFound)?;
        let remote_url = self
            .run(
                &executable.path,
                repo.0.clone(),
                vec!["remote".into(), "get-url".into(), remote.into()],
            )
            .await
            .ok()
            .filter(|result| result.exit_code == Some(0))
            .map(|result| result.stdout.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| remote.to_string());

        let started = Instant::now();
        let refs = self.remote.ls_remote(repo, remote, context).await?;
        Ok(GitConnectionTestResult {
            success: true,
            duration_ms: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
            remote: remote.to_string(),
            protocol: classify_protocol(&remote_url),
            reference_count: refs.len().min(u32::MAX as usize) as u32,
        })
    }
}

fn successful_value(result: &GitCommandResult) -> Option<String> {
    (result.exit_code == Some(0))
        .then(|| sanitize_diagnostics(result.stdout.trim()))
        .filter(|value| !value.is_empty())
}

fn parse_helpers(output: &str) -> Vec<CredentialHelperInfo> {
    output
        .lines()
        .filter_map(|line| {
            let (source, value) = line.split_once('\t').or_else(|| line.split_once(' '))?;
            let value = value.trim();
            let value = if value.starts_with('!') {
                "[custom shell helper]".to_string()
            } else {
                sanitize_diagnostics(value)
            };
            (!value.is_empty()).then(|| CredentialHelperInfo {
                value,
                source: sanitize_diagnostics(source.trim()),
            })
        })
        .collect()
}

fn classify_protocol(url: &str) -> GitConnectionProtocol {
    let lowered = url.to_ascii_lowercase();
    if lowered.starts_with("https://") || lowered.starts_with("http://") {
        GitConnectionProtocol::Https
    } else if lowered.starts_with("ssh://") || (url.contains('@') && url.split_once(':').is_some())
    {
        GitConnectionProtocol::Ssh
    } else if lowered.starts_with("file://") || Path::new(url).is_absolute() || url.starts_with('.')
    {
        GitConnectionProtocol::Local
    } else {
        GitConnectionProtocol::Other
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_helper_origins_without_exposing_custom_commands() {
        let helpers = parse_helpers(
            "file:C:/Users/test/.gitconfig\tmanager-core\ncommand line:\t!echo token=secret\n",
        );
        assert_eq!(helpers.len(), 2);
        assert_eq!(helpers[0].value, "manager-core");
        assert_eq!(helpers[1].value, "[custom shell helper]");
    }

    #[test]
    fn classifies_connection_protocols() {
        assert_eq!(
            classify_protocol("https://example.test/repo"),
            GitConnectionProtocol::Https
        );
        assert_eq!(
            classify_protocol("git@example.test:repo.git"),
            GitConnectionProtocol::Ssh
        );
        assert_eq!(
            classify_protocol("file:///tmp/repo.git"),
            GitConnectionProtocol::Local
        );
    }

    #[tokio::test]
    async fn inspects_the_installed_git_environment() {
        let info = SystemGitEnvironmentProvider::new()
            .inspect(None)
            .await
            .unwrap();
        assert!(info.executable_path.unwrap().is_file());
        assert!(!info.version.unwrap().is_empty());
        assert!(info.configured_path_valid);
    }

    #[tokio::test]
    async fn connection_test_is_read_only_for_a_local_remote() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        let remote = temp.path().join("remote.git");
        std::fs::create_dir(&repo).unwrap();
        run_git(&repo, &["init"]);
        run_git(temp.path(), &["init", "--bare", remote.to_str().unwrap()]);
        run_git(
            &repo,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        let git_dir_before = directory_entry_count(&repo.join(".git"));

        let result = SystemGitEnvironmentProvider::new()
            .test_connection(
                &RepoPath::new(repo.clone()),
                "origin",
                GitOperationContext::default(),
            )
            .await
            .unwrap();

        assert!(result.success);
        assert_eq!(result.protocol, GitConnectionProtocol::Local);
        assert_eq!(directory_entry_count(&repo.join(".git")), git_dir_before);
    }

    fn run_git(cwd: &Path, args: &[&str]) {
        assert!(std::process::Command::new("git")
            .args(args)
            .current_dir(cwd)
            .status()
            .unwrap()
            .success());
    }

    fn directory_entry_count(path: &Path) -> usize {
        std::fs::read_dir(path).unwrap().count()
    }
}
