//! Repository-derived stash reads and unified exact-scope creation.

use std::collections::BTreeSet;
use std::ffi::OsString;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use fjord_domain::{CommitId, CreateStashRequest, StashEntry, StashId, StashScope};
use fjord_ports::{GitError, RepoPath};
use git2::{ErrorCode, ObjectType, Oid, Repository, Tree};
use time::OffsetDateTime;
use uuid::Uuid;

use super::LocalGitBackend;
use crate::executable::GitCommandFactory;

const STASH_REF: &str = "refs/stash";
/// `git restore` is used to reset only the selected tracked paths after the
/// exact stash object has been built. It was introduced in Git 2.23.
const MINIMUM_PATHS_VERSION: (u32, u32) = (2, 23);

struct TemporaryIndex {
    path: PathBuf,
}

impl TemporaryIndex {
    fn new(directory: &Path) -> Self {
        Self {
            path: directory.join(format!(
                "fjord-stash-{}-{}.index",
                std::process::id(),
                Uuid::new_v4()
            )),
        }
    }
}

impl Drop for TemporaryIndex {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
        let mut lock = self.path.as_os_str().to_os_string();
        lock.push(".lock");
        let _ = std::fs::remove_file(PathBuf::from(lock));
    }
}

pub(super) async fn paths_supported(commands: &GitCommandFactory) -> Result<bool, GitError> {
    let commands = commands.clone();
    tokio::task::spawn_blocking(move || {
        let output = commands
            .command()?
            .arg("--version")
            .output()
            .map_err(io_error)?;
        Ok(output.status.success()
            && meets_minimum_version(&String::from_utf8_lossy(&output.stdout)))
    })
    .await
    .map_err(join_error)?
}

pub(super) async fn create(
    commands: &GitCommandFactory,
    repo: &RepoPath,
    request: &CreateStashRequest,
) -> Result<StashEntry, GitError> {
    let commands = commands.clone();
    let repo = repo.clone();
    let request = request.clone();
    let _repo_guard = LocalGitBackend::acquire_repo_write_lock(&repo).await;
    tokio::task::spawn_blocking(move || create_locked(&commands, &repo, &request))
        .await
        .map_err(join_error)?
}

fn create_locked(
    commands: &GitCommandFactory,
    repo: &RepoPath,
    request: &CreateStashRequest,
) -> Result<StashEntry, GitError> {
    if request.message.trim().is_empty() {
        return Err(GitError::Git2(
            "stash message must not be empty".to_string(),
        ));
    }
    if matches!(&request.scope, StashScope::Paths { paths } if paths.is_empty()) {
        return Err(GitError::StashScopeEmpty);
    }
    reject_conflicts(repo, &request.scope)?;

    let oid = match &request.scope {
        StashScope::All => create_all(commands, repo, request)?,
        StashScope::Paths { paths } => create_paths(commands, repo, request, paths)?,
    };

    LocalGitBackend::with_runtime_git2(repo, |git| {
        read_stashes(git)?
            .into_iter()
            .find(|entry| entry.id.0 == oid)
            .ok_or_else(|| malformed("created stash is missing from refs/stash"))
    })
}

fn reject_conflicts(repo: &RepoPath, scope: &StashScope) -> Result<(), GitError> {
    LocalGitBackend::with_runtime_git2(repo, |git| {
        let index = LocalGitBackend::fresh_index(git)?;
        let conflicts = LocalGitBackend::conflict_paths(&index);
        let offending = match scope {
            StashScope::All => conflicts.into_iter().next(),
            StashScope::Paths { paths } => {
                let selected = paths.iter().collect::<BTreeSet<_>>();
                conflicts.into_iter().find(|path| selected.contains(path))
            }
        };
        match offending {
            Some(path) => Err(GitError::StashFileConflicted { path }),
            None => Ok(()),
        }
    })
}

fn create_all(
    commands: &GitCommandFactory,
    repo: &RepoPath,
    request: &CreateStashRequest,
) -> Result<String, GitError> {
    let before = ref_oid(commands, repo, STASH_REF)?;
    let mut args = vec![OsString::from("stash"), OsString::from("push")];
    if request.include_untracked {
        args.push(OsString::from("-u"));
    }
    args.extend([OsString::from("-m"), OsString::from(request.message.trim())]);
    run(commands, repo, &args, None, None)?;
    let after = ref_oid(commands, repo, STASH_REF)?;
    if after.is_none() || after == before {
        return Err(GitError::NothingToStash);
    }
    Ok(after.expect("new stash ref checked above"))
}

