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
use super::process_runner::{GitCommandResult, GitCommandSpec, GitProcessRunner, OutputCapture};

const DIAGNOSTIC_TIMEOUT: Duration = Duration::from_secs(15);
/// Diagnostic commands print a handful of config lines; anything larger is a
/// misconfiguration, not something worth buffering.
const DIAGNOSTIC_STDOUT_LIMIT: usize = 1024 * 1024;

pub(crate) fn remote_process_environment(
    context: &GitOperationContext,
) -> Vec<(OsString, OsString)> {
    let mut environment = vec![("LC_ALL".into(), "C".into()), ("LANG".into(), "C".into())];
    let Some(askpass) = context.askpass() else {
        return environment;
    };

    let executable = askpass.executable().as_os_str().to_owned();
    environment.extend([
        ("GIT_ASKPASS".into(), executable.clone()),
        ("SSH_ASKPASS".into(), executable),
        ("FJORD_ASKPASS_ADDRESS".into(), askpass.address().into()),
        ("FJORD_ASKPASS_TOKEN".into(), askpass.token().into()),
        (
            "FJORD_ASKPASS_OPERATION_ID".into(),
            askpass.operation_id().into(),
        ),
    ]);

    // OpenSSH on Unix otherwise ignores SSH_ASKPASS when no graphical
    // display exists. These values are process-local and are not needed on
    // Windows, where Git for Windows invokes the askpass executable directly.
    #[cfg(unix)]
    {
        environment.push(("SSH_ASKPASS_REQUIRE".into(), "force".into()));
        if std::env::var_os("DISPLAY").is_none() {
            environment.push(("DISPLAY".into(), "fjord-askpass".into()));
        }
    }

    environment
}

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
                    stdout_capture: OutputCapture::Full {
                        max_bytes: DIAGNOSTIC_STDOUT_LIMIT,
                    },
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
        // An invalid *configured* path is a state to report, not an inspection
        // failure: Settings has to be able to render "the path you chose does
        // not work" next to the rest of the environment. Discovery deliberately
        // does not fall back to `PATH` here — reporting a different Git than the
        // one that will actually run is the confusion P5-20 removes.
        let executable = match self.resolver.discover(configured_path).await {
            Ok(executable) => executable,
            Err(GitExecutableError::InvalidConfiguredPath(_)) => {
                return Ok(GitEnvironmentInfo {
                    executable_path: None,
                    version: None,
                    executable_source: None,
                    configured_path_valid: false,
                    credential_helpers: Vec::new(),
                    ssh_command: None,
                    ssh_agent_available: false,
                    proxy_configured: false,
                })
            }
            Err(GitExecutableError::NotFound) => {
                return Err(GitEnvironmentError::GitExecutableNotFound)
            }
        };
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
    use fjord_ports::GitAskpassConfig;

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

    #[test]
    fn adds_operation_scoped_askpass_environment_without_disabling_helpers() {
        let context = GitOperationContext::default().with_askpass(Some(GitAskpassConfig::new(
            PathBuf::from("/tmp/fjord askpass"),
            "127.0.0.1:12345".into(),
            "secret-token".into(),
            "op-1".into(),
        )));
        let environment = remote_process_environment(&context);
        let value = |name: &str| {
            environment
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.to_string_lossy().into_owned())
        };

        assert_eq!(value("GIT_ASKPASS").as_deref(), Some("/tmp/fjord askpass"));
        assert_eq!(
            value("FJORD_ASKPASS_ADDRESS").as_deref(),
            Some("127.0.0.1:12345")
        );
        assert_eq!(value("FJORD_ASKPASS_OPERATION_ID").as_deref(), Some("op-1"));
        assert!(value("GIT_TERMINAL_PROMPT").is_none());
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
