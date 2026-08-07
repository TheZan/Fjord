use std::ffi::OsString;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use fjord_domain::RemoteRef;
use fjord_ports::{GitOperationContext, GitProgress, GitRemoteBackend, GitRemoteError, RepoPath};

use super::errors::classify_failure;
use super::executable::{GitExecutableError, GitExecutableResolver};
use super::process_runner::{
    GitCommandResult, GitCommandSpec, GitProcessEvent, GitProcessEventHandler, GitProcessRunner,
};
use crate::locking;

const REMOTE_OPERATION_TIMEOUT: Duration = Duration::from_secs(30 * 60);

#[derive(Debug, Clone, Default)]
pub struct SystemGitRemoteBackend {
    resolver: GitExecutableResolver,
    runner: GitProcessRunner,
}

impl SystemGitRemoteBackend {
    pub fn new() -> Self {
        Self::default()
    }

    async fn run(
        &self,
        repo: &RepoPath,
        args: Vec<OsString>,
        context: GitOperationContext,
    ) -> Result<GitCommandResult, GitRemoteError> {
        let executable = self
            .resolver
            .discover(context.git_executable_path())
            .await
            .map_err(|error| match error {
                GitExecutableError::InvalidConfiguredPath(_) | GitExecutableError::NotFound => {
                    GitRemoteError::GitExecutableNotFound
                }
            })?;
        let progress_context = context.clone();
        let handler: GitProcessEventHandler = Arc::new(move |event| {
            if let GitProcessEvent::Stdout(line) | GitProcessEvent::Stderr(line) = event {
                if let Some(percent) = parse_percent(&line) {
                    progress_context.emit(GitProgress {
                        completed: percent,
                        total: 100,
                    });
                }
            }
        });
        let spec = GitCommandSpec {
            executable: executable.path,
            cwd: repo.0.clone(),
            args,
            environment: vec![("LC_ALL".into(), "C".into()), ("LANG".into(), "C".into())],
            timeout: Some(REMOTE_OPERATION_TIMEOUT),
        };
        let result = self.runner.run(&spec, context, Some(handler)).await?;
        if result.exit_code == Some(0) {
            Ok(result)
        } else {
            Err(classify_failure(
                result.exit_code,
                &result.stdout,
                &result.stderr_tail,
            ))
        }
    }
}

#[async_trait]
impl GitRemoteBackend for SystemGitRemoteBackend {
    async fn fetch(
        &self,
        repo: &RepoPath,
        remote: &str,
        refspecs: &[String],
        context: GitOperationContext,
    ) -> Result<(), GitRemoteError> {
        let _guard = locking::write(repo).await;
        let mut args = vec!["fetch".into(), "--prune".into(), remote.into()];
        args.extend(refspecs.iter().map(OsString::from));
        self.run(repo, args, context).await.map(|_| ())
    }

    async fn push(
        &self,
        repo: &RepoPath,
        remote: &str,
        refspecs: &[String],
        context: GitOperationContext,
    ) -> Result<(), GitRemoteError> {
        let _guard = locking::write(repo).await;
        let mut args = vec!["push".into(), remote.into()];
        args.extend(refspecs.iter().map(OsString::from));
        self.run(repo, args, context).await.map(|_| ())
    }

    async fn delete_remote_branch(
        &self,
        repo: &RepoPath,
        remote: &str,
        branch: &str,
        context: GitOperationContext,
    ) -> Result<(), GitRemoteError> {
        let _guard = locking::write(repo).await;
        self.run(
            repo,
            vec![
                "push".into(),
                remote.into(),
                "--delete".into(),
                branch.into(),
            ],
            context,
        )
        .await
        .map(|_| ())
    }

    async fn ls_remote(
        &self,
        repo: &RepoPath,
        remote: &str,
        context: GitOperationContext,
    ) -> Result<Vec<RemoteRef>, GitRemoteError> {
        let _guard = locking::read(repo).await;
        let result = self
            .run(
                repo,
                vec!["ls-remote".into(), "--symref".into(), remote.into()],
                context,
            )
            .await?;
        Ok(parse_ls_remote(&result.stdout))
    }
}