fn create_paths(
    commands: &GitCommandFactory,
    repo: &RepoPath,
    request: &CreateStashRequest,
    paths: &[String],
) -> Result<String, GitError> {
    if paths.is_empty() {
        return Err(GitError::StashScopeEmpty);
    }
    if !resolved_git_supports_paths(commands)? {
        return Err(GitError::StashFileUnsupportedGit);
    }

    let selected = paths.iter().cloned().collect::<BTreeSet<_>>();
    let pathspecs = literal_pathspecs(selected.iter().map(String::as_str));
    let head = text_output(commands, repo, &["rev-parse", "--verify", "HEAD"], None)?;
    let base_tree = text_output(
        commands,
        repo,
        &["rev-parse", "--verify", "HEAD^{tree}"],
        None,
    )?;
    let git_dir = LocalGitBackend::with_runtime_git2(repo, |git| Ok(git.path().to_path_buf()))?;

    let mut tracked = nul_list(
        &run_dynamic(
            commands,
            repo,
            ["ls-files", "--cached", "-z"],
            &pathspecs,
            None,
            None,
        )?
        .stdout,
    );
    tracked.extend(nul_list(
        &run_dynamic(
            commands,
            repo,
            ["ls-tree", "-r", "--name-only", "-z", "HEAD", "--"],
            &pathspecs,
            None,
            None,
        )?
        .stdout,
    ));
    tracked.sort();
    tracked.dedup();

    let mut untracked = if request.include_untracked {
        nul_list(
            &run_dynamic(
                commands,
                repo,
                ["ls-files", "--others", "--exclude-standard", "-z", "--"],
                &pathspecs,
                None,
                None,
            )?
            .stdout,
        )
    } else {
        Vec::new()
    };
    untracked.sort();
    untracked.dedup();
    if tracked
        .iter()
        .chain(&untracked)
        .any(|path| !selected.contains(path))
    {
        return Err(GitError::StashScopeUnrepresentable {
            path: selected.iter().next().cloned().unwrap_or_default(),
        });
    }

    let index_file = TemporaryIndex::new(&git_dir);
    run(
        commands,
        repo,
        &[OsString::from("read-tree"), OsString::from("HEAD")],
        Some(&index_file.path),
        None,
    )?;
    if !tracked.is_empty() {
        let input = tracked.join("\0") + "\0";
        run(
            commands,
            repo,
            &[
                OsString::from("update-index"),
                OsString::from("--force-remove"),
                OsString::from("-z"),
                OsString::from("--stdin"),
            ],
            Some(&index_file.path),
            Some(input.as_bytes()),
        )?;
    }
    let real_index_entries = run_dynamic(
        commands,
        repo,
        ["ls-files", "--stage", "-z", "--"],
        &pathspecs,
        None,
        None,
    )?
    .stdout;
    if !real_index_entries.is_empty() {
        run(
            commands,
            repo,
            &[
                OsString::from("update-index"),
                OsString::from("-z"),
                OsString::from("--index-info"),
            ],
            Some(&index_file.path),
            Some(&real_index_entries),
        )?;
    }
    let index_tree = text_output(commands, repo, &["write-tree"], Some(&index_file.path))?;

    let branch = branch_label(commands, repo)?;
    let short_head = head.chars().take(7).collect::<String>();
    let index_commit = commit_tree(
        commands,
        repo,
        &index_tree,
        &[head.as_str()],
        &format!("index on {branch}: {short_head} {}", request.message.trim()),
    )?;

    if !tracked.is_empty() {
        let tracked_specs = literal_pathspecs(tracked.iter().map(String::as_str));
        run_dynamic(
            commands,
            repo,
            ["add", "-A", "--"],
            &tracked_specs,
            Some(&index_file.path),
            None,
        )?;
    }
    let worktree_tree = text_output(commands, repo, &["write-tree"], Some(&index_file.path))?;

    let untracked_commit = if untracked.is_empty() {
        None
    } else {
        let untracked_index = TemporaryIndex::new(&git_dir);
        run(
            commands,
            repo,
            &[OsString::from("read-tree"), OsString::from("--empty")],
            Some(&untracked_index.path),
            None,
        )?;
        let untracked_specs = literal_pathspecs(untracked.iter().map(String::as_str));
        run_dynamic(
            commands,
            repo,
            ["add", "--"],
            &untracked_specs,
            Some(&untracked_index.path),
            None,
        )?;
        let tree = text_output(commands, repo, &["write-tree"], Some(&untracked_index.path))?;
        Some(commit_tree(
            commands,
            repo,
            &tree,
            &[],
            &format!(
                "untracked files on {branch}: {short_head} {}",
                request.message.trim()
            ),
        )?)
    };

    if index_tree == base_tree && worktree_tree == base_tree && untracked_commit.is_none() {
        return Err(GitError::NothingToStash);
    }

    let mut parents = vec![head.as_str(), index_commit.as_str()];
    if let Some(untracked) = untracked_commit.as_deref() {
        parents.push(untracked);
    }
    let stash_message = format!("On {branch}: {}", request.message.trim());
    let stash_oid = commit_tree(commands, repo, &worktree_tree, &parents, &stash_message)?;

    // Objects are complete before the first user-state mutation. Cleanup is
    // selected-path-only; on any later failure the exact object is applied
    // back with `--index` before returning.
    let cleanup: Result<(), GitError> = (|| {
        if !untracked.is_empty() {
            let specs = literal_pathspecs(untracked.iter().map(String::as_str));
            run_dynamic(commands, repo, ["clean", "-f", "--"], &specs, None, None)?;
        }
        if !tracked.is_empty() {
            let specs = literal_pathspecs(tracked.iter().map(String::as_str));
            run_dynamic(
                commands,
                repo,
                ["restore", "--source=HEAD", "--staged", "--worktree", "--"],
                &specs,
                None,
                None,
            )?;
        }
        Ok(())
    })();
    if cleanup.is_err() {
        rollback_scope(commands, repo, &stash_oid)?;
        return Err(GitError::StashScopeUnrepresentable {
            path: selected.iter().next().cloned().unwrap_or_default(),
        });
    }

    let before = ref_oid(commands, repo, STASH_REF)?;
    let stored = run(
        commands,
        repo,
        &[
            OsString::from("stash"),
            OsString::from("store"),
            OsString::from("-m"),
            OsString::from(&stash_message),
            OsString::from(&stash_oid),
        ],
        None,
        None,
    );
    let after = ref_oid(commands, repo, STASH_REF)?;
    if stored.is_err() || after.as_deref() != Some(stash_oid.as_str()) || after == before {
        if after.as_deref() == Some(stash_oid.as_str()) {
            restore_stash_ref(commands, repo, before.as_deref(), &stash_oid)?;
        }
        rollback_scope(commands, repo, &stash_oid)?;
        return stored.map(|_| ()).and(Err(GitError::Git2(
            "git did not publish the exact stash".to_string(),
        )));
    }

    Ok(stash_oid)
}

