//! Git-native synchronization for Phase 8 patch mutations.
//!
//! Fjord's in-process repository lock cannot serialize another Git process.
//! The standard index lock can: ordinary index/worktree mutations refuse or
//! wait while it exists. Index-writing patch operations build their result in
//! that lock file through `GIT_INDEX_FILE`, then atomically publish it. Unstage
//! additionally prepares a verify-only `git update-ref` transaction for HEAD,
//! which holds both HEAD and its symbolic target ref stable until the index is
//! committed. Discard only holds the index lock while Git contextually updates
//! the worktree.

use super::*;
use git2::Oid;
use sha2::{Digest, Sha256};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout};

const FINGERPRINT_BUFFER_BYTES: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum IndexFingerprint {
    Missing,
    Present([u8; 32]),
}

/// Opaque snapshot of the complete real index. Callers that construct a
/// mutation speculatively can bind the later `index.lock` acquisition to the
/// exact bytes they observed before doing any user-state mutation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct IndexSnapshot(IndexFingerprint);

impl IndexSnapshot {
    pub(super) fn capture(repo: &RepoPath) -> Result<Self, GitError> {
        Ok(Self(fingerprint(&resolved_index_path(repo)?)?))
    }

    pub(super) fn is_missing(self) -> bool {
        self.0 == IndexFingerprint::Missing
    }
}

/// Holds Git's real index lock without changing the index. Used by discard so
/// `git add`, commit, reset, checkout, and other standard Git writers cannot
/// change the patch base after validation.
pub(super) struct IndexLock {
    index_path: PathBuf,
    original: IndexFingerprint,
    _marker: gix_lock::Marker,
}

impl IndexLock {
    pub(super) fn acquire(repo: &RepoPath) -> Result<Self, GitError> {
        let index_path = resolved_index_path(repo)?;
        let marker = gix_lock::Marker::acquire_to_hold_resource(
            &index_path,
            gix_lock::acquire::Fail::Immediately,
            None,
        )
        .map_err(map_lock_error)?;
        let original = fingerprint(&index_path)?;
        Ok(Self {
            index_path,
            original,
            _marker: marker,
        })
    }

    pub(super) fn verify_unchanged(&self) -> Result<(), GitError> {
        if fingerprint(&self.index_path)? == self.original {
            Ok(())
        } else {
            Err(GitError::PatchStale)
        }
    }
}

/// An index update prepared under the real `index.lock`. The lock file itself
/// is used as an alternate index, so Git still owns patch parsing and index
/// serialization. Committing uses the lock library's cross-platform atomic
/// replacement instead of a hand-written rename.
pub(super) struct IndexTransaction {
    index_path: PathBuf,
    original: IndexFingerprint,
    marker: Option<gix_lock::Marker>,
}

impl IndexTransaction {
    pub(super) fn begin(commands: &GitCommandFactory, repo: &RepoPath) -> Result<Self, GitError> {
        let index_path = resolved_index_path(repo)?;
        let mut lock = gix_lock::File::acquire_to_update_resource(
            &index_path,
            gix_lock::acquire::Fail::Immediately,
            None,
        )
        .map_err(map_lock_error)?;
        let original = copy_and_fingerprint(&index_path, &mut lock)?;
        let marker = lock.close().map_err(|_| patch_transaction_failed())?;

        if original == IndexFingerprint::Missing {
            initialize_empty_index(commands, repo, marker.lock_path())?;
        }

        Ok(Self {
            index_path,
            original,
            marker: Some(marker),
        })
    }

    pub(super) fn begin_expected(
        commands: &GitCommandFactory,
        repo: &RepoPath,
        expected: IndexSnapshot,
    ) -> Result<Self, GitError> {
        let transaction = Self::begin(commands, repo)?;
        if transaction.original == expected.0 {
            Ok(transaction)
        } else {
            Err(GitError::PatchStale)
        }
    }

    pub(super) fn alternate_index_path(&self) -> &Path {
        self.marker
            .as_ref()
            .expect("an uncommitted transaction owns its marker")
            .lock_path()
    }

    pub(super) fn verify_original_unchanged(&self) -> Result<(), GitError> {
        if fingerprint(&self.index_path)? == self.original {
            Ok(())
        } else {
            Err(GitError::PatchStale)
        }
    }

