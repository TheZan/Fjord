//! In-app conflict resolution (`docs/specs/conflict-resolution.md`).
//!
//! The live index is the source of truth, never `RepoOperationState`: a
//! conflicted `merge --squash` or `stash apply` leaves the operation state
//! `Normal`, and resolution must work there too. The side labels are derived
//! from the operation markers Git wrote, so they are the way round Git
//! actually means — including the rebase inversion.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};

use fjord_domain::{
    CommitId, ConflictEntry, ConflictKind, ConflictResolution, ConflictSet, ConflictSide,
    ConflictSides, ConflictStage, StashId,
};

use super::*;

/// Entries returned per read; `total` stays exact beyond it.
pub(super) const CONFLICT_ENTRY_LIMIT: usize = 1000;
/// `MarkResolved` scans at most this many bytes of the worktree file.
pub(super) const MARKER_SCAN_LIMIT: u64 = 1024 * 1024;
/// Git's own binary heuristic looks for NUL in the first 8000 bytes.
const BINARY_SNIFF_LIMIT: usize = 8000;
const DIAGNOSTICS_LIMIT: usize = 4 * 1024;
const SQUASH_MSG_LIMIT: u64 = 64 * 1024;

/// One conflicted path with its raw stages, in index order.
pub(super) struct RawConflict {
    pub path: Vec<u8>,
    pub base: Option<git2::IndexEntry>,
    pub ours: Option<git2::IndexEntry>,
    pub theirs: Option<git2::IndexEntry>,
}

impl RawConflict {
    pub(super) fn path_lossy(&self) -> String {
        String::from_utf8_lossy(&self.path).into_owned()
    }
}