fn rollback_scope(
    commands: &GitCommandFactory,
    repo: &RepoPath,
    stash_oid: &str,
) -> Result<(), GitError> {
    run(
        commands,
        repo,
        &[
            OsString::from("stash"),
            OsString::from("apply"),
            OsString::from("--index"),
            OsString::from(stash_oid),
        ],
        None,
        None,
    )?;
    Ok(())
}

fn restore_stash_ref(
    commands: &GitCommandFactory,
    repo: &RepoPath,
    previous: Option<&str>,
    current: &str,
) -> Result<(), GitError> {
    let args = match previous {
        Some(previous) => vec![
            OsString::from("update-ref"),
            OsString::from(STASH_REF),
            OsString::from(previous),
            OsString::from(current),
        ],
        None => vec![
            OsString::from("update-ref"),
            OsString::from("-d"),
            OsString::from(STASH_REF),
            OsString::from(current),
        ],
    };
    run(commands, repo, &args, None, None)?;
    Ok(())
}

fn commit_tree(
    commands: &GitCommandFactory,
    repo: &RepoPath,
    tree: &str,
    parents: &[&str],
    message: &str,
) -> Result<String, GitError> {
    let mut args = vec![OsString::from("commit-tree"), OsString::from(tree)];
    for parent in parents {
        args.push(OsString::from("-p"));
        args.push(OsString::from(parent));
    }
    let mut input = message.as_bytes().to_vec();
    input.push(b'\n');
    let output = run(commands, repo, &args, None, Some(&input))?;
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn branch_label(commands: &GitCommandFactory, repo: &RepoPath) -> Result<String, GitError> {
    let output = command(
        commands,
        repo,
        &["symbolic-ref", "--short", "-q", "HEAD"],
        None,
    )?
    .output()
    .map_err(io_error)?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Ok("(no branch)".to_string())
    }
}