    /// Atomically replaces the real index from `source` while retaining the
    /// standard `index.lock`. This lets a caller coordinate another Git-owned
    /// resource before releasing external index writers.
    pub(super) fn replace_real_while_locked(&self, source: &Path) -> Result<(), GitError> {
        let parent = self
            .index_path
            .parent()
            .ok_or_else(patch_transaction_failed)?;
        let mut temporary = gix_tempfile::new(
            parent,
            gix_tempfile::ContainingDirectory::Exists,
            gix_tempfile::AutoRemove::Tempfile,
        )
        .map_err(|_| patch_transaction_failed())?;
        let mut source = std::fs::File::open(source).map_err(|_| patch_transaction_failed())?;
        std::io::copy(&mut source, &mut temporary).map_err(|_| patch_transaction_failed())?;
        temporary
            .persist(&self.index_path)
            .map_err(|_| patch_transaction_failed())?;
        Ok(())
    }

    pub(super) fn remove_real_while_locked(&self) -> Result<(), GitError> {
        match std::fs::remove_file(&self.index_path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(patch_transaction_failed()),
        }
    }

    pub(super) fn commit(mut self) -> Result<(), GitError> {
        let marker = self
            .marker
            .take()
            .expect("an uncommitted transaction owns its marker");
        marker.commit().map_err(|_| patch_transaction_failed())?;
        Ok(())
    }
}

/// A prepared verify-only ref transaction. `git update-ref` resolves the
/// repository's active ref backend and, for symbolic HEAD, locks both HEAD and
/// its target. Aborting releases those locks without changing a ref.
pub(super) struct HeadLock {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
}

impl HeadLock {
    pub(super) fn acquire(commands: &GitCommandFactory, repo: &RepoPath) -> Result<Self, GitError> {
        let expected = LocalGitBackend::with_runtime_git2(repo, |git| {
            Ok(LocalGitBackend::current_head_commit(git)?.map(|commit| commit.id()))
        })?;
        Self::acquire_expected(commands, repo, expected)
    }

    pub(super) fn acquire_expected(
        commands: &GitCommandFactory,
        repo: &RepoPath,
        expected: Option<Oid>,
    ) -> Result<Self, GitError> {
        let mut command = commands.command()?;
        command
            .args(["update-ref", "--stdin"])
            .current_dir(&repo.0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = command.spawn().map_err(|_| patch_transaction_failed())?;
        let mut stdin = child.stdin.take().ok_or_else(patch_transaction_failed)?;
        let stdout = child.stdout.take().ok_or_else(patch_transaction_failed)?;

        stdin
            .write_all(b"start\nverify HEAD")
            .and_then(|()| {
                if let Some(expected) = expected {
                    write!(stdin, " {expected}")?;
                }
                stdin.write_all(b"\nprepare\n")
            })
            .and_then(|()| stdin.flush())
            .map_err(|_| patch_transaction_failed())?;

        let mut lock = Self {
            child,
            stdin: Some(stdin),
            stdout: BufReader::new(stdout),
        };
        lock.expect_response("start: ok")?;
        lock.expect_response("prepare: ok")?;
        Ok(lock)
    }

    fn expect_response(&mut self, expected: &str) -> Result<(), GitError> {
        let mut response = String::new();
        let count = self
            .stdout
            .read_line(&mut response)
            .map_err(|_| patch_transaction_failed())?;
        if count > 0 && response.trim_end() == expected {
            Ok(())
        } else {
            Err(GitError::PatchStale)
        }
    }
}

impl Drop for HeadLock {
    fn drop(&mut self) {
        if let Some(mut stdin) = self.stdin.take() {
            let _ = stdin.write_all(b"abort\n");
            let _ = stdin.flush();
            drop(stdin);
        }
        let mut response = String::new();
        let _ = self.stdout.read_line(&mut response);
        if self.child.wait().is_err() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

fn resolved_index_path(repo: &RepoPath) -> Result<PathBuf, GitError> {
    LocalGitBackend::with_runtime_git2(repo, |git| {
        let index = git.index().map_err(LocalGitBackend::map_git2_error)?;
        index.path().map(Path::to_path_buf).ok_or_else(|| {
            GitError::PatchApplyFailed("Git did not expose the repository index path".to_string())
        })
    })
}

fn initialize_empty_index(
    commands: &GitCommandFactory,
    repo: &RepoPath,
    alternate_index: &Path,
) -> Result<(), GitError> {
    let status = commands
        .command()?
        .args(["read-tree", "--empty"])
        .env("GIT_INDEX_FILE", alternate_index)
        .current_dir(&repo.0)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|_| patch_transaction_failed())?;
    if status.success() {
        Ok(())
    } else {
        Err(patch_transaction_failed())
    }
}

fn copy_and_fingerprint(
    index_path: &Path,
    destination: &mut gix_lock::File,
) -> Result<IndexFingerprint, GitError> {
    let mut source = match std::fs::File::open(index_path) {
        Ok(source) => source,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(IndexFingerprint::Missing);
        }
        Err(_) => return Err(patch_transaction_failed()),
    };
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; FINGERPRINT_BUFFER_BYTES];
    loop {
        let count = source
            .read(&mut buffer)
            .map_err(|_| patch_transaction_failed())?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
        destination
            .write_all(&buffer[..count])
            .map_err(|_| patch_transaction_failed())?;
    }
    Ok(IndexFingerprint::Present(digest.finalize().into()))
}

