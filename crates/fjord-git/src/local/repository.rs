//! Repository handles, locking, and the shared error/command plumbing every
//! other local module builds on.

use super::*;
impl LocalGitBackend {
    pub(super) fn open(repo: &RepoPath) -> Result<gix::Repository, GitError> {
        gix::open(&repo.0).map_err(|e| match e {
            gix::open::Error::NotARepository { .. } => GitError::NotAGitRepository(repo.0.clone()),
            other => GitError::Gix(other.to_string()),
        })
    }

    pub(super) fn open_git2(repo: &RepoPath) -> Result<git2::Repository, GitError> {
        git2::Repository::open(&repo.0).map_err(Self::map_git2_error)
    }

    /// Shared guard for operations that only read. Concurrent readers
    /// overlap; a writer still excludes them.
    ///
    /// This was an exclusive mutex taken by *every* method, reads included,
    /// which quietly serialized repository opening: the UI fires status,
    /// branches, tags, log and working-changes together, so their wall-clock
    /// cost was the sum rather than the slowest one. On a repo with 826
    /// refs and 922 tags that measured 861 ms concurrent against a 518 ms
    /// slowest read (`cargo run -p fjord-bench -- --repo <path>
    /// --profile-open`).
    pub(super) async fn acquire_repo_read_lock(
        repo: &RepoPath,
    ) -> tokio::sync::OwnedRwLockReadGuard<()> {
        locking::read(repo).await
    }

    /// Exclusive guard for operations that mutate the repository — checkout,
    /// staging, commit, integration, stash. Two of these interleaving
    /// (or running while a read observes a half-applied state) is what the
    /// lock exists to prevent.
    pub(super) async fn acquire_repo_write_lock(
        repo: &RepoPath,
    ) -> tokio::sync::OwnedRwLockWriteGuard<()> {
        locking::write(repo).await
    }

    pub(super) fn map_git2_error(err: git2::Error) -> GitError {
        match err.code() {
            ErrorCode::Auth => GitError::AuthenticationFailed,
            ErrorCode::Conflict | ErrorCode::MergeConflict | ErrorCode::Unmerged => {
                GitError::Conflict { paths: vec![] }
            }
            _ => GitError::Git2(err.message().to_string()),
        }
    }

    /// Runs a local-only Git mutation that does not use transport. Network
    /// commands must go through `GitRemoteBackend` and its async runner.
    pub(super) fn run_local_git(
        commands: &GitCommandFactory,
        repo: &RepoPath,
        args: &[&str],
    ) -> Result<(), GitError> {
        let status = commands
            .command()
            .args(args)
            .current_dir(&repo.0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|err| {
                GitError::Git2(format!("failed to run git {}: {err}", args.join(" ")))
            })?;

        if status.success() {
            return Ok(());
        }
        Err(GitError::Git2(format!(
            "local git {} failed with exit code {:?}",
            args.join(" "),
            status.code()
        )))
    }

    pub(super) fn current_branch_refname(git: &git2::Repository) -> Result<String, GitError> {
        let head = git.head().map_err(Self::map_git2_error)?;
        let head_refname = head.name().map_err(Self::map_git2_error)?.to_string();

        if !head_refname.starts_with("refs/heads/") {
            return Err(GitError::NoUpstream);
        }

        Ok(head_refname)
    }

    pub(super) fn current_head_commit(
        git: &git2::Repository,
    ) -> Result<Option<git2::Commit<'_>>, GitError> {
        match git.head() {
            Ok(head) => Ok(Some(head.peel_to_commit().map_err(Self::map_git2_error)?)),
            Err(err) if matches!(err.code(), ErrorCode::UnbornBranch | ErrorCode::NotFound) => {
                Ok(None)
            }
            Err(err) => Err(Self::map_git2_error(err)),
        }
    }

    /// An owned signature. `Repository::signature` borrows the repo, which
    /// deadlocks the borrow checker against the `&mut Repository` the stash
    /// APIs require — so read the identity out and rebuild it detached.
    pub(super) fn owned_signature(
        git: &git2::Repository,
    ) -> Result<git2::Signature<'static>, GitError> {
        let (name, email) = {
            let signature = git.signature().map_err(Self::map_git2_error)?;
            (
                signature.name().unwrap_or("Fjord").to_string(),
                signature.email().unwrap_or("").to_string(),
            )
        };
        git2::Signature::now(&name, &email).map_err(Self::map_git2_error)
    }
}