fn resolved_git_supports_paths(commands: &GitCommandFactory) -> Result<bool, GitError> {
    let output = commands
        .command()?
        .arg("--version")
        .output()
        .map_err(io_error)?;
    Ok(output.status.success() && meets_minimum_version(&String::from_utf8_lossy(&output.stdout)))
}

fn meets_minimum_version(version_output: &str) -> bool {
    let Some(version) = version_output.trim().strip_prefix("git version ") else {
        return false;
    };
    let mut parts = version.split('.');
    let major = parts.next().and_then(|part| part.parse::<u32>().ok());
    let minor = parts.next().and_then(|part| part.parse::<u32>().ok());
    matches!((major, minor), (Some(major), Some(minor)) if (major, minor) >= MINIMUM_PATHS_VERSION)
}

fn literal_pathspecs<'a>(paths: impl IntoIterator<Item = &'a str>) -> Vec<OsString> {
    paths
        .into_iter()
        .map(|path| OsString::from(format!(":(literal){path}")))
        .collect()
}

fn nul_list(output: &[u8]) -> Vec<String> {
    output
        .split(|byte| *byte == 0)
        .filter(|item| !item.is_empty())
        .map(|item| String::from_utf8_lossy(item).into_owned())
        .collect()
}

fn ref_oid(
    commands: &GitCommandFactory,
    repo: &RepoPath,
    reference: &str,
) -> Result<Option<String>, GitError> {
    let output = command(
        commands,
        repo,
        &["rev-parse", "--verify", "--quiet", reference],
        None,
    )?
    .output()
    .map_err(io_error)?;
    if output.status.success() {
        Ok(Some(
            String::from_utf8_lossy(&output.stdout).trim().to_string(),
        ))
    } else {
        Ok(None)
    }
}