fn fingerprint(index_path: &Path) -> Result<IndexFingerprint, GitError> {
    let mut source = match std::fs::File::open(index_path) {
        Ok(source) => source,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(IndexFingerprint::Missing);
        }
        Err(_) => return Err(patch_transaction_failed()),
    };
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; FINGERPRINT_BUFFER_BYTES];
    loop {
        let count = source
            .read(&mut buffer)
            .map_err(|_| patch_transaction_failed())?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(IndexFingerprint::Present(digest.finalize().into()))
}

fn map_lock_error(error: gix_lock::acquire::Error) -> GitError {
    match error {
        gix_lock::acquire::Error::PermanentlyLocked { .. } => GitError::PatchStale,
        gix_lock::acquire::Error::Io(_) => patch_transaction_failed(),
    }
}

fn patch_transaction_failed() -> GitError {
    GitError::PatchApplyFailed("Git patch transaction could not be completed".to_string())
}

#[cfg(test)]
pub(super) use test_hooks::{install as install_mutation_pause, pause as pause_before_mutation};

#[cfg(not(test))]
pub(super) fn pause_before_mutation(_repo: &RepoPath) {}

#[cfg(test)]
mod test_hooks {
    use super::*;
    use std::collections::HashMap;
    use std::sync::{mpsc, Mutex, OnceLock};
    use tokio::sync::oneshot;

    struct Hook {
        reached: oneshot::Sender<()>,
        resume: mpsc::Receiver<()>,
    }

    fn hooks() -> &'static Mutex<HashMap<PathBuf, Hook>> {
        static HOOKS: OnceLock<Mutex<HashMap<PathBuf, Hook>>> = OnceLock::new();
        HOOKS.get_or_init(|| Mutex::new(HashMap::new()))
    }

    pub(crate) struct MutationPause {
        reached: oneshot::Receiver<()>,
        resume: Option<mpsc::SyncSender<()>>,
    }

    impl MutationPause {
        pub(crate) async fn wait_until_reached(&mut self) {
            (&mut self.reached)
                .await
                .expect("mutation should reach the installed test hook");
        }

        pub(crate) fn resume(mut self) {
            if let Some(resume) = self.resume.take() {
                let _ = resume.send(());
            }
        }
    }

    impl Drop for MutationPause {
        fn drop(&mut self) {
            if let Some(resume) = self.resume.take() {
                let _ = resume.send(());
            }
        }
    }

    pub(crate) fn install(repo: &RepoPath) -> MutationPause {
        let key = std::fs::canonicalize(&repo.0).unwrap_or_else(|_| repo.0.clone());
        let (reached_tx, reached_rx) = oneshot::channel();
        let (resume_tx, resume_rx) = mpsc::sync_channel(0);
        let previous = hooks().lock().unwrap().insert(
            key,
            Hook {
                reached: reached_tx,
                resume: resume_rx,
            },
        );
        assert!(
            previous.is_none(),
            "only one mutation hook may exist per repository"
        );
        MutationPause {
            reached: reached_rx,
            resume: Some(resume_tx),
        }
    }

    pub(crate) fn pause(repo: &RepoPath) {
        let key = std::fs::canonicalize(&repo.0).unwrap_or_else(|_| repo.0.clone());
        let hook = hooks().lock().unwrap().remove(&key);
        if let Some(hook) = hook {
            let _ = hook.reached.send(());
            hook.resume
                .recv()
                .expect("test should resume the paused mutation");
        }
    }
}