fn parse_percent(line: &str) -> Option<u32> {
    let percent = line.find('%')?;
    let digits = line[..percent]
        .chars()
        .rev()
        .take_while(|character| character.is_ascii_digit())
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    digits.parse::<u32>().ok().filter(|value| *value <= 100)
}

fn parse_ls_remote(output: &str) -> Vec<RemoteRef> {
    let mut symbolic = std::collections::HashMap::new();
    let mut refs = Vec::new();
    for line in output.lines() {
        let Some((target, name)) = line.split_once('\t') else {
            continue;
        };
        if let Some(target) = target.strip_prefix("ref: ") {
            symbolic.insert(name.to_string(), target.to_string());
        } else {
            refs.push(RemoteRef {
                name: name.to_string(),
                target: target.to_string(),
                symbolic_target: symbolic.get(name).cloned(),
            });
        }
    }
    refs
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    #[test]
    fn parses_progress_percentages() {
        assert_eq!(parse_percent("Receiving objects:  42% (42/100)"), Some(42));
        assert_eq!(parse_percent("remote: done"), None);
    }

    #[test]
    fn parses_symbolic_and_direct_remote_refs() {
        let refs =
            parse_ls_remote("ref: refs/heads/main\tHEAD\nabc123\tHEAD\nabc123\trefs/heads/main\n");
        assert_eq!(refs.len(), 2);
        assert_eq!(refs[0].name, "HEAD");
        assert_eq!(refs[0].symbolic_target.as_deref(), Some("refs/heads/main"));
    }

    #[tokio::test]
    async fn fetch_and_push_use_the_system_git_transport() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let remote = temp.path().join("remote.git");
        let clone = temp.path().join("clone");
        std::fs::create_dir(&source).unwrap();
        run_git(&source, &["init", "-b", "main"]);
        run_git(&source, &["config", "user.name", "Fjord Test"]);
        run_git(&source, &["config", "user.email", "fjord@example.test"]);
        std::fs::write(source.join("README.md"), "one\n").unwrap();
        run_git(&source, &["add", "."]);
        run_git(&source, &["commit", "-m", "initial"]);
        run_git(temp.path(), &["init", "--bare", remote.to_str().unwrap()]);
        run_git(
            &source,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        run_git(&source, &["push", "-u", "origin", "main"]);
        run_git(
            temp.path(),
            &["clone", remote.to_str().unwrap(), clone.to_str().unwrap()],
        );

        std::fs::write(source.join("README.md"), "two\n").unwrap();
        run_git(&source, &["commit", "-am", "second"]);
        run_git(&source, &["push"]);
        let expected = git_output(&source, &["rev-parse", "HEAD"]);

        SystemGitRemoteBackend::new()
            .fetch(
                &RepoPath::new(clone.clone()),
                "origin",
                &[],
                GitOperationContext::default(),
            )
            .await
            .unwrap();

        assert_eq!(git_output(&clone, &["rev-parse", "origin/main"]), expected);

        std::fs::write(source.join("README.md"), "three\n").unwrap();
        run_git(&source, &["commit", "-am", "third"]);
        let expected = git_output(&source, &["rev-parse", "HEAD"]);
        SystemGitRemoteBackend::new()
            .push(
                &RepoPath::new(source.clone()),
                "origin",
                &["refs/heads/main:refs/heads/main".into()],
                GitOperationContext::default(),
            )
            .await
            .unwrap();
        assert_eq!(
            git_output(&remote, &["rev-parse", "refs/heads/main"]),
            expected
        );
    }

    fn run_git(cwd: &Path, args: &[&str]) {
        let status = std::process::Command::new("git")
            .args(args)
            .current_dir(cwd)
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?} failed");
    }

    fn git_output(cwd: &Path, args: &[&str]) -> String {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .unwrap();
        assert!(output.status.success(), "git {args:?} failed");
        String::from_utf8(output.stdout).unwrap().trim().to_string()
    }
}
