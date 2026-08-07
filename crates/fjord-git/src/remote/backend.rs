use std::ffi::OsString;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use fjord_domain::RemoteRef;
use fjord_ports::{GitOperationContext, GitProgress, GitRemoteBackend, GitRemoteError, RepoPath};

use super::environment::remote_process_environment;
use super::errors::classify_failure;
use super::executable::{GitExecutableError, GitExecutableResolver};
use super::process_runner::{
    GitCommandResult, GitCommandSpec, GitProcessEvent, GitProcessEventHandler, GitProcessRunner,
};
use crate::locking;

const REMOTE_OPERATION_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(75);

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
        let throttle = Arc::new(Mutex::new(ProgressThrottle::default()));
        let handler: GitProcessEventHandler = Arc::new(move |event| {
            if let GitProcessEvent::Stdout(line) | GitProcessEvent::Stderr(line) = event {
                if let Some(progress) = parse_progress(&line) {
                    let should_emit = throttle
                        .lock()
                        .expect("progress throttle lock should not be poisoned")
                        .should_emit(&progress);
                    if should_emit {
                        progress_context.emit(progress);
                    }
                }
            }
        });
        let spec = GitCommandSpec {
            executable: executable.path,
            cwd: repo.0.clone(),
            args,
            environment: remote_process_environment(&context),
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

#[derive(Default)]
struct ProgressThrottle {
    last_emit: Option<Instant>,
    last_message: Option<String>,
}

impl ProgressThrottle {
    fn should_emit(&mut self, progress: &GitProgress) -> bool {
        let now = Instant::now();
        let phase_changed = progress.message != self.last_message;
        let finished = progress.total > 0 && progress.completed >= progress.total;
        let interval_elapsed = self
            .last_emit
            .is_none_or(|last| now.duration_since(last) >= PROGRESS_EMIT_INTERVAL);
        if phase_changed || finished || interval_elapsed {
            self.last_emit = Some(now);
            self.last_message.clone_from(&progress.message);
            true
        } else {
            false
        }
    }
}

fn parse_progress(line: &str) -> Option<GitProgress> {
    let line = line.trim().strip_prefix("remote: ").unwrap_or(line.trim());
    let phase = [
        "Enumerating objects",
        "Counting objects",
        "Compressing objects",
        "Receiving objects",
        "Resolving deltas",
        "Writing objects",
        "Total",
    ]
    .into_iter()
    .find(|phase| line.starts_with(phase))?;

    if let Some(open) = line.find('(') {
        if let Some(close) = line[open + 1..].find(')') {
            if let Some((completed, total)) = line[open + 1..open + 1 + close].split_once('/') {
                if let (Ok(completed), Ok(total)) = (completed.parse(), total.parse()) {
                    return Some(GitProgress {
                        completed,
                        total,
                        message: Some(phase.to_string()),
                    });
                }
            }
        }
    }

    let percent = line.find('%')?;
    let digits = line[..percent]
        .chars()
        .rev()
        .take_while(|character| character.is_ascii_digit())
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    digits
        .parse::<u32>()
        .ok()
        .filter(|value| *value <= 100)
        .map(|completed| GitProgress {
            completed,
            total: 100,
            message: Some(phase.to_string()),
        })
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
    use crate::GixGitBackend;
    use fjord_ports::GitBackend;

    #[test]
    fn parses_progress_counts_and_phases() {
        assert_eq!(
            parse_progress("Receiving objects:  42% (21/50)"),
            Some(GitProgress {
                completed: 21,
                total: 50,
                message: Some("Receiving objects".into()),
            })
        );
        assert_eq!(parse_progress("remote: done"), None);
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

        SystemGitRemoteBackend::new()
            .delete_remote_branch(
                &RepoPath::new(source),
                "origin",
                "main",
                GitOperationContext::default(),
            )
            .await
            .unwrap();
        assert!(!git_succeeds(
            &remote,
            &["show-ref", "--verify", "refs/heads/main"]
        ));
    }

    #[tokio::test]
    async fn composed_pull_fast_forwards_merges_and_reports_conflicts() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let remote = temp.path().join("remote.git");
        let clone = temp.path().join("clone");
        std::fs::create_dir(&source).unwrap();
        run_git(&source, &["init", "-b", "main"]);
        configure_identity(&source);
        std::fs::write(source.join("README.md"), "initial\n").unwrap();
        run_git(&source, &["add", "."]);
        run_git(&source, &["commit", "-m", "initial"]);
        run_git(temp.path(), &["init", "--bare", remote.to_str().unwrap()]);
        run_git(
            &source,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        run_git(&source, &["push", "-u", "origin", "main"]);
        run_git(&remote, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        run_git(
            temp.path(),
            &["clone", remote.to_str().unwrap(), clone.to_str().unwrap()],
        );
        configure_identity(&clone);

        let remote_backend = SystemGitRemoteBackend::new();
        let local_backend = GixGitBackend::new();
        let clone_path = RepoPath::new(clone.clone());

        std::fs::write(source.join("remote-only.txt"), "fast-forward\n").unwrap();
        run_git(&source, &["add", "."]);
        run_git(&source, &["commit", "-m", "remote fast-forward"]);
        run_git(&source, &["push"]);
        remote_backend
            .fetch(&clone_path, "origin", &[], GitOperationContext::default())
            .await
            .unwrap();
        local_backend.integrate_upstream(&clone_path).await.unwrap();
        assert_eq!(
            git_output(&clone, &["rev-parse", "HEAD"]),
            git_output(&source, &["rev-parse", "HEAD"])
        );

        std::fs::write(clone.join("local-only.txt"), "local\n").unwrap();
        run_git(&clone, &["add", "."]);
        run_git(&clone, &["commit", "-m", "local change"]);
        std::fs::write(source.join("upstream-only.txt"), "upstream\n").unwrap();
        run_git(&source, &["add", "."]);
        run_git(&source, &["commit", "-m", "upstream change"]);
        run_git(&source, &["push"]);
        remote_backend
            .fetch(&clone_path, "origin", &[], GitOperationContext::default())
            .await
            .unwrap();
        local_backend.integrate_upstream(&clone_path).await.unwrap();
        assert_eq!(
            git_output(&clone, &["rev-list", "--parents", "-n", "1", "HEAD"])
                .split_whitespace()
                .count(),
            3
        );
        assert!(clone.join("local-only.txt").is_file());
        assert!(clone.join("upstream-only.txt").is_file());

        std::fs::write(clone.join("conflict.txt"), "local\n").unwrap();
        run_git(&clone, &["add", "."]);
        run_git(&clone, &["commit", "-m", "local conflict"]);
        std::fs::write(source.join("conflict.txt"), "remote\n").unwrap();
        run_git(&source, &["add", "."]);
        run_git(&source, &["commit", "-m", "remote conflict"]);
        run_git(&source, &["push"]);
        remote_backend
            .fetch(&clone_path, "origin", &[], GitOperationContext::default())
            .await
            .unwrap();
        let error = local_backend
            .integrate_upstream(&clone_path)
            .await
            .unwrap_err();
        assert!(matches!(error, fjord_ports::GitError::Conflict { .. }));
        assert!(git2::Repository::open(&clone)
            .unwrap()
            .index()
            .unwrap()
            .has_conflicts());
    }

    fn run_git(cwd: &Path, args: &[&str]) {
        let status = std::process::Command::new("git")
            .args(args)
            .current_dir(cwd)
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?} failed");
    }

    fn configure_identity(cwd: &Path) {
        run_git(cwd, &["config", "user.name", "Fjord Test"]);
        run_git(cwd, &["config", "user.email", "fjord@example.test"]);
        run_git(cwd, &["config", "core.autocrlf", "false"]);
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

    fn git_succeeds(cwd: &Path, args: &[&str]) -> bool {
        std::process::Command::new("git")
            .args(args)
            .current_dir(cwd)
            .status()
            .unwrap()
            .success()
    }
}
