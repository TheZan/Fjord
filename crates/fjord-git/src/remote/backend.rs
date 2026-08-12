use std::ffi::OsString;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use fjord_domain::RemoteRef;
use fjord_ports::{GitOperationContext, GitRemoteBackend, GitRemoteError, RepoPath};

use super::environment::remote_process_environment;
use super::errors::classify_failure;
use super::executable::{GitExecutableError, GitExecutableResolver};
use super::process_runner::{
    GitCommandResult, GitCommandSpec, GitProcessEvent, GitProcessEventHandler, GitProcessRunner,
    OutputCapture,
};
use super::progress::{parse_progress, ProgressThrottle};
use crate::locking;
use crate::{generation::MutationKind, local::bump_repository_mutation};

const REMOTE_OPERATION_TIMEOUT: Duration = Duration::from_secs(30 * 60);
/// Transfer commands report through stderr; their stdout only ever holds a
/// short summary, so a tail is enough to diagnose a failure.
const TRANSFER_STDOUT_TAIL: usize = 16 * 1024;
/// `ls-remote` output is parsed, so it is kept whole up to a hard ceiling that
/// still covers repositories with hundreds of thousands of refs.
const LS_REMOTE_STDOUT_LIMIT: usize = 64 * 1024 * 1024;

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
        stdout_capture: OutputCapture,
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
            stdout_capture,
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