/// The single derivation both the banner summary (`conflict_paths`) and the
/// detail set use, ordered by byte path.
pub(super) fn raw_conflicts(index: &git2::Index) -> Vec<RawConflict> {
    let mut conflicts: Vec<RawConflict> = index
        .conflicts()
        .map(|conflicts| {
            conflicts
                .filter_map(Result::ok)
                .filter_map(|conflict| {
                    let path = conflict
                        .our
                        .as_ref()
                        .or(conflict.their.as_ref())
                        .or(conflict.ancestor.as_ref())?
                        .path
                        .clone();
                    Some(RawConflict {
                        path,
                        base: conflict.ancestor,
                        ours: conflict.our,
                        theirs: conflict.their,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    conflicts.sort_by(|left, right| left.path.cmp(&right.path));
    conflicts
}

/// A producer of an index-only conflict that left no operation marker, as
/// recorded by the Fjord command that produced it. Git-written markers always
/// take precedence; this only names the side for squash merge and stash apply.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum IndexOnlySource {
    SquashMerge { label: String },
    Stash { id: StashId },
}

fn index_only_sources() -> &'static Mutex<HashMap<PathBuf, IndexOnlySource>> {
    static SOURCES: OnceLock<Mutex<HashMap<PathBuf, IndexOnlySource>>> = OnceLock::new();
    SOURCES.get_or_init(Default::default)
}

fn repository_key(repo: &RepoPath) -> PathBuf {
    fjord_fs::canonicalize_path(&repo.0).unwrap_or_else(|_| repo.0.clone())
}

pub(super) fn record_index_only_source(repo: &RepoPath, source: IndexOnlySource) {
    index_only_sources()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(repository_key(repo), source);
}

fn recorded_index_only_source(repo: &RepoPath) -> Option<IndexOnlySource> {
    index_only_sources()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(&repository_key(repo))
        .cloned()
}

fn forget_index_only_source(repo: &RepoPath) {
    index_only_sources()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(&repository_key(repo));
}

pub(super) async fn get(repo: &RepoPath) -> Result<ConflictSet, GitError> {
    let repo = repo.clone();
    let _guard = LocalGitBackend::acquire_repo_read_lock(&repo).await;
    tokio::task::spawn_blocking(move || read_set(&repo))
        .await
        .map_err(|error| GitError::Git2(error.to_string()))?
}

/// Reads the conflict set and the generations it was read at. Callers hold
/// the repository lock, so the generations cannot move underneath the read.
pub(super) fn read_set(repo: &RepoPath) -> Result<ConflictSet, GitError> {
    let generations = runtime::generations(repo)?;
    let (entries, total, sides) = LocalGitBackend::with_runtime_git2(repo, |git| {
        let raw = raw_conflicts(&LocalGitBackend::fresh_index(git)?);
        if raw.is_empty() {
            forget_index_only_source(repo);
        }
        let total = raw.len();
        let entries = raw
            .iter()
            .take(CONFLICT_ENTRY_LIMIT)
            .filter_map(|conflict| entry(git, conflict))
            .collect::<Vec<_>>();
        let sides = if total == 0 {
            ConflictSides {
                ours_label: String::new(),
                theirs_label: String::new(),
                inverted: false,
            }
        } else {
            sides(git, repo)
        };
        Ok((entries, total, sides))
    })?;
    Ok(ConflictSet {
        truncated: total > entries.len(),
        total: u32::try_from(total).unwrap_or(u32::MAX),
        entries,
        sides,
        generations,
    })
}

fn entry(git: &git2::Repository, conflict: &RawConflict) -> Option<ConflictEntry> {
    let kind = ConflictKind::from_stages(
        conflict.base.is_some(),
        conflict.ours.is_some(),
        conflict.theirs.is_some(),
    )?;
    let path = conflict.path_lossy();
    let binary = binary_by_attributes(git, &path);
    let stage = |entry: &Option<git2::IndexEntry>| {
        entry.as_ref().map(|entry| ConflictStage {
            blob: CommitId(entry.id.to_string()),
            mode: entry.mode,
            size: git
                .odb()
                .ok()
                .and_then(|odb| odb.read_header(entry.id).ok())
                .map(|(size, _)| size as u64),
            binary,
        })
    };
    Some(ConflictEntry {
        kind,
        base: stage(&conflict.base),
        ours: stage(&conflict.ours),
        theirs: stage(&conflict.theirs),
        path,
    })
}

/// `binary` (or any of the attributes it expands to) set false. Decided
/// without reading a blob.
fn binary_by_attributes(git: &git2::Repository, path: &str) -> bool {
    ["diff", "merge", "text"].iter().any(|name| {
        git.get_attr(Path::new(path), name, git2::AttrCheckFlags::default())
            .ok()
            .map(git2::AttrValue::from_string)
            == Some(git2::AttrValue::False)
    })
}

fn sides(git: &git2::Repository, repo: &RepoPath) -> ConflictSides {
    let git_dir = git.path();
    for directory in ["rebase-merge", "rebase-apply"] {
        let base = git_dir.join(directory);
        if !base.is_dir() {
            continue;
        }
        let onto = read_oid(&base.join("onto"));
        let ours_label = onto
            .map(|oid| label_for_commit(git, oid, None))
            .unwrap_or_default();
        let theirs_label = read_trimmed(&base.join("head-name"))
            .filter(|name| !name.is_empty() && name != "detached HEAD")
            .map(|name| shorthand(&name))
            .or_else(|| read_oid(&git_dir.join("REBASE_HEAD")).map(|oid| short_id(git, oid)))
            .unwrap_or_default();
        return ConflictSides {
            ours_label,
            theirs_label,
            inverted: true,
        };
    }

    let (current_branch, ours_label) = current_side(git);
    let exclude = current_branch.as_deref();
    let marker_side = ["MERGE_HEAD", "CHERRY_PICK_HEAD"]
        .into_iter()
        .find_map(|marker| read_oid(&git_dir.join(marker)))
        .map(|oid| label_for_commit(git, oid, exclude))
        .or_else(|| read_oid(&git_dir.join("REVERT_HEAD")).map(|oid| short_id(git, oid)));
    let theirs_label = marker_side
        .or_else(|| index_only_label(git, repo, exclude))
        .unwrap_or_default();
    ConflictSides {
        ours_label,
        theirs_label,
        inverted: false,
    }
}

/// Names the side of a conflict no Git marker records: the squash source or
/// the applied stash Fjord recorded, then `SQUASH_MSG`'s newest commit, then
/// `stash@{0}` — what a plain external `git stash apply` applies.
fn index_only_label(
    git: &git2::Repository,
    repo: &RepoPath,
    exclude: Option<&str>,
) -> Option<String> {
    let squash_msg = git.path().join("SQUASH_MSG");
    match recorded_index_only_source(repo) {
        Some(IndexOnlySource::SquashMerge { label }) if squash_msg.is_file() => return Some(label),
        Some(IndexOnlySource::Stash { id }) => {
            if let Ok(stash) = super::stash::resolve_stash(git, &id) {
                return Some(stash.ref_name);
            }
        }
        _ => {}
    }
    if squash_msg.is_file() {
        if let Some(oid) = squash_source(&squash_msg) {
            return Some(label_for_commit(git, oid, exclude));
        }
    }
    git.find_reference("refs/stash")
        .ok()
        .map(|_| "stash@{0}".to_string())
}

/// The first `commit <oid>` line of Git's squash message is the source tip.
fn squash_source(path: &Path) -> Option<git2::Oid> {
    let mut contents = String::new();
    std::fs::File::open(path)
        .ok()?
        .take(SQUASH_MSG_LIMIT)
        .read_to_string(&mut contents)
        .ok()?;
    contents
        .lines()
        .find_map(|line| line.strip_prefix("commit "))
        .and_then(|oid| git2::Oid::from_str(oid.trim()).ok())
}

/// `(current branch shorthand, label)`; a detached HEAD is labelled by its
/// short id, an unborn one by its branch name.
fn current_side(git: &git2::Repository) -> (Option<String>, String) {
    match git.head() {
        Ok(head) if head.is_branch() => {
            let name = head.shorthand().unwrap_or_default().to_string();
            (Some(name.clone()), name)
        }
        Ok(head) => (
            None,
            head.target()
                .map(|oid| short_id(git, oid))
                .unwrap_or_default(),
        ),
        Err(_) => {
            let name = git
                .find_reference("HEAD")
                .ok()
                .and_then(|head| head.symbolic_target().ok().flatten().map(shorthand))
                .unwrap_or_default();
            (None, name)
        }
    }
}

/// The ref a commit is known by: a local branch (other than the checked-out
/// one), then a remote-tracking branch, then a tag; otherwise its short id.
fn label_for_commit(git: &git2::Repository, oid: git2::Oid, exclude: Option<&str>) -> String {
    let Ok(references) = git.references() else {
        return short_id(git, oid);
    };
    let mut local = Vec::new();
    let mut remote = Vec::new();
    let mut tags = Vec::new();
    for reference in references.flatten() {
        let Ok(name) = reference.name().map(str::to_string) else {
            continue;
        };
        let Ok(target) = reference.peel_to_commit().map(|commit| commit.id()) else {
            continue;
        };
        if target != oid {
            continue;
        }
        if let Some(branch) = name.strip_prefix("refs/heads/") {
            if Some(branch) != exclude {
                local.push(branch.to_string());
            }
        } else if let Some(tracking) = name.strip_prefix("refs/remotes/") {
            if !tracking.ends_with("/HEAD") {
                remote.push(tracking.to_string());
            }
        } else if let Some(tag) = name.strip_prefix("refs/tags/") {
            tags.push(tag.to_string());
        }
    }
    [local, remote, tags]
        .into_iter()
        .find_map(|mut names| {
            names.sort();
            names.into_iter().next()
        })
        .unwrap_or_else(|| short_id(git, oid))
}

fn short_id(git: &git2::Repository, oid: git2::Oid) -> String {
    git.find_object(oid, None)
        .ok()
        .and_then(|object| object.short_id().ok())
        .and_then(|buf| buf.as_str().ok().map(str::to_string))
        .unwrap_or_else(|| oid.to_string().chars().take(7).collect())
}

fn shorthand(name: &str) -> String {
    name.strip_prefix("refs/heads/")
        .or_else(|| name.strip_prefix("refs/"))
        .unwrap_or(name)
        .to_string()
}

fn read_trimmed(path: &Path) -> Option<String> {
    std::fs::read_to_string(path)
        .ok()
        .map(|value| value.trim().to_string())
}

fn read_oid(path: &Path) -> Option<git2::Oid> {
    read_trimmed(path)?
        .lines()
        .next()
        .and_then(|line| git2::Oid::from_str(line.trim()).ok())
}

/// The 1-based line number of the first conflict marker within the first
/// [`MARKER_SCAN_LIMIT`] bytes, or `None` when there is none or the content
/// is binary. A marker is a line Git itself writes: `<<<<<<< `, `>>>>>>> `
/// and `||||||| ` with their label, or exactly `=======` — so a Markdown
/// underline of a different length is not one.
pub(super) fn first_marker_line(reader: impl Read, limit: u64) -> std::io::Result<Option<u32>> {
    let mut bytes = Vec::new();
    reader.take(limit).read_to_end(&mut bytes)?;
    if bytes[..bytes.len().min(BINARY_SNIFF_LIMIT)].contains(&0) {
        return Ok(None);
    }
    Ok(bytes
        .split(|byte| *byte == b'\n')
        .position(|line| is_marker(line.strip_suffix(b"\r").unwrap_or(line)))
        .map(|index| u32::try_from(index + 1).unwrap_or(u32::MAX)))
}

fn is_marker(line: &[u8]) -> bool {
    const LABELLED: [&[u8]; 3] = [b"<<<<<<<", b">>>>>>>", b"|||||||"];
    line == b"======="
        || LABELLED.iter().any(|marker| {
            line.strip_prefix(*marker)
                .is_some_and(|rest| rest.is_empty() || rest.starts_with(b" "))
        })
}

/// Scans the worktree file for markers; a missing file, a directory, or a
/// symlink (Git stages the link text, not a merged file) has none to find.
fn worktree_marker_line(repo: &RepoPath, relative: &Path) -> Result<Option<u32>, GitError> {
    let path = repo.0.join(relative);
    match std::fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.is_file() => {}
        _ => return Ok(None),
    }
    let file = std::fs::File::open(&path)
        .map_err(|error| GitError::ConflictResolutionFailed(error.kind().to_string()))?;
    first_marker_line(file, MARKER_SCAN_LIMIT)
        .map_err(|error| GitError::ConflictResolutionFailed(error.kind().to_string()))
}

/// The Git invocations for one resolution. The path is always one argument
/// after `--`, never command text; `GIT_LITERAL_PATHSPECS` stops a path such
/// as `*.txt` or `:(glob)x` from being read as a pattern.
pub(super) fn resolution_steps(
    kind: ConflictKind,
    resolution: ConflictResolution,
    path: &str,
) -> Result<Vec<Vec<String>>, GitError> {
    if !kind.allows(resolution) {
        return Err(GitError::ConflictResolutionNotApplicable);
    }
    let path = path.to_string();
    let add = vec!["add".to_string(), "--".to_string(), path.clone()];
    Ok(match resolution {
        ConflictResolution::TakeOurs
        | ConflictResolution::TakeTheirs
        | ConflictResolution::KeepFile => {
            let side = match kind.side_for(resolution) {
                Some(ConflictSide::Ours) => "--ours",
                Some(ConflictSide::Theirs) => "--theirs",
                None => return Err(GitError::ConflictResolutionNotApplicable),
            };
            vec![
                vec![
                    "checkout".to_string(),
                    side.to_string(),
                    "--".to_string(),
                    path,
                ],
                add,
            ]
        }
        ConflictResolution::DeleteFile => vec![vec![
            "rm".to_string(),
            "-f".to_string(),
            "--".to_string(),
            path,
        ]],
        ConflictResolution::MarkResolved => vec![add],
    })
}

pub(super) async fn resolve(
    commands: &GitCommandFactory,
    repo: &RepoPath,
    path: &str,
    resolution: ConflictResolution,
    allow_markers: bool,
    expected_generations: crate::GenerationSet,
) -> Result<ConflictSet, GitError> {
    let commands = commands.clone();
    let repo = repo.clone();
    let path = path.to_string();
    let _guard = LocalGitBackend::acquire_repo_write_lock(&repo).await;
    tokio::task::spawn_blocking(move || {
        resolve_locked(
            &commands,
            &repo,
            &path,
            resolution,
            allow_markers,
            expected_generations,
        )
    })
    .await
    .map_err(|error| GitError::Git2(error.to_string()))?
}

fn resolve_locked(
    commands: &GitCommandFactory,
    repo: &RepoPath,
    path: &str,
    resolution: ConflictResolution,
    allow_markers: bool,
    expected_generations: crate::GenerationSet,
) -> Result<ConflictSet, GitError> {
    if runtime::generations(repo)? != expected_generations {
        return Err(GitError::PreflightStale);
    }
    // A path that could leave the worktree can never be a current conflict.
    let relative =
        super::delete_file::normal_relative_path(path).ok_or(GitError::PreflightStale)?;
    let kind = LocalGitBackend::with_runtime_git2(repo, |git| {
        let raw = raw_conflicts(&LocalGitBackend::fresh_index(git)?);
        raw.iter()
            .find(|conflict| conflict.path == path.as_bytes())
            .and_then(|conflict| {
                ConflictKind::from_stages(
                    conflict.base.is_some(),
                    conflict.ours.is_some(),
                    conflict.theirs.is_some(),
                )
            })
            .ok_or(GitError::PreflightStale)
    })?;
    let steps = resolution_steps(kind, resolution, path)?;
    if resolution == ConflictResolution::MarkResolved && !allow_markers {
        if let Some(line) = worktree_marker_line(repo, &relative)? {
            return Err(GitError::ConflictMarkersPresent {
                path: path.to_string(),
                line,
            });
        }
    }

    // Resolve the executable before anything can change, so a missing Git
    // is a refusal that advances no generation.
    commands.command()?;
    let outcome = steps
        .iter()
        .try_for_each(|arguments| run_step(commands, repo, arguments));
    // Git has been launched: the worktree or index may have changed even if a
    // step failed, so the generation advances either way.
    runtime::bump_mutation(repo, MutationKind::ResolveConflict);
    outcome?;
    read_set(repo)
}

fn run_step(
    commands: &GitCommandFactory,
    repo: &RepoPath,
    arguments: &[String],
) -> Result<(), GitError> {
    let output = commands
        .command()?
        .args(arguments)
        .current_dir(&repo.0)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_LITERAL_PATHSPECS", "1")
        .env("LC_ALL", "C")
        .env("LANG", "C")
        .stdin(Stdio::null())
        .output()
        .map_err(|error| GitError::ConflictResolutionFailed(error.kind().to_string()))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let mut diagnostics = stderr.trim().to_string();
    if diagnostics.len() > DIAGNOSTICS_LIMIT {
        let mut end = DIAGNOSTICS_LIMIT;
        while !diagnostics.is_char_boundary(end) {
            end -= 1;
        }
        diagnostics.truncate(end);
    }
    if diagnostics.is_empty() {
        diagnostics = format!(
            "git {} exited with {:?}",
            arguments[0],
            output.status.code()
        );
    }
    Err(GitError::ConflictResolutionFailed(diagnostics))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marker_scan_names_the_first_marker_line() {
        let text = "one\ntwo\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> topic\n";
        assert_eq!(
            first_marker_line(text.as_bytes(), MARKER_SCAN_LIMIT).unwrap(),
            Some(3)
        );
        assert_eq!(
            first_marker_line("a\r\n=======\r\n".as_bytes(), MARKER_SCAN_LIMIT).unwrap(),
            Some(2)
        );
        assert_eq!(
            first_marker_line("a\n>>>>>>> theirs\n".as_bytes(), MARKER_SCAN_LIMIT).unwrap(),
            Some(2)
        );
        assert_eq!(
            first_marker_line("a\n||||||| base\n".as_bytes(), MARKER_SCAN_LIMIT).unwrap(),
            Some(2)
        );
    }

    #[test]
    fn marker_scan_ignores_lookalikes() {
        let text = "Title\n=========\n<<<<<<<<< not a marker\n  <<<<<<< indented\n==\n";
        assert_eq!(
            first_marker_line(text.as_bytes(), MARKER_SCAN_LIMIT).unwrap(),
            None
        );
    }

    #[test]
    fn marker_scan_is_bounded() {
        let mut text = "x\n".repeat(600 * 1024);
        text.push_str("<<<<<<< HEAD\n");
        assert!(text.len() as u64 > MARKER_SCAN_LIMIT);
        assert_eq!(
            first_marker_line(text.as_bytes(), MARKER_SCAN_LIMIT).unwrap(),
            None
        );
        assert_eq!(
            first_marker_line(text.as_bytes(), text.len() as u64).unwrap(),
            Some(600 * 1024 + 1)
        );
    }

    #[test]
    fn marker_scan_skips_binary_content() {
        let mut bytes = b"<<<<<<< HEAD\n".to_vec();
        bytes.push(0);
        assert_eq!(
            first_marker_line(&bytes[..], MARKER_SCAN_LIMIT).unwrap(),
            None
        );
    }

    #[test]
    fn resolution_steps_keep_the_path_one_argument_after_the_separator() {
        let path = "dir/it's $(rm -rf) *.txt";
        assert_eq!(
            resolution_steps(
                ConflictKind::BothModified,
                ConflictResolution::TakeOurs,
                path
            )
            .unwrap(),
            vec![
                vec!["checkout", "--ours", "--", path],
                vec!["add", "--", path]
            ]
        );
        assert_eq!(
            resolution_steps(
                ConflictKind::BothAdded,
                ConflictResolution::TakeTheirs,
                path
            )
            .unwrap(),
            vec![
                vec!["checkout", "--theirs", "--", path],
                vec!["add", "--", path]
            ]
        );
        assert_eq!(
            resolution_steps(
                ConflictKind::DeletedByThem,
                ConflictResolution::KeepFile,
                path
            )
            .unwrap(),
            vec![
                vec!["checkout", "--ours", "--", path],
                vec!["add", "--", path]
            ]
        );
        assert_eq!(
            resolution_steps(
                ConflictKind::DeletedByUs,
                ConflictResolution::KeepFile,
                path
            )
            .unwrap(),
            vec![
                vec!["checkout", "--theirs", "--", path],
                vec!["add", "--", path]
            ]
        );
        assert_eq!(
            resolution_steps(
                ConflictKind::BothDeleted,
                ConflictResolution::DeleteFile,
                path
            )
            .unwrap(),
            vec![vec!["rm", "-f", "--", path]]
        );
        assert_eq!(
            resolution_steps(
                ConflictKind::BothModified,
                ConflictResolution::MarkResolved,
                path
            )
            .unwrap(),
            vec![vec!["add", "--", path]]
        );
    }

    #[test]
    fn inapplicable_resolutions_are_refused_before_any_step() {
        for (kind, resolution) in [
            (ConflictKind::DeletedByThem, ConflictResolution::TakeTheirs),
            (ConflictKind::BothModified, ConflictResolution::DeleteFile),
            (ConflictKind::BothDeleted, ConflictResolution::KeepFile),
            (ConflictKind::AddedByUs, ConflictResolution::MarkResolved),
        ] {
            assert!(matches!(
                resolution_steps(kind, resolution, "a"),
                Err(GitError::ConflictResolutionNotApplicable)
            ));
        }
    }
}