fn text_output(
    commands: &GitCommandFactory,
    repo: &RepoPath,
    args: &[&str],
    index: Option<&Path>,
) -> Result<String, GitError> {
    let output = run(
        commands,
        repo,
        &args.iter().map(OsString::from).collect::<Vec<_>>(),
        index,
        None,
    )?;
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn run_dynamic<const N: usize>(
    commands: &GitCommandFactory,
    repo: &RepoPath,
    prefix: [&str; N],
    suffix: &[OsString],
    index: Option<&Path>,
    input: Option<&[u8]>,
) -> Result<Output, GitError> {
    let mut args = prefix.iter().map(OsString::from).collect::<Vec<_>>();
    args.extend_from_slice(suffix);
    run(commands, repo, &args, index, input)
}

fn command(
    commands: &GitCommandFactory,
    repo: &RepoPath,
    args: &[&str],
    index: Option<&Path>,
) -> Result<Command, GitError> {
    let mut command = commands.command()?;
    command.args(args).current_dir(&repo.0);
    if let Some(index) = index {
        command.env("GIT_INDEX_FILE", index);
    }
    Ok(command)
}

fn run(
    commands: &GitCommandFactory,
    repo: &RepoPath,
    args: &[OsString],
    index: Option<&Path>,
    input: Option<&[u8]>,
) -> Result<Output, GitError> {
    let mut command = commands.command()?;
    command.args(args).current_dir(&repo.0);
    if let Some(index) = index {
        command.env("GIT_INDEX_FILE", index);
    }
    if input.is_some() {
        command.stdin(Stdio::piped());
    }
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().map_err(io_error)?;
    if let Some(input) = input {
        child
            .stdin
            .take()
            .ok_or_else(|| GitError::Git2("Git stdin was unavailable".to_string()))?
            .write_all(input)
            .map_err(io_error)?;
    }
    let output = child.wait_with_output().map_err(io_error)?;
    if output.status.success() {
        Ok(output)
    } else {
        Err(GitError::Git2(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ))
    }
}

fn io_error(error: std::io::Error) -> GitError {
    GitError::Git2(error.to_string())
}

fn join_error(error: tokio::task::JoinError) -> GitError {
    GitError::Git2(error.to_string())
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(dead_code)] // Introduced for P10-STASH-06 mutations; exercised directly in P10-STASH-01 tests.
pub(super) struct ResolvedStash {
    pub id: StashId,
    pub index: u32,
    pub ref_name: String,
}

pub(super) async fn stashes(repo: &RepoPath) -> Result<Vec<StashEntry>, GitError> {
    let repo = repo.clone();
    let _repo_guard = LocalGitBackend::acquire_repo_read_lock(&repo).await;
    tokio::task::spawn_blocking(move || {
        super::runtime::registry()
            .resolve(&repo)?
            .stashes(read_stashes)
    })
    .await
    .map_err(|error| GitError::Git2(error.to_string()))?
}

fn read_stashes(git: &mut Repository) -> Result<Vec<StashEntry>, GitError> {
    let Some(reflog) = stash_reflog(git)? else {
        return Ok(Vec::new());
    };
    let mut entries = Vec::with_capacity(reflog.len());
    for index in 0..reflog.len() {
        let reflog_entry = reflog
            .get(index)
            .ok_or_else(|| malformed(format!("refs/stash reflog entry {index} is missing")))?;
        let message = reflog_entry
            .message()
            .map_err(LocalGitBackend::map_git2_error)?
            .ok_or_else(|| malformed(format!("refs/stash reflog entry {index} has no message")))?
            .to_string();
        entries.push(build_entry(git, index, reflog_entry.id_new(), message)?);
    }
    Ok(entries)
}

fn build_entry(
    git: &Repository,
    index: usize,
    oid: Oid,
    message: String,
) -> Result<StashEntry, GitError> {
    let commit = git
        .find_commit(oid)
        .map_err(LocalGitBackend::map_git2_error)?;
    if !(2..=3).contains(&commit.parent_count()) {
        return Err(malformed(format!(
            "stash commit {oid} has {} parents; expected two or three",
            commit.parent_count()
        )));
    }

    let base = commit.parent(0).map_err(LocalGitBackend::map_git2_error)?;
    let index_parent = commit.parent(1).map_err(LocalGitBackend::map_git2_error)?;
    let base_tree = base.tree().map_err(LocalGitBackend::map_git2_error)?;
    let stash_tree = commit.tree().map_err(LocalGitBackend::map_git2_error)?;
    let tracked_files = git
        .diff_tree_to_tree(Some(&base_tree), Some(&stash_tree), None)
        .map_err(LocalGitBackend::map_git2_error)?
        .deltas()
        .len();

    let untracked_files = if commit.parent_count() == 3 {
        let untracked_parent = commit.parent(2).map_err(LocalGitBackend::map_git2_error)?;
        let untracked_tree = untracked_parent
            .tree()
            .map_err(LocalGitBackend::map_git2_error)?;
        count_tree_files(git, &untracked_tree)?
    } else {
        0
    };
    let total_files = tracked_files.checked_add(untracked_files).ok_or_else(|| {
        malformed(format!(
            "stash commit {oid} contains too many changed paths"
        ))
    })?;
    let files_changed = u32::try_from(total_files).map_err(|_| {
        malformed(format!(
            "stash commit {oid} contains too many changed paths"
        ))
    })?;
    let index = u32::try_from(index)
        .map_err(|_| malformed("refs/stash contains more entries than supported"))?;
    let created_at = OffsetDateTime::from_unix_timestamp(commit.committer().when().seconds())
        .map_err(|_| malformed(format!("stash commit {oid} has an invalid committer time")))?;
    let (title, branch) = parse_message(&message);

    Ok(StashEntry {
        id: StashId(oid.to_string()),
        index,
        ref_name: stash_ref_name(index),
        message,
        title,
        base: CommitId(base.id().to_string()),
        branch,
        created_at,
        files_changed,
        has_index_state: index_parent.tree_id() != base.tree_id(),
        has_untracked: untracked_files > 0,
    })
}

/// Re-enumerates the current stack. Future mutation code must call this while
/// holding the repository write lock, immediately before invoking Git.
#[allow(dead_code)] // Deliberately has no production mutation caller until P10-STASH-06.
pub(super) fn resolve_stash(git: &Repository, id: &StashId) -> Result<ResolvedStash, GitError> {
    let Some(reflog) = stash_reflog(git)? else {
        return Err(GitError::StashNotFound);
    };
    let requested = Oid::from_str(&id.0).map_err(|_| GitError::StashNotFound)?;
    let mut matched_index = None;
    for index in 0..reflog.len() {
        let entry = reflog
            .get(index)
            .ok_or_else(|| malformed(format!("refs/stash reflog entry {index} is missing")))?;
        if entry.id_new() != requested {
            continue;
        }
        if matched_index.is_some() {
            return Err(GitError::StashAmbiguous);
        }
        matched_index = Some(index);
    }

    let index = u32::try_from(matched_index.ok_or(GitError::StashNotFound)?)
        .map_err(|_| malformed("refs/stash contains more entries than supported"))?;
    Ok(ResolvedStash {
        id: id.clone(),
        index,
        ref_name: stash_ref_name(index),
    })
}

fn stash_reflog(git: &Repository) -> Result<Option<git2::Reflog>, GitError> {
    match git.find_reference(STASH_REF) {
        Ok(_) => {}
        Err(error) if error.code() == ErrorCode::NotFound => return Ok(None),
        Err(error) => return Err(LocalGitBackend::map_git2_error(error)),
    }
    git.reflog(STASH_REF)
        .map(Some)
        .map_err(LocalGitBackend::map_git2_error)
}

fn count_tree_files(git: &Repository, tree: &Tree<'_>) -> Result<usize, GitError> {
    let mut count = 0usize;
    for entry in tree {
        match entry.kind() {
            Some(ObjectType::Tree) => {
                let child = git
                    .find_tree(entry.id())
                    .map_err(LocalGitBackend::map_git2_error)?;
                count = count
                    .checked_add(count_tree_files(git, &child)?)
                    .ok_or_else(|| malformed("stash untracked tree contains too many paths"))?;
            }
            Some(_) => {
                count = count
                    .checked_add(1)
                    .ok_or_else(|| malformed("stash untracked tree contains too many paths"))?;
            }
            None => {
                return Err(malformed(format!(
                    "stash tree entry {} has an unsupported file mode",
                    entry.id()
                )));
            }
        }
    }
    Ok(count)
}

fn stash_ref_name(index: u32) -> String {
    format!("stash@{{{index}}}")
}

fn parse_message(message: &str) -> (String, Option<String>) {
    for prefix in ["On ", "WIP on "] {
        let Some(remainder) = message.strip_prefix(prefix) else {
            continue;
        };
        let Some((branch, title)) = remainder.split_once(": ") else {
            continue;
        };
        if branch.is_empty() {
            continue;
        }
        return (
            title.to_string(),
            (branch != "(no branch)").then(|| branch.to_string()),
        );
    }
    (message.to_string(), None)
}

fn malformed(message: impl Into<String>) -> GitError {
    GitError::Git2(message.into())
}

#[cfg(test)]
mod tests {
    use super::{meets_minimum_version, parse_message};

    #[test]
    fn scoped_stash_version_floor_is_git_2_23() {
        assert!(!meets_minimum_version("git version 2.22.5"));
        assert!(meets_minimum_version("git version 2.23.0"));
        assert!(meets_minimum_version("git version 2.50.1.windows.1"));
        assert!(meets_minimum_version("git version 3.0.0"));
        assert!(!meets_minimum_version("not git"));
    }

    #[test]
    fn parses_only_gits_known_stash_message_shapes() {
        let cases = [
            (
                "On develop: Payment validation",
                "Payment validation",
                Some("develop"),
            ),
            (
                "WIP on develop: a123456 Add payments",
                "a123456 Add payments",
                Some("develop"),
            ),
            (
                "WIP on (no branch): a123456 Detached work",
                "a123456 Detached work",
                None,
            ),
            (
                "On feature/payments: keep slash",
                "keep slash",
                Some("feature/payments"),
            ),
            ("custom stash text", "custom stash text", None),
            ("On develop: ", "", Some("develop")),
            ("On : odd", "On : odd", None),
            (
                "WIP on develop:missing space",
                "WIP on develop:missing space",
                None,
            ),
        ];

        for (message, expected_title, expected_branch) in cases {
            let (title, branch) = parse_message(message);
            assert_eq!(title, expected_title, "message: {message}");
            assert_eq!(branch.as_deref(), expected_branch, "message: {message}");
        }
    }
}