fn force_push_arguments(
    remote: &str,
    source_oid: &str,
    remote_ref: &str,
    expected_oid: &str,
) -> Vec<OsString> {
    vec![
        "push".into(),
        "--progress".into(),
        format!("--force-with-lease={remote_ref}:{expected_oid}").into(),
        remote.into(),
        format!("{source_oid}:{remote_ref}").into(),
    ]
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
        // `--progress` is required: Git only reports transfer progress on its
        // own when stderr is a terminal, and the runner always pipes it.
        let mut args = vec![
            "fetch".into(),
            "--progress".into(),
            "--prune".into(),
            remote.into(),
        ];
        args.extend(refspecs.iter().map(OsString::from));
        self.run(
            repo,
            args,
            OutputCapture::Tail(TRANSFER_STDOUT_TAIL),
            context,
        )
        .await?;
        bump_repository_mutation(repo, MutationKind::Fetch);
        Ok(())
    }

    async fn push(
        &self,
        repo: &RepoPath,
        remote: &str,
        refspecs: &[String],
        context: GitOperationContext,
    ) -> Result<(), GitRemoteError> {
        let _guard = locking::write(repo).await;
        let mut args = vec!["push".into(), "--progress".into(), remote.into()];
        args.extend(refspecs.iter().map(OsString::from));
        self.run(
            repo,
            args,
            OutputCapture::Tail(TRANSFER_STDOUT_TAIL),
            context,
        )
        .await?;
        bump_repository_mutation(repo, MutationKind::Push);
        Ok(())
    }

    async fn force_push_with_lease(
        &self,
        repo: &RepoPath,
        remote: &str,
        source_oid: &str,
        remote_ref: &str,
        expected_oid: &str,
        context: GitOperationContext,
    ) -> Result<(), GitRemoteError> {
        let _guard = locking::write(repo).await;
        self.run(
            repo,
            force_push_arguments(remote, source_oid, remote_ref, expected_oid),
            OutputCapture::Tail(TRANSFER_STDOUT_TAIL),
            context,
        )
        .await?;
        bump_repository_mutation(repo, MutationKind::Push);
        Ok(())
    }

    async fn publish_branch(
        &self,
        repo: &RepoPath,
        remote: &str,
        branch_ref: &str,
        context: GitOperationContext,
    ) -> Result<(), GitRemoteError> {
        let _guard = locking::write(repo).await;
        self.run(
            repo,
            vec![
                "push".into(),
                "--progress".into(),
                "--set-upstream".into(),
                remote.into(),
                format!("{branch_ref}:{branch_ref}").into(),
            ],
            OutputCapture::Tail(TRANSFER_STDOUT_TAIL),
            context,
        )
        .await?;
        bump_repository_mutation(repo, MutationKind::PublishBranch);
        Ok(())
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
            OutputCapture::Tail(TRANSFER_STDOUT_TAIL),
            context,
        )
        .await?;
        bump_repository_mutation(repo, MutationKind::DeleteRemoteBranch);
        Ok(())
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
                OutputCapture::Full {
                    max_bytes: LS_REMOTE_STDOUT_LIMIT,
                },
                context,
            )
            .await?;
        Ok(parse_ls_remote(&result.stdout))
    }
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
    use crate::LocalGitBackend;
    use fjord_ports::{GitBackend, GitProgress};

    #[test]
    fn parses_symbolic_and_direct_remote_refs() {
        let refs =
            parse_ls_remote("ref: refs/heads/main\tHEAD\nabc123\tHEAD\nabc123\trefs/heads/main\n");
        assert_eq!(refs.len(), 2);
        assert_eq!(refs[0].name, "HEAD");
        assert_eq!(refs[0].symbolic_target.as_deref(), Some("refs/heads/main"));
    }

    #[test]
    fn force_push_constructs_only_an_explicit_lease() {
        let args = force_push_arguments("company", "local123", "refs/heads/trunk", "remote456");
        assert_eq!(
            args,
            vec![
                OsString::from("push"),
                OsString::from("--progress"),
                OsString::from("--force-with-lease=refs/heads/trunk:remote456"),
                OsString::from("company"),
                OsString::from("local123:refs/heads/trunk"),
            ]
        );
        let source = include_str!("backend.rs");
        assert!(
            !source.contains("\"--force\""),
            "bare force must never be constructed"
        );
    }

    /// Guards the assumption the progress parser depends on: Git only writes
    /// transfer progress to a piped stderr when `--progress` is passed, so this
    /// exercises the real backend rather than the parser in isolation.
    #[tokio::test]
    async fn fetch_and_push_emit_real_progress() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let remote = temp.path().join("remote.git");
        let clone = temp.path().join("clone");
        std::fs::create_dir(&source).unwrap();
        run_git(&source, &["init", "-b", "main"]);
        configure_identity(&source);
        write_many_files(&source, "initial", 40);
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

        write_many_files(&source, "second", 40);
        run_git(&source, &["add", "."]);
        run_git(&source, &["commit", "-m", "second"]);

        let (context, pushed) = recording_context();
        SystemGitRemoteBackend::new()
            .push(
                &RepoPath::new(source.clone()),
                "origin",
                &["refs/heads/main:refs/heads/main".into()],
                context,
            )
            .await
            .unwrap();
        assert!(
            !pushed.lock().unwrap().is_empty(),
            "push reported no progress"
        );

        let (context, fetched) = recording_context();
        SystemGitRemoteBackend::new()
            .fetch(&RepoPath::new(clone), "origin", &[], context)
            .await
            .unwrap();
        let fetched = fetched.lock().unwrap();
        assert!(!fetched.is_empty(), "fetch reported no progress");
        assert!(
            fetched.iter().any(|progress| progress.total > 0),
            "no progress carried a total: {fetched:?}"
        );
    }

    fn recording_context() -> (GitOperationContext, Arc<Mutex<Vec<GitProgress>>>) {
        let recorded = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&recorded);
        let context = GitOperationContext::new(
            move |progress| sink.lock().unwrap().push(progress),
            || false,
        );
        (context, recorded)
    }

    fn write_many_files(repo: &Path, content: &str, count: u32) {
        for index in 0..count {
            std::fs::write(
                repo.join(format!("file-{index}.txt")),
                format!("{content} {index}\n"),
            )
            .unwrap();
        }
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
    async fn explicit_force_lease_rejects_a_stale_remote_tip() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let remote = temp.path().join("remote.git");
        let peer = temp.path().join("peer");
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
        let stale_expected = git_output(&source, &["rev-parse", "origin/main"]);

        run_git(
            temp.path(),
            &[
                "clone",
                "-b",
                "main",
                remote.to_str().unwrap(),
                peer.to_str().unwrap(),
            ],
        );
        configure_identity(&peer);
        std::fs::write(peer.join("peer.txt"), "peer\n").unwrap();
        run_git(&peer, &["add", "."]);
        run_git(&peer, &["commit", "-m", "peer update"]);
        run_git(&peer, &["push", "origin", "HEAD:refs/heads/main"]);

        std::fs::write(source.join("local.txt"), "local\n").unwrap();
        run_git(&source, &["add", "."]);
        run_git(&source, &["commit", "-m", "local rewrite"]);
        let source_oid = git_output(&source, &["rev-parse", "HEAD"]);
        let error = SystemGitRemoteBackend::new()
            .force_push_with_lease(
                &RepoPath::new(source),
                "origin",
                &source_oid,
                "refs/heads/main",
                &stale_expected,
                GitOperationContext::default(),
            )
            .await
            .unwrap_err();

        assert_eq!(error.code(), "git_force_lease_failed");
        assert_eq!(
            git_output(&remote, &["rev-parse", "refs/heads/main"]),
            git_output(&peer, &["rev-parse", "HEAD"])
        );
    }

    #[tokio::test]
    async fn push_uses_the_newly_configured_upstream() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let remote = temp.path().join("remote.git");
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
        let initial = git_output(&source, &["rev-parse", "HEAD"]);
        run_git(&source, &["push", "origin", "main:refs/heads/release"]);
        run_git(
            &source,
            &[
                "fetch",
                "origin",
                "refs/heads/release:refs/remotes/origin/release",
            ],
        );

        let repo_path = RepoPath::new(source.clone());
        let local = LocalGitBackend::new();
        local
            .set_branch_upstream(&repo_path, "main", "origin/release")
            .await
            .unwrap();
        std::fs::write(source.join("release.txt"), "release\n").unwrap();
        run_git(&source, &["add", "."]);
        run_git(&source, &["commit", "-m", "release update"]);
        let expected = git_output(&source, &["rev-parse", "HEAD"]);
        let target = local.current_push_target(&repo_path).await.unwrap();

        SystemGitRemoteBackend::new()
            .push(
                &repo_path,
                &target.remote,
                &[target.refspec()],
                GitOperationContext::default(),
            )
            .await
            .unwrap();

        assert_eq!(
            git_output(&remote, &["rev-parse", "refs/heads/release"]),
            expected
        );
        assert_eq!(
            git_output(&remote, &["rev-parse", "refs/heads/main"]),
            initial
        );
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
        let local_backend = LocalGitBackend::new();
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
