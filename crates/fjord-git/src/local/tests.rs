//! Integration tests for the local backend, exercised through the
//! `GitBackend` trait against real fixture repositories.

use super::*;
use crate::GenerationSet;
use git2::{BranchType, Oid, Repository, RepositoryInitOptions, Status};
use std::io::Write as _;
use std::path::Path;
use std::process::Stdio;
use tempfile::TempDir;

/// Runs `status`/`branches`/`log` against *this very repository* as the
/// fixture — the cheapest possible real integration test, per
/// docs/SDD.md §8 ("integration tests against real fixture
/// repositories").
fn this_repo_path() -> RepoPath {
    let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir
        .parent()
        .and_then(|p| p.parent())
        .expect("crates/fjord-git is two levels under the repo root");
    RepoPath(repo_root.to_path_buf())
}

fn empty_repo() -> (TempDir, RepoPath) {
    let dir = TempDir::new().unwrap();
    let mut options = RepositoryInitOptions::new();
    options.initial_head("main");
    let repo = Repository::init_opts(dir.path(), &options).unwrap();
    let mut config = repo.config().unwrap();
    config.set_str("user.name", "Fjord Test").unwrap();
    config.set_str("user.email", "fjord@example.com").unwrap();
    // Pin end-of-line handling for the fixture. Without this the repo
    // inherits the developer's global `core.autocrlf`, which on Windows
    // is typically `true` — so git rewrites LF to CRLF when it restores
    // a file (stash pop, checkout) and byte-for-byte content assertions
    // fail on Windows while passing everywhere else. These tests are
    // about git operations, not about EOL conversion.
    config.set_bool("core.autocrlf", false).unwrap();
    let repo_path = RepoPath(dir.path().to_path_buf());
    (dir, repo_path)
}

fn write_file(repo: &RepoPath, path: &str, content: &str) {
    std::fs::write(repo.0.join(path), content).unwrap();
}

fn write_bytes(repo: &RepoPath, path: &str, content: &[u8]) {
    std::fs::write(repo.0.join(path), content).unwrap();
}

fn index_blob(repo: &RepoPath, path: &str) -> Option<Vec<u8>> {
    let git = Repository::open(&repo.0).unwrap();
    let mut index = git.index().unwrap();
    index.read(true).unwrap();
    let entry = index.get_path(Path::new(path), 0)?;
    let content = git.find_blob(entry.id).unwrap().content().to_vec();
    Some(content)
}

fn head_blob(repo: &RepoPath, path: &str) -> Vec<u8> {
    let git = Repository::open(&repo.0).unwrap();
    let commit = git.head().unwrap().peel_to_commit().unwrap();
    let tree = commit.tree().unwrap();
    let entry = tree.get_path(Path::new(path)).unwrap();
    let content = git.find_blob(entry.id()).unwrap().content().to_vec();
    content
}

fn git_output(backend: &LocalGitBackend, repo: &RepoPath, args: &[&str]) -> Vec<u8> {
    let output = backend
        .commands
        .command()
        .unwrap()
        .args(args)
        .current_dir(&repo.0)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {} failed: {}",
        args.join(" "),
        String::from_utf8_lossy(&output.stderr)
    );
    output.stdout
}

fn patch_state(backend: &LocalGitBackend, repo: &RepoPath) -> (Vec<u8>, Vec<u8>) {
    (
        git_output(backend, repo, &["diff"]),
        git_output(backend, repo, &["diff", "--cached"]),
    )
}

fn whole_patch_selection(
    detail: &FileDiffDetail,
    hunk_indices: impl IntoIterator<Item = usize>,
) -> fjord_domain::PatchSelection {
    fjord_domain::PatchSelection {
        path: detail.path.clone(),
        source: PatchSource::Worktree,
        hunks: hunk_indices
            .into_iter()
            .map(|index| {
                let hunk = &detail.hunks[index];
                fjord_domain::HunkSelection {
                    old_start: hunk.old_start,
                    old_lines: hunk.old_lines,
                    new_start: hunk.new_start,
                    new_lines: hunk.new_lines,
                    lines: Vec::new(),
                }
            })
            .collect(),
        base_digest: patch::base_digest(detail, PatchSource::Worktree),
    }
}

fn staged_patch_selection(
    detail: &FileDiffDetail,
    hunk_indices: impl IntoIterator<Item = usize>,
) -> fjord_domain::PatchSelection {
    let mut selection = whole_patch_selection(detail, hunk_indices);
    selection.source = PatchSource::Index;
    selection.base_digest = patch::base_digest(detail, PatchSource::Index);
    selection
}

fn discard_action(selection: &PatchSelection) -> DestructiveAction {
    if selection.hunks.len() != 1 {
        return DestructiveAction::Discard {
            selection: DiscardSelection::File {
                path: selection.path.clone(),
            },
        };
    }

    let hunk = &selection.hunks[0];
    let selection = if hunk.lines.is_empty() {
        DiscardSelection::Hunk {
            path: selection.path.clone(),
            old_start: hunk.old_start,
            old_lines: hunk.old_lines,
            new_start: hunk.new_start,
            new_lines: hunk.new_lines,
        }
    } else {
        DiscardSelection::Lines {
            path: selection.path.clone(),
            old_start: hunk.old_start,
            old_lines: hunk.old_lines,
            new_start: hunk.new_start,
            new_lines: hunk.new_lines,
            lines: hunk.lines.clone(),
        }
    };
    DestructiveAction::Discard { selection }
}

async fn issue_discard_confirmation(
    backend: &LocalGitBackend,
    repo: &RepoPath,
    selection: &PatchSelection,
    generations: GenerationSet,
) -> (DestructiveAction, String) {
    let action = discard_action(selection);
    let token = backend
        .issue_discard_confirmation(repo, &action, selection, generations)
        .await
        .unwrap();
    (action, token)
}

async fn discard_confirmed(
    backend: &LocalGitBackend,
    repo: &RepoPath,
    selection: &PatchSelection,
    generations: GenerationSet,
) -> Result<GenerationSet, GitError> {
    let (action, token) = issue_discard_confirmation(backend, repo, selection, generations).await;
    backend
        .discard_patch(repo, &action, selection, generations, &token)
        .await
}

fn run_git_success(backend: &LocalGitBackend, repo: &RepoPath, args: &[&str]) {
    let status = backend
        .commands
        .command()
        .unwrap()
        .args(args)
        .current_dir(&repo.0)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .unwrap();
    assert!(status.success(), "git {} should succeed", args.join(" "));
}

fn run_git_status(
    backend: &LocalGitBackend,
    repo: &RepoPath,
    args: &[&str],
) -> std::process::ExitStatus {
    backend
        .commands
        .command()
        .unwrap()
        .args(args)
        .current_dir(&repo.0)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .unwrap()
}

fn resolved_index_path(repo: &RepoPath) -> PathBuf {
    let git = Repository::open(&repo.0).unwrap();
    let index = git.index().unwrap();
    index.path().unwrap().to_path_buf()
}

fn lock_path(resource: &Path) -> PathBuf {
    let mut value = resource.as_os_str().to_owned();
    value.push(".lock");
    PathBuf::from(value)
}

fn assert_index_lock_cleaned(repo: &RepoPath) {
    let index_lock = lock_path(&resolved_index_path(repo));
    assert!(
        !index_lock.exists(),
        "stale index lock: {}",
        index_lock.display()
    );
    let nested = lock_path(&index_lock);
    assert!(
        !nested.exists(),
        "stale alternate-index lock: {}",
        nested.display()
    );
}

fn resolved_git_path(backend: &LocalGitBackend, repo: &RepoPath, path: &str) -> PathBuf {
    let output = git_output(backend, repo, &["rev-parse", "--git-path", path]);
    let value = PathBuf::from(String::from_utf8(output).unwrap().trim());
    if value.is_absolute() {
        value
    } else {
        repo.0.join(value)
    }
}

fn assert_head_locks_cleaned(backend: &LocalGitBackend, repo: &RepoPath) {
    let head_lock = lock_path(&resolved_git_path(backend, repo, "HEAD"));
    assert!(
        !head_lock.exists(),
        "stale HEAD lock: {}",
        head_lock.display()
    );
    let git = Repository::open(&repo.0).unwrap();
    let target = {
        let head = git.find_reference("HEAD").unwrap();
        head.symbolic_target().unwrap().map(str::to_string)
    };
    if let Some(target) = target {
        let target_lock = lock_path(&resolved_git_path(backend, repo, &target));
        assert!(
            !target_lock.exists(),
            "stale HEAD target lock: {}",
            target_lock.display()
        );
    }
}

#[derive(Debug, PartialEq, Eq)]
struct AtomicPatchState {
    head: Option<Oid>,
    index: Option<Vec<u8>>,
    cached_diff: Vec<u8>,
    worktree_diff: Vec<u8>,
    worktree_files: Vec<(String, Option<Vec<u8>>)>,
    generations: GenerationSet,
}

fn atomic_patch_state(
    backend: &LocalGitBackend,
    repo: &RepoPath,
    paths: &[&str],
) -> AtomicPatchState {
    let git = Repository::open(&repo.0).unwrap();
    let head = git.head().ok().and_then(|head| head.target());
    let index = match std::fs::read(resolved_index_path(repo)) {
        Ok(index) => Some(index),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => panic!("could not read test index: {error}"),
    };
    AtomicPatchState {
        head,
        index,
        cached_diff: git_output(backend, repo, &["diff", "--cached"]),
        worktree_diff: git_output(backend, repo, &["diff"]),
        worktree_files: paths
            .iter()
            .map(|path| {
                let bytes = match std::fs::read(repo.0.join(path)) {
                    Ok(bytes) => Some(bytes),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                    Err(error) => panic!("could not read worktree test file: {error}"),
                };
                ((*path).to_string(), bytes)
            })
            .collect(),
        generations: backend.generations(repo).unwrap(),
    }
}

/// Repository-local configuration has the same `git apply` effect as a user
/// setting in `.gitconfig`, while keeping the hostile setting contained to this
/// real temporary repository.
fn set_apply_whitespace_config(repo: &RepoPath, whitespace: &str) {
    let git = Repository::open(&repo.0).unwrap();
    let mut config = git.config().unwrap();
    config.set_str("apply.whitespace", whitespace).unwrap();
}

fn set_hostile_apply_config(repo: &RepoPath) {
    set_apply_whitespace_config(repo, "fix");
    let git = Repository::open(&repo.0).unwrap();
    let mut config = git.config().unwrap();
    config.set_str("apply.ignoreWhitespace", "change").unwrap();
}

async fn commit_fixture(backend: &LocalGitBackend, repo: &RepoPath, files: &[(&str, &[u8])]) {
    let mut paths = Vec::new();
    for (path, content) in files {
        write_bytes(repo, path, content);
        paths.push(PathBuf::from(path));
    }
    backend.stage(repo, &paths).await.unwrap();
    backend.commit(repo, "Initial commit").await.unwrap();
}

fn assert_patch_applies_without_mutation(backend: &LocalGitBackend, repo: &RepoPath, patch: &[u8]) {
    let mut command = backend.commands.command().unwrap();
    command
        .current_dir(&repo.0)
        .args([
            "apply",
            "--whitespace=nowarn",
            "--no-ignore-whitespace",
            "--check",
            "--cached",
            "-",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut child = command.spawn().unwrap();
    child.stdin.take().unwrap().write_all(patch).unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "generated patch should pass git apply --check: {}\n{}",
        String::from_utf8_lossy(&output.stderr),
        String::from_utf8_lossy(patch)
    );
}

async fn repo_with_changed_head() -> (TempDir, RepoPath, String) {
    let (dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();

    write_file(&repo_path, "README.md", "base\n");
    backend
        .stage(&repo_path, &[PathBuf::from("README.md")])
        .await
        .unwrap();
    backend.commit(&repo_path, "Initial commit").await.unwrap();

    write_file(&repo_path, "README.md", "base\nupdated\n");
    backend
        .stage(&repo_path, &[PathBuf::from("README.md")])
        .await
        .unwrap();
    let head = backend.commit(&repo_path, "Update readme").await.unwrap();

    (dir, repo_path, head)
}

#[tokio::test]
async fn status_reports_a_branch_name() {
    let backend = LocalGitBackend::new();
    let status = backend.status(&this_repo_path()).await.unwrap();
    assert!(status.branch.is_some());
}

#[tokio::test]
async fn primary_reads_share_one_repository_runtime() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    write_file(&repo_path, "README.md", "base\n");
    let git = Repository::open(&repo_path.0).unwrap();
    let mut index = git.index().unwrap();
    index.add_path(Path::new("README.md")).unwrap();
    let tree_id = index.write_tree().unwrap();
    let tree = git.find_tree(tree_id).unwrap();
    let signature = git.signature().unwrap();
    git.commit(Some("HEAD"), &signature, &signature, "Initial", &tree, &[])
        .unwrap();
    drop(tree);
    drop(git);

    assert_eq!(runtime::open_attempts(&repo_path), 0);
    let (status, branches, log, changes) = tokio::join!(
        backend.status(&repo_path),
        backend.branches(&repo_path),
        backend.log(&repo_path, None, 20),
        backend.working_changes(&repo_path),
    );
    status.unwrap();
    branches.unwrap();
    log.unwrap();
    changes.unwrap();

    assert_eq!(runtime::open_attempts(&repo_path), 1);
}

#[tokio::test]
async fn generations_move_only_after_successful_mutations() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    let zero = GenerationSet::default();
    assert_eq!(runtime::generations(&repo_path).unwrap(), zero);

    write_file(&repo_path, "README.md", "base\n");
    backend
        .stage(&repo_path, &[PathBuf::from("README.md")])
        .await
        .unwrap();
    backend.commit(&repo_path, "Initial").await.unwrap();
    let after_initial = GenerationSet {
        working_tree: 2,
        refs: 1,
        history: 1,
        ..GenerationSet::default()
    };
    assert_eq!(runtime::generations(&repo_path).unwrap(), after_initial);

    backend
        .create_branch(&repo_path, "topic", false)
        .await
        .unwrap();
    let after_branch = GenerationSet {
        refs: 2,
        ..after_initial
    };
    assert_eq!(runtime::generations(&repo_path).unwrap(), after_branch);

    let error = backend.commit(&repo_path, "Nothing").await.unwrap_err();
    assert!(matches!(error, GitError::NothingToCommit));
    assert_eq!(runtime::generations(&repo_path).unwrap(), after_branch);

    write_file(&repo_path, "README.md", "updated\n");
    backend
        .stage(&repo_path, &[PathBuf::from("README.md")])
        .await
        .unwrap();
    assert_eq!(
        runtime::generations(&repo_path).unwrap(),
        GenerationSet {
            working_tree: 3,
            ..after_branch
        }
    );

    backend.commit(&repo_path, "Update").await.unwrap();
    assert_eq!(
        runtime::generations(&repo_path).unwrap(),
        GenerationSet {
            working_tree: 4,
            refs: 3,
            history: 2,
            ..GenerationSet::default()
        }
    );
}

#[tokio::test]
async fn status_reports_real_ahead_count_from_local_tracking_refs() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    write_file(&repo_path, "README.md", "base\n");
    backend
        .stage(&repo_path, &[PathBuf::from("README.md")])
        .await
        .unwrap();
    let base = backend.commit(&repo_path, "Initial").await.unwrap();

    let repo = Repository::open(&repo_path.0).unwrap();
    repo.remote("origin", "https://example.invalid/repo.git")
        .unwrap();
    repo.reference(
        "refs/remotes/origin/main",
        Oid::from_str(&base).unwrap(),
        true,
        "test remote tracking ref",
    )
    .unwrap();
    repo.find_branch("main", BranchType::Local)
        .unwrap()
        .set_upstream(Some("origin/main"))
        .unwrap();
    drop(repo);

    write_file(&repo_path, "README.md", "local change\n");
    backend
        .stage(&repo_path, &[PathBuf::from("README.md")])
        .await
        .unwrap();
    backend.commit(&repo_path, "Ahead").await.unwrap();

    let status = backend.status(&repo_path).await.unwrap();
    assert_eq!(status.ahead, 1);
    assert_eq!(status.behind, 0);
}

/// Local subprocess operations must run the executable Fjord was configured
/// with, not whatever `git` resolves to on `PATH`.
#[tokio::test]
async fn local_git_commands_use_the_configured_executable() {
    let (_dir, repo_path) = empty_repo();
    let commands = GitCommandFactory::new();
    let backend = LocalGitBackend::with_commands(commands.clone());

    write_file(&repo_path, "README.md", "base\n");
    backend
        .stage(&repo_path, &[PathBuf::from("README.md")])
        .await
        .unwrap();
    let head = backend.commit(&repo_path, "Initial").await.unwrap();
    backend
        .create_tag(&repo_path, "v1", &head)
        .await
        .expect("the default factory resolves Git from PATH");

    commands.apply(GitExecutableResolution::Resolved(PathBuf::from(
        "fjord-not-a-real-git",
    )));
    let error = backend
        .create_tag(&repo_path, "v2", &head)
        .await
        .expect_err("a configured executable that cannot run must fail loudly");
    assert!(
        matches!(&error, GitError::Git2(message) if message.contains("failed to run git")),
        "unexpected error: {error:?}"
    );

    commands.apply(GitExecutableResolution::Resolved(PathBuf::from("git")));
    backend.create_tag(&repo_path, "v3", &head).await.unwrap();
}

/// The push target comes from the branch's upstream configuration, including a
/// non-`origin` remote and a remote branch with a different name.
#[tokio::test]
async fn push_target_follows_the_configured_upstream() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    write_file(&repo_path, "README.md", "base\n");
    backend
        .stage(&repo_path, &[PathBuf::from("README.md")])
        .await
        .unwrap();
    let base = backend.commit(&repo_path, "Initial").await.unwrap();

    assert!(matches!(
        backend.current_push_target(&repo_path).await,
        Err(GitError::NoUpstream)
    ));
    assert_eq!(
        backend.current_branch_ref(&repo_path).await.unwrap(),
        "refs/heads/main"
    );

    let repo = Repository::open(&repo_path.0).unwrap();
    repo.remote("company", "https://example.invalid/team/app.git")
        .unwrap();
    repo.reference(
        "refs/remotes/company/trunk",
        Oid::from_str(&base).unwrap(),
        true,
        "test remote tracking ref",
    )
    .unwrap();
    repo.find_branch("main", BranchType::Local)
        .unwrap()
        .set_upstream(Some("company/trunk"))
        .unwrap();
    drop(repo);

    let target = backend.current_push_target(&repo_path).await.unwrap();
    assert_eq!(target.remote, "company");
    assert_eq!(target.local_ref, "refs/heads/main");
    assert_eq!(target.remote_ref, "refs/heads/trunk");
    assert_eq!(target.refspec(), "refs/heads/main:refs/heads/trunk");
}

#[tokio::test]
async fn branches_includes_the_current_branch() {
    let backend = LocalGitBackend::new();
    let branches = backend.branches(&this_repo_path()).await.unwrap();
    assert!(branches.iter().any(|b| b.is_current));
    assert!(branches.iter().all(|b| !b.target_commit_id.0.is_empty()));
}

#[tokio::test]
async fn branches_excludes_remote_head_aliases() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    write_file(&repo_path, "README.md", "# Fjord\n");
    backend
        .stage(&repo_path, &[PathBuf::from("README.md")])
        .await
        .unwrap();
    backend.commit(&repo_path, "Initial commit").await.unwrap();

    let repo = Repository::open(&repo_path.0).unwrap();
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    repo.reference("refs/remotes/origin/main", head.id(), true, "seed remote")
        .unwrap();
    repo.reference(
        "refs/remotes/origin/HEAD",
        head.id(),
        true,
        "seed remote head",
    )
    .unwrap();
    drop(head);
    drop(repo);

    let branches = backend.branches(&repo_path).await.unwrap();

    assert!(branches.iter().any(|branch| branch.name == "origin/main"));
    assert!(!branches.iter().any(|branch| branch.name == "origin/HEAD"));
}

#[tokio::test]
async fn tags_resolves_lightweight_and_annotated_tags_to_their_commit() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    write_file(&repo_path, "README.md", "# Fjord\n");
    backend
        .stage(&repo_path, &[PathBuf::from("README.md")])
        .await
        .unwrap();
    let oid = backend.commit(&repo_path, "Initial commit").await.unwrap();

    let repo = Repository::open(&repo_path.0).unwrap();
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    repo.tag_lightweight("v1.0.0-lightweight", head.as_object(), false)
        .unwrap();
    let signature = repo.signature().unwrap();
    repo.tag(
        "v1.0.0-annotated",
        head.as_object(),
        &signature,
        "Release",
        false,
    )
    .unwrap();
    drop(head);
    drop(repo);

    let tags = backend.tags(&repo_path).await.unwrap();
    let names: Vec<_> = tags.iter().map(|t| t.name.as_str()).collect();
    assert!(names.contains(&"v1.0.0-lightweight"));
    assert!(names.contains(&"v1.0.0-annotated"));
    assert!(tags.iter().all(|t| t.target_commit_id.0 == oid));
}

#[tokio::test]
async fn log_returns_at_least_one_commit() {
    let backend = LocalGitBackend::new();
    let page = backend.log(&this_repo_path(), None, 5).await.unwrap();
    assert!(!page.commits.is_empty());
}

#[tokio::test]
async fn log_includes_commits_from_non_current_branches_with_refs() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    write_file(&repo_path, "README.md", "main\n");
    backend
        .stage(&repo_path, &[PathBuf::from("README.md")])
        .await
        .unwrap();
    backend.commit(&repo_path, "Initial commit").await.unwrap();

    backend
        .create_branch(&repo_path, "feature", true)
        .await
        .unwrap();
    write_file(&repo_path, "README.md", "feature\n");
    backend
        .stage(&repo_path, &[PathBuf::from("README.md")])
        .await
        .unwrap();
    let feature_oid = backend.commit(&repo_path, "Feature tip").await.unwrap();
    backend.checkout(&repo_path, "main").await.unwrap();

    let page = backend.log(&repo_path, None, 20).await.unwrap();
    let feature = page
        .commits
        .iter()
        .find(|commit| commit.id.0 == feature_oid)
        .expect("log should include non-current branch tip");

    assert!(feature.refs.iter().any(|name| name == "feature"));
}

#[tokio::test]
async fn log_paginates_without_repeating_commits() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    write_file(&repo_path, "README.md", "one\n");
    backend
        .stage(&repo_path, &[PathBuf::from("README.md")])
        .await
        .unwrap();
    backend.commit(&repo_path, "First").await.unwrap();
    write_file(&repo_path, "README.md", "two\n");
    backend
        .stage(&repo_path, &[PathBuf::from("README.md")])
        .await
        .unwrap();
    backend.commit(&repo_path, "Second").await.unwrap();

    let first = backend.log(&repo_path, None, 1).await.unwrap();
    let second = backend
        .log(&repo_path, first.next_cursor.clone(), 1)
        .await
        .unwrap();

    assert_eq!(first.commits.len(), 1);
    assert_eq!(second.commits.len(), 1);
    assert_ne!(first.commits[0].id, second.commits[0].id);
}

#[tokio::test]
async fn tenth_log_page_is_served_from_the_bounded_cursor_window() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    for revision in 0..25 {
        write_file(&repo_path, "README.md", &format!("revision {revision}\n"));
        backend
            .stage(&repo_path, &[PathBuf::from("README.md")])
            .await
            .unwrap();
        backend
            .commit(&repo_path, &format!("Revision {revision}"))
            .await
            .unwrap();
    }

    let mut cursor = None;
    let mut ids = Vec::new();
    for page_number in 1..=10 {
        let page = backend.log(&repo_path, cursor, 2).await.unwrap();
        ids.extend(page.commits.iter().map(|commit| commit.id.0.clone()));
        cursor = page.next_cursor;
        if page_number < 10 {
            assert!(
                cursor
                    .as_ref()
                    .is_some_and(|cursor| cursor.0.starts_with("window:")),
                "page {} should resume from the prefetched bounded window",
                page_number + 1
            );
        }
    }

    let mut unique = ids.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(ids.len(), 20);
    assert_eq!(unique.len(), ids.len());
    assert!(
        cursor
            .as_ref()
            .is_some_and(|cursor| cursor.0 == "offset:20"),
        "the next bounded window starts only after page ten"
    );

    let page_11 = backend.log(&repo_path, cursor, 2).await.unwrap();
    assert!(page_11
        .commits
        .iter()
        .all(|commit| !unique.contains(&commit.id.0)));
}

#[tokio::test]
async fn search_commits_matches_titles_across_non_current_branches() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    write_file(&repo_path, "README.md", "main\n");
    backend
        .stage(&repo_path, &[PathBuf::from("README.md")])
        .await
        .unwrap();
    backend.commit(&repo_path, "Initial commit").await.unwrap();

    backend
        .create_branch(&repo_path, "feature/search", true)
        .await
        .unwrap();
    write_file(&repo_path, "README.md", "feature\n");
    backend
        .stage(&repo_path, &[PathBuf::from("README.md")])
        .await
        .unwrap();
    let feature_oid = backend
        .commit(&repo_path, "Needle result commit")
        .await
        .unwrap();
    backend.checkout(&repo_path, "main").await.unwrap();

    let commits = backend
        .search_commits(&repo_path, "needle result", 10)
        .await
        .unwrap();

    assert_eq!(commits.len(), 1);
    assert_eq!(commits[0].id.0, feature_oid);
    assert!(commits[0].refs.iter().any(|name| name == "feature/search"));
}

#[tokio::test]
async fn diff_reports_changed_files_for_head() {
    let (_dir, repo_path, head) = repo_with_changed_head().await;
    let backend = LocalGitBackend::new();

    let files = backend.diff(&repo_path, &head).await.unwrap();

    assert_eq!(files.len(), 1);
    assert_eq!(files[0].path, "README.md");
    assert_eq!(files[0].change_type, FileChangeType::Modified);
    assert_eq!(files[0].additions, 1);
    assert_eq!(files[0].deletions, 0);
}

#[tokio::test]
async fn diff_files_returns_tree_metadata_without_line_work() {
    let (_dir, repo_path, head) = repo_with_changed_head().await;
    let backend = LocalGitBackend::new();

    let files = backend.diff_files(&repo_path, &head).await.unwrap();

    assert_eq!(files.len(), 1);
    assert_eq!(files[0].path, "README.md");
    assert_eq!(files[0].change_type, FileChangeType::Modified);
    assert_eq!((files[0].additions, files[0].deletions), (0, 0));
}

#[tokio::test]
async fn diff_reports_files_for_a_root_commit() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    write_file(&repo_path, "README.md", "first line\nsecond line\n");
    backend
        .stage(&repo_path, &[PathBuf::from("README.md")])
        .await
        .unwrap();
    let root = backend.commit(&repo_path, "Root commit").await.unwrap();

    let files = backend.diff(&repo_path, &root).await.unwrap();

    assert_eq!(files.len(), 1);
    assert_eq!(files[0].path, "README.md");
    assert_eq!(files[0].change_type, FileChangeType::Added);
    assert_eq!(files[0].additions, 2);
    assert_eq!(files[0].deletions, 0);
}

#[test]
fn numstat_parser_handles_binary_files_and_tabs_in_paths() {
    let parsed = LocalGitBackend::parse_numstat(
        b"12\t3\tsrc/file.rs\0-\t-\tassets/image.png\x001\t0\tpath/with\ttab.txt\0",
    );

    assert_eq!(parsed.get("src/file.rs"), Some(&(12, 3)));
    assert_eq!(parsed.get("assets/image.png"), Some(&(0, 0)));
    assert_eq!(parsed.get("path/with\ttab.txt"), Some(&(1, 0)));
}

#[tokio::test]
async fn file_diff_reports_hunks_for_a_file_changed_in_head() {
    let (_dir, repo_path, head) = repo_with_changed_head().await;
    let backend = LocalGitBackend::new();

    let detail = backend
        .file_diff(&repo_path, &head, "README.md")
        .await
        .unwrap();
    assert_eq!(detail.path, "README.md");
    assert!(!detail.is_binary);
    assert!(!detail.hunks.is_empty());
    assert!(detail
        .hunks
        .iter()
        .flat_map(|hunk| hunk.lines.iter())
        .any(|line| line.kind == DiffLineKind::Addition && line.content == "updated"));
}

#[tokio::test]
async fn file_diff_window_returns_a_bounded_page_with_a_cursor() {
    let (_dir, repo_path, head) = repo_with_changed_head().await;
    let backend = LocalGitBackend::new();

    let window = backend
        .file_diff_window(&repo_path, &head, "README.md", 0, 1, 10 * 1024 * 1024)
        .await
        .unwrap();

    assert_eq!(
        window
            .hunks
            .iter()
            .map(|hunk| hunk.lines.len())
            .sum::<usize>(),
        1
    );
    assert!(window.total_lines > 1);
    assert_eq!(window.offset, 0);
    assert!(window.truncated);
    assert_eq!(window.next_offset, Some(1));
}

#[tokio::test]
async fn oversized_file_diff_returns_metadata_without_content() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    let mut content = "x".repeat(11 * 1024 * 1024);
    write_file(&repo_path, "large.txt", &content);
    backend
        .stage(&repo_path, &[PathBuf::from("large.txt")])
        .await
        .unwrap();
    backend.commit(&repo_path, "Large base").await.unwrap();
    content.push('y');
    write_file(&repo_path, "large.txt", &content);
    backend
        .stage(&repo_path, &[PathBuf::from("large.txt")])
        .await
        .unwrap();
    let head = backend.commit(&repo_path, "Large change").await.unwrap();

    let window = backend
        .file_diff_window(&repo_path, &head, "large.txt", 0, 1_000, 10 * 1024 * 1024)
        .await
        .unwrap();

    assert!(window.too_large);
    assert!(window.file_bytes > 10 * 1024 * 1024);
    assert!(window.hunks.is_empty());
}

#[tokio::test]
async fn stage_and_commit_create_head_commit() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    write_file(&repo_path, "README.md", "# Fjord\n");

    backend
        .stage(&repo_path, &[PathBuf::from("README.md")])
        .await
        .unwrap();
    let oid = backend.commit(&repo_path, "Initial commit").await.unwrap();

    let repo = Repository::open(&repo_path.0).unwrap();
    assert_eq!(
        repo.head()
            .unwrap()
            .peel_to_commit()
            .unwrap()
            .id()
            .to_string(),
        oid
    );
}

#[tokio::test]
async fn unstage_removes_index_change_without_touching_worktree() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    write_file(&repo_path, "README.md", "first\n");
    backend
        .stage(&repo_path, &[PathBuf::from("README.md")])
        .await
        .unwrap();
    backend.commit(&repo_path, "Initial commit").await.unwrap();

    write_file(&repo_path, "README.md", "second\n");
    backend
        .stage(&repo_path, &[PathBuf::from("README.md")])
        .await
        .unwrap();
    backend
        .unstage(&repo_path, &[PathBuf::from("README.md")])
        .await
        .unwrap();

    let status = Repository::open(&repo_path.0)
        .unwrap()
        .status_file(Path::new("README.md"))
        .unwrap();
    assert!(!status.contains(Status::INDEX_MODIFIED));
    assert!(status.contains(Status::WT_MODIFIED));
}

#[tokio::test]
async fn checkout_switches_local_branch() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    write_file(&repo_path, "README.md", "# Fjord\n");
    backend
        .stage(&repo_path, &[PathBuf::from("README.md")])
        .await
        .unwrap();
    backend.commit(&repo_path, "Initial commit").await.unwrap();

    let repo = Repository::open(&repo_path.0).unwrap();
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    repo.branch("feature", &head, false).unwrap();
    drop(head);
    drop(repo);

    backend.checkout(&repo_path, "feature").await.unwrap();

    let repo = Repository::open(&repo_path.0).unwrap();
    assert_eq!(repo.head().unwrap().shorthand().unwrap(), "feature");
}

#[tokio::test]
async fn checkout_remote_branch_creates_local_tracking_branch() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    write_file(&repo_path, "README.md", "# Fjord\n");
    backend
        .stage(&repo_path, &[PathBuf::from("README.md")])
        .await
        .unwrap();
    backend.commit(&repo_path, "Initial commit").await.unwrap();

    let repo = Repository::open(&repo_path.0).unwrap();
    repo.remote("origin", "https://example.invalid/repo.git")
        .unwrap();
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    repo.branch("feature", &head, false).unwrap();
    repo.reference(
        "refs/remotes/origin/feature",
        head.id(),
        true,
        "materialize fetched remote ref",
    )
    .unwrap();
    drop(head);
    drop(repo);

    Repository::open(&repo_path.0)
        .unwrap()
        .find_branch("feature", BranchType::Local)
        .unwrap()
        .delete()
        .unwrap();

    backend
        .checkout_local(&repo_path, "origin/feature")
        .await
        .unwrap();

    let repo = Repository::open(&repo_path.0).unwrap();
    assert_eq!(repo.head().unwrap().shorthand().unwrap(), "feature");
    let branch = repo.find_branch("feature", BranchType::Local).unwrap();
    assert_eq!(
        branch.upstream().unwrap().name().unwrap(),
        Some("origin/feature")
    );
}

#[tokio::test]
async fn working_changes_separates_staged_from_unstaged() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    write_file(&repo_path, "README.md", "first\n");
    backend
        .stage(&repo_path, &[PathBuf::from("README.md")])
        .await
        .unwrap();
    backend.commit(&repo_path, "Initial commit").await.unwrap();

    // One staged edit, one untracked file left alone.
    write_file(&repo_path, "README.md", "second\n");
    backend
        .stage(&repo_path, &[PathBuf::from("README.md")])
        .await
        .unwrap();
    write_file(&repo_path, "NOTES.md", "scratch\n");

    let changes = backend.working_changes(&repo_path).await.unwrap();

    assert_eq!(changes.staged.len(), 1);
    assert_eq!(changes.staged[0].path, "README.md");
    assert_eq!(changes.staged[0].change_type, FileChangeType::Modified);
    assert_eq!(changes.unstaged.len(), 1);
    assert_eq!(changes.unstaged[0].path, "NOTES.md");
    assert_eq!(changes.unstaged[0].change_type, FileChangeType::Added);
}

#[tokio::test]
async fn working_file_diff_reads_staged_and_unstaged_sides_separately() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    write_file(&repo_path, "README.md", "base\n");
    backend
        .stage(&repo_path, &[PathBuf::from("README.md")])
        .await
        .unwrap();
    backend.commit(&repo_path, "Initial commit").await.unwrap();

    write_file(&repo_path, "README.md", "staged\n");
    backend
        .stage(&repo_path, &[PathBuf::from("README.md")])
        .await
        .unwrap();
    write_file(&repo_path, "README.md", "worktree\n");

    let staged = backend
        .working_file_diff(&repo_path, "README.md", true)
        .await
        .unwrap();
    let unstaged = backend
        .working_file_diff(&repo_path, "README.md", false)
        .await
        .unwrap();

    let added = |detail: &FileDiffDetail| {
        detail
            .hunks
            .iter()
            .flat_map(|hunk| hunk.lines.iter())
            .filter(|line| line.kind == DiffLineKind::Addition)
            .map(|line| line.content.clone())
            .collect::<Vec<_>>()
    };

    assert_eq!(
        added(&staged),
        vec!["staged"],
        "staged side is index vs HEAD"
    );
    assert_eq!(
        added(&unstaged),
        vec!["worktree"],
        "unstaged side is worktree vs index"
    );
}

#[tokio::test]
async fn patch_generation_is_read_only_and_bound_to_the_working_generation() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    write_file(&repo_path, "README.md", "one\ntwo\nthree\n");
    backend
        .stage(&repo_path, &[PathBuf::from("README.md")])
        .await
        .unwrap();
    backend.commit(&repo_path, "Initial commit").await.unwrap();

    write_file(&repo_path, "README.md", "one\nchanged\nthree\n");
    let before_generation = backend.generations(&repo_path).unwrap();
    let git = Repository::open(&repo_path.0).unwrap();
    let index_path = git.path().join("index");
    let index_before = std::fs::read(&index_path).unwrap();
    let worktree_before = std::fs::read(repo_path.0.join("README.md")).unwrap();
    drop(git);

    let detail = backend
        .working_file_diff(&repo_path, "README.md", false)
        .await
        .unwrap();
    let window = backend
        .working_file_diff_window(&repo_path, "README.md", false, 0, 1_000, u64::MAX)
        .await
        .unwrap();
    let digest = patch::base_digest(&detail, PatchSource::Worktree);
    assert_eq!(window.base_digest.as_deref(), Some(digest.as_str()));
    let selection = fjord_domain::PatchSelection {
        path: detail.path.clone(),
        source: PatchSource::Worktree,
        hunks: detail
            .hunks
            .iter()
            .map(|hunk| fjord_domain::HunkSelection {
                old_start: hunk.old_start,
                old_lines: hunk.old_lines,
                new_start: hunk.new_start,
                new_lines: hunk.new_lines,
                lines: Vec::new(),
            })
            .collect(),
        base_digest: digest,
    };
    let generated = patch::build_unified_patch(&detail, &selection).unwrap();

    assert!(generated.starts_with(b"diff --git a/README.md b/README.md\n"));
    assert_patch_applies_without_mutation(&backend, &repo_path, &generated);
    let addition_index = detail.hunks[0]
        .lines
        .iter()
        .position(|line| line.kind == DiffLineKind::Addition)
        .unwrap() as u32;
    let partial = fjord_domain::PatchSelection {
        hunks: vec![fjord_domain::HunkSelection {
            lines: vec![addition_index],
            ..selection.hunks[0].clone()
        }],
        ..selection.clone()
    };
    let generated_partial = patch::build_unified_patch(&detail, &partial).unwrap();
    assert_patch_applies_without_mutation(&backend, &repo_path, &generated_partial);
    assert_eq!(std::fs::read(&index_path).unwrap(), index_before);
    assert_eq!(
        std::fs::read(repo_path.0.join("README.md")).unwrap(),
        worktree_before
    );
    assert_eq!(backend.generations(&repo_path).unwrap(), before_generation);

    // A real backend mutation uses the existing generation clock. The old
    // digest then fails closed against the newly computed source diff.
    backend
        .stage(&repo_path, &[PathBuf::from("README.md")])
        .await
        .unwrap();
    assert!(backend.generations(&repo_path).unwrap().working_tree > before_generation.working_tree);
    let current = backend
        .working_file_diff(&repo_path, "README.md", false)
        .await
        .unwrap();
    assert!(matches!(
        patch::build_unified_patch(&current, &selection),
        Err(GitError::PatchStale)
    ));
}

#[tokio::test]
async fn working_patch_diff_preserves_crlf_and_missing_final_newline_metadata() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    write_file(&repo_path, "README.md", "old\r\nlast");
    backend
        .stage(&repo_path, &[PathBuf::from("README.md")])
        .await
        .unwrap();
    backend.commit(&repo_path, "Initial commit").await.unwrap();

    write_file(&repo_path, "README.md", "new\r\nlast");
    let detail = backend
        .working_file_diff(&repo_path, "README.md", false)
        .await
        .unwrap();
    let lines = &detail.hunks[0].lines;

    assert_eq!(lines[0].kind, DiffLineKind::Deletion);
    assert_eq!(lines[0].line_ending, Some(DiffLineEnding::Crlf));
    assert_eq!(lines[1].kind, DiffLineKind::Addition);
    assert_eq!(lines[1].line_ending, Some(DiffLineEnding::Crlf));
    assert_eq!(lines.last().unwrap().content, "last");
    assert_eq!(
        lines.last().unwrap().line_ending,
        Some(DiffLineEnding::None)
    );
    let selection = fjord_domain::PatchSelection {
        path: detail.path.clone(),
        source: PatchSource::Worktree,
        hunks: detail
            .hunks
            .iter()
            .map(|hunk| fjord_domain::HunkSelection {
                old_start: hunk.old_start,
                old_lines: hunk.old_lines,
                new_start: hunk.new_start,
                new_lines: hunk.new_lines,
                lines: Vec::new(),
            })
            .collect(),
        base_digest: patch::base_digest(&detail, PatchSource::Worktree),
    };
    let generated = patch::build_unified_patch(&detail, &selection).unwrap();
    assert_patch_applies_without_mutation(&backend, &repo_path, &generated);
}

#[tokio::test]
async fn added_and_deleted_working_files_produce_checkable_read_only_patches() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    write_file(&repo_path, "deleted.txt", "remove me\n");
    backend
        .stage(&repo_path, &[PathBuf::from("deleted.txt")])
        .await
        .unwrap();
    backend.commit(&repo_path, "Initial commit").await.unwrap();

    std::fs::remove_file(repo_path.0.join("deleted.txt")).unwrap();
    write_file(&repo_path, "added.txt", "add me\n");
    let index_path = Repository::open(&repo_path.0).unwrap().path().join("index");
    let index_before = std::fs::read(&index_path).unwrap();

    for (path, expected_change) in [
        ("added.txt", FileChangeType::Added),
        ("deleted.txt", FileChangeType::Deleted),
    ] {
        let detail = backend
            .working_file_diff(&repo_path, path, false)
            .await
            .unwrap();
        assert_eq!(detail.change_type, expected_change);
        let digest = patch::base_digest(&detail, PatchSource::Worktree);
        let selection = fjord_domain::PatchSelection {
            path: path.to_string(),
            source: PatchSource::Worktree,
            hunks: detail
                .hunks
                .iter()
                .map(|hunk| fjord_domain::HunkSelection {
                    old_start: hunk.old_start,
                    old_lines: hunk.old_lines,
                    new_start: hunk.new_start,
                    new_lines: hunk.new_lines,
                    lines: Vec::new(),
                })
                .collect(),
            base_digest: digest,
        };
        let generated = patch::build_unified_patch(&detail, &selection).unwrap();
        assert_patch_applies_without_mutation(&backend, &repo_path, &generated);
    }

    assert_eq!(std::fs::read(index_path).unwrap(), index_before);
    assert_eq!(
        std::fs::read_to_string(repo_path.0.join("added.txt")).unwrap(),
        "add me\n"
    );
    assert!(!repo_path.0.join("deleted.txt").exists());
}

#[tokio::test]
async fn stage_patch_stages_a_complete_hunk_without_touching_the_worktree() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    commit_fixture(&backend, &repo_path, &[("file.txt", b"one\ntwo\nthree\n")]).await;

    let worktree = b"one\nTWO\nthree\n";
    write_bytes(&repo_path, "file.txt", worktree);
    let detail = backend
        .working_file_diff(&repo_path, "file.txt", false)
        .await
        .unwrap();
    let selection = whole_patch_selection(&detail, 0..detail.hunks.len());
    let before = backend.generations(&repo_path).unwrap();

    let after = backend
        .stage_patch(&repo_path, &selection, before)
        .await
        .unwrap();

    assert_eq!(index_blob(&repo_path, "file.txt").unwrap(), worktree);
    assert_eq!(
        std::fs::read(repo_path.0.join("file.txt")).unwrap(),
        worktree
    );
    assert_eq!(after.working_tree, before.working_tree + 1);
    assert_eq!(after.refs, before.refs);
    assert_eq!(after.history, before.history);
    assert_eq!(after.stash, before.stash);
    assert_eq!(after.config, before.config);

    let index_after = std::fs::read(repo_path.0.join(".git").join("index")).unwrap();
    assert!(matches!(
        backend.stage_patch(&repo_path, &selection, before).await,
        Err(GitError::PatchStale)
    ));
    assert_eq!(
        std::fs::read(repo_path.0.join(".git").join("index")).unwrap(),
        index_after,
        "reusing a stale selection must not stage anything else"
    );
}

#[tokio::test]
async fn stage_patch_stages_one_of_two_hunks_and_commit_records_only_that_hunk() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    let base = (1..=20)
        .map(|line| format!("line {line}"))
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    commit_fixture(&backend, &repo_path, &[("two-hunks.txt", base.as_bytes())]).await;
    let worktree = base
        .replace("line 2\n", "selected 2\n")
        .replace("line 19\n", "unstaged 19\n");
    let committed = base.replace("line 2\n", "selected 2\n");
    write_file(&repo_path, "two-hunks.txt", &worktree);

    let detail = backend
        .working_file_diff(&repo_path, "two-hunks.txt", false)
        .await
        .unwrap();
    assert_eq!(detail.hunks.len(), 2);
    let selection = whole_patch_selection(&detail, [0]);
    let generations = backend.generations(&repo_path).unwrap();
    backend
        .stage_patch(&repo_path, &selection, generations)
        .await
        .unwrap();

    assert_eq!(
        index_blob(&repo_path, "two-hunks.txt").unwrap(),
        committed.as_bytes()
    );
    assert_eq!(
        std::fs::read(repo_path.0.join("two-hunks.txt")).unwrap(),
        worktree.as_bytes()
    );
    let changes = backend.working_changes(&repo_path).await.unwrap();
    assert!(changes
        .staged
        .iter()
        .any(|file| file.path == "two-hunks.txt"));
    assert!(changes
        .unstaged
        .iter()
        .any(|file| file.path == "two-hunks.txt"));
    let cached = git_output(
        &backend,
        &repo_path,
        &["diff", "--cached", "--", "two-hunks.txt"],
    );
    let unstaged = git_output(&backend, &repo_path, &["diff", "--", "two-hunks.txt"]);
    assert!(String::from_utf8_lossy(&cached).contains("selected 2"));
    assert!(!String::from_utf8_lossy(&cached).contains("unstaged 19"));
    assert!(String::from_utf8_lossy(&unstaged).contains("unstaged 19"));

    backend.commit(&repo_path, "Selected hunk").await.unwrap();
    assert_eq!(head_blob(&repo_path, "two-hunks.txt"), committed.as_bytes());
    assert_eq!(
        std::fs::read(repo_path.0.join("two-hunks.txt")).unwrap(),
        worktree.as_bytes()
    );
}

#[tokio::test]
async fn stage_patch_stages_selected_lines_and_leaves_neighboring_changes_unstaged() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    let base = b"one\ntwo\nthree\nfour\nfive\n";
    let worktree = b"one\nTWO\nthree\nFOUR\nfive\n";
    let expected_index = b"one\nTWO\nthree\nfour\nfive\n";
    commit_fixture(&backend, &repo_path, &[("lines.txt", base)]).await;
    write_bytes(&repo_path, "lines.txt", worktree);

    let detail = backend
        .working_file_diff(&repo_path, "lines.txt", false)
        .await
        .unwrap();
    assert_eq!(detail.hunks.len(), 1);
    let selected_lines = detail.hunks[0]
        .lines
        .iter()
        .enumerate()
        .filter(|(_, line)| {
            line.kind != DiffLineKind::Context
                && (line.old_lineno == Some(2) || line.new_lineno == Some(2))
        })
        .map(|(index, _)| index as u32)
        .collect::<Vec<_>>();
    assert_eq!(selected_lines.len(), 2);
    let mut selection = whole_patch_selection(&detail, [0]);
    selection.hunks[0].lines = selected_lines;
    let generations = backend.generations(&repo_path).unwrap();
    backend
        .stage_patch(&repo_path, &selection, generations)
        .await
        .unwrap();

    assert_eq!(index_blob(&repo_path, "lines.txt").unwrap(), expected_index);
    assert_eq!(
        std::fs::read(repo_path.0.join("lines.txt")).unwrap(),
        worktree
    );
    let unstaged = git_output(&backend, &repo_path, &["diff", "--", "lines.txt"]);
    let unstaged = String::from_utf8_lossy(&unstaged);
    assert!(unstaged.lines().any(|line| line == "+FOUR"));
    assert!(!unstaged.lines().any(|line| matches!(line, "+TWO" | "-TWO")));
}

#[tokio::test]
async fn stage_patch_preserves_existing_staged_and_unrelated_changes() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    commit_fixture(
        &backend,
        &repo_path,
        &[
            ("target.txt", b"one\ntwo\nthree\nfour\nfive\n"),
            ("staged.txt", b"staged base\n"),
            ("unstaged.txt", b"unstaged base\n"),
        ],
    )
    .await;

    write_file(&repo_path, "target.txt", "one\nTWO\nthree\nfour\nfive\n");
    write_file(&repo_path, "staged.txt", "staged existing\n");
    backend
        .stage(
            &repo_path,
            &[PathBuf::from("target.txt"), PathBuf::from("staged.txt")],
        )
        .await
        .unwrap();
    let target_worktree = b"one\nTWO\nthree\nfour\nFIVE\n";
    let unstaged_worktree = b"unstaged outside selection\n";
    write_bytes(&repo_path, "target.txt", target_worktree);
    write_bytes(&repo_path, "unstaged.txt", unstaged_worktree);

    let staged_before = git_output(
        &backend,
        &repo_path,
        &["diff", "--cached", "--", "staged.txt"],
    );
    let unstaged_before = git_output(&backend, &repo_path, &["diff", "--", "unstaged.txt"]);
    let detail = backend
        .working_file_diff(&repo_path, "target.txt", false)
        .await
        .unwrap();
    let selection = whole_patch_selection(&detail, 0..detail.hunks.len());
    let generations = backend.generations(&repo_path).unwrap();
    backend
        .stage_patch(&repo_path, &selection, generations)
        .await
        .unwrap();

    assert_eq!(
        index_blob(&repo_path, "target.txt").unwrap(),
        target_worktree
    );
    assert_eq!(
        index_blob(&repo_path, "staged.txt").unwrap(),
        b"staged existing\n"
    );
    assert_eq!(
        index_blob(&repo_path, "unstaged.txt").unwrap(),
        b"unstaged base\n"
    );
    assert_eq!(
        git_output(
            &backend,
            &repo_path,
            &["diff", "--cached", "--", "staged.txt"]
        ),
        staged_before
    );
    assert_eq!(
        git_output(&backend, &repo_path, &["diff", "--", "unstaged.txt"]),
        unstaged_before
    );
    assert_eq!(
        std::fs::read(repo_path.0.join("target.txt")).unwrap(),
        target_worktree
    );
    assert_eq!(
        std::fs::read(repo_path.0.join("unstaged.txt")).unwrap(),
        unstaged_worktree
    );
}

#[tokio::test]
async fn stage_patch_rejects_stale_generation_and_external_diff_changes_without_mutation() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    commit_fixture(
        &backend,
        &repo_path,
        &[("target.txt", b"base\n"), ("other.txt", b"other base\n")],
    )
    .await;

    write_file(&repo_path, "target.txt", "selected\n");
    let detail = backend
        .working_file_diff(&repo_path, "target.txt", false)
        .await
        .unwrap();
    let selection = whole_patch_selection(&detail, 0..detail.hunks.len());
    let stale_generations = backend.generations(&repo_path).unwrap();
    write_file(&repo_path, "other.txt", "other staged\n");
    backend
        .stage(&repo_path, &[PathBuf::from("other.txt")])
        .await
        .unwrap();
    let index_after_other_change = std::fs::read(repo_path.0.join(".git").join("index")).unwrap();

    assert!(matches!(
        backend
            .stage_patch(&repo_path, &selection, stale_generations)
            .await,
        Err(GitError::PatchStale)
    ));
    assert_eq!(
        std::fs::read(repo_path.0.join(".git").join("index")).unwrap(),
        index_after_other_change
    );
    assert_eq!(index_blob(&repo_path, "target.txt").unwrap(), b"base\n");

    let current_generations = backend.generations(&repo_path).unwrap();
    let refreshed = backend
        .working_file_diff(&repo_path, "target.txt", false)
        .await
        .unwrap();
    let external_selection = whole_patch_selection(&refreshed, 0..refreshed.hunks.len());
    let index_before_external = std::fs::read(repo_path.0.join(".git").join("index")).unwrap();
    write_file(&repo_path, "target.txt", "changed after selection\n");

    assert!(matches!(
        backend
            .stage_patch(&repo_path, &external_selection, current_generations)
            .await,
        Err(GitError::PatchStale)
    ));
    assert_eq!(
        backend.generations(&repo_path).unwrap(),
        current_generations
    );
    assert_eq!(
        std::fs::read(repo_path.0.join(".git").join("index")).unwrap(),
        index_before_external
    );
    assert_eq!(
        std::fs::read(repo_path.0.join("target.txt")).unwrap(),
        b"changed after selection\n"
    );
}

#[tokio::test]
async fn stage_patch_apply_failures_and_unsupported_sources_do_not_bump_or_mutate() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    commit_fixture(
        &backend,
        &repo_path,
        &[("file.txt", b"base\n"), ("binary.dat", b"\0base")],
    )
    .await;
    write_file(&repo_path, "file.txt", "changed\n");
    write_bytes(&repo_path, "binary.dat", b"\0changed");
    let detail = backend
        .working_file_diff(&repo_path, "file.txt", false)
        .await
        .unwrap();
    let mut unsupported = whole_patch_selection(&detail, 0..detail.hunks.len());
    unsupported.source = PatchSource::Index;
    let generations = backend.generations(&repo_path).unwrap();
    let index_before = std::fs::read(repo_path.0.join(".git").join("index")).unwrap();

    assert!(matches!(
        backend
            .stage_patch(&repo_path, &unsupported, generations)
            .await,
        Err(GitError::PatchUnsupported(_))
    ));
    let binary = backend
        .working_file_diff(&repo_path, "binary.dat", false)
        .await
        .unwrap();
    assert!(binary.is_binary);
    let binary_selection = whole_patch_selection(&binary, 0..binary.hunks.len());
    assert!(matches!(
        backend
            .stage_patch(&repo_path, &binary_selection, generations)
            .await,
        Err(GitError::PatchUnsupported(_))
    ));
    assert!(matches!(
        working_tree::run_git_apply_to_index(
            &backend.commands,
            &repo_path,
            b"this is not a patch\n",
            false,
            false,
        ),
        Err(GitError::PatchApplyFailed(_))
    ));
    assert_eq!(backend.generations(&repo_path).unwrap(), generations);
    assert_eq!(
        std::fs::read(repo_path.0.join(".git").join("index")).unwrap(),
        index_before
    );
    assert_eq!(
        std::fs::read(repo_path.0.join("file.txt")).unwrap(),
        b"changed\n"
    );
    assert_eq!(
        std::fs::read(repo_path.0.join("binary.dat")).unwrap(),
        b"\0changed"
    );
}

#[tokio::test]
async fn stage_patch_preserves_crlf_and_missing_final_newline_bytes() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    commit_fixture(
        &backend,
        &repo_path,
        &[("eol.txt", b"old\r\nmiddle\r\nlast")],
    )
    .await;
    let worktree = b"new\r\nmiddle\r\nLAST";
    write_bytes(&repo_path, "eol.txt", worktree);
    let detail = backend
        .working_file_diff(&repo_path, "eol.txt", false)
        .await
        .unwrap();
    let selection = whole_patch_selection(&detail, 0..detail.hunks.len());
    let generations = backend.generations(&repo_path).unwrap();

    backend
        .stage_patch(&repo_path, &selection, generations)
        .await
        .unwrap();

    assert_eq!(index_blob(&repo_path, "eol.txt").unwrap(), worktree);
    assert_eq!(
        std::fs::read(repo_path.0.join("eol.txt")).unwrap(),
        worktree
    );
}

#[tokio::test]
async fn stage_patch_stages_added_and_deleted_files() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    commit_fixture(&backend, &repo_path, &[("deleted.txt", b"remove me\n")]).await;
    write_file(&repo_path, "added.txt", "add me\n");
    std::fs::remove_file(repo_path.0.join("deleted.txt")).unwrap();

    let added = backend
        .working_file_diff(&repo_path, "added.txt", false)
        .await
        .unwrap();
    let added_selection = whole_patch_selection(&added, 0..added.hunks.len());
    let generations = backend.generations(&repo_path).unwrap();
    let after_added = backend
        .stage_patch(&repo_path, &added_selection, generations)
        .await
        .unwrap();
    assert_eq!(index_blob(&repo_path, "added.txt").unwrap(), b"add me\n");
    assert_eq!(
        std::fs::read(repo_path.0.join("added.txt")).unwrap(),
        b"add me\n"
    );

    let deleted = backend
        .working_file_diff(&repo_path, "deleted.txt", false)
        .await
        .unwrap();
    let deleted_selection = whole_patch_selection(&deleted, 0..deleted.hunks.len());
    let after_deleted = backend
        .stage_patch(&repo_path, &deleted_selection, after_added)
        .await
        .unwrap();
    assert!(index_blob(&repo_path, "deleted.txt").is_none());
    assert!(!repo_path.0.join("deleted.txt").exists());
    assert_eq!(after_deleted.working_tree, after_added.working_tree + 1);
    let cached = git_output(&backend, &repo_path, &["diff", "--cached", "--name-status"]);
    let cached = String::from_utf8_lossy(&cached);
    assert!(cached.contains("A\tadded.txt"));
    assert!(cached.contains("D\tdeleted.txt"));
}

/// P8 audit finding #7. Added/deleted files use file creation/deletion headers
/// only when the requested operation has whole-file semantics. Partial
/// selections must preserve every unselected byte instead of depending on
/// `git apply` to reject an invalid whole-file patch.
#[tokio::test]
async fn partial_added_and_deleted_patch_operations_preserve_exact_file_state() {
    // Added: stage the middle line only.
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    commit_fixture(&backend, &repo_path, &[("base.txt", b"base\n")]).await;
    write_bytes(&repo_path, "added.txt", b"one\ntwo\nthree\n");
    let detail = backend
        .working_file_diff(&repo_path, "added.txt", false)
        .await
        .unwrap();
    let mut selection = whole_patch_selection(&detail, [0]);
    selection.hunks[0].lines = vec![1];
    let before = backend.generations(&repo_path).unwrap();
    let after = backend
        .stage_patch(&repo_path, &selection, before)
        .await
        .unwrap();
    assert_eq!(index_blob(&repo_path, "added.txt").unwrap(), b"two\n");
    assert_eq!(
        std::fs::read(repo_path.0.join("added.txt")).unwrap(),
        b"one\ntwo\nthree\n"
    );
    assert_eq!(git_output(&backend, &repo_path, &["diff", "--cached", "--", "added.txt"]), b"diff --git a/added.txt b/added.txt\nnew file mode 100644\nindex 0000000..f719efd\n--- /dev/null\n+++ b/added.txt\n@@ -0,0 +1 @@\n+two\n");
    assert_eq!(after.working_tree, before.working_tree + 1);

    // Added: unstage and discard the middle line without removing the file.
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    commit_fixture(&backend, &repo_path, &[("base.txt", b"base\n")]).await;
    write_bytes(&repo_path, "added.txt", b"one\ntwo\nthree\n");
    backend
        .stage(&repo_path, &[PathBuf::from("added.txt")])
        .await
        .unwrap();
    let staged = backend
        .working_file_diff(&repo_path, "added.txt", true)
        .await
        .unwrap();
    let mut unstage = staged_patch_selection(&staged, [0]);
    unstage.hunks[0].lines = vec![1];
    let before = backend.generations(&repo_path).unwrap();
    let after = backend
        .unstage_patch(&repo_path, &unstage, before)
        .await
        .unwrap();
    assert_eq!(
        index_blob(&repo_path, "added.txt").unwrap(),
        b"one\nthree\n"
    );
    assert_eq!(
        std::fs::read(repo_path.0.join("added.txt")).unwrap(),
        b"one\ntwo\nthree\n"
    );
    assert_eq!(after.working_tree, before.working_tree + 1);
    let detail = backend
        .working_file_diff(&repo_path, "added.txt", false)
        .await
        .unwrap();
    let mut discard = whole_patch_selection(&detail, [0]);
    discard.hunks[0].lines = vec![1];
    let before = backend.generations(&repo_path).unwrap();
    let after = discard_confirmed(&backend, &repo_path, &discard, before)
        .await
        .unwrap();
    assert_eq!(
        std::fs::read(repo_path.0.join("added.txt")).unwrap(),
        b"one\nthree\n"
    );
    assert_eq!(
        index_blob(&repo_path, "added.txt").unwrap(),
        b"one\nthree\n"
    );
    assert_eq!(after.working_tree, before.working_tree + 1);

    // Deleted: stage the middle deletion only.
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    commit_fixture(
        &backend,
        &repo_path,
        &[("deleted.txt", b"one\ntwo\nthree\n")],
    )
    .await;
    std::fs::remove_file(repo_path.0.join("deleted.txt")).unwrap();
    let detail = backend
        .working_file_diff(&repo_path, "deleted.txt", false)
        .await
        .unwrap();
    let mut selection = whole_patch_selection(&detail, [0]);
    selection.hunks[0].lines = vec![1];
    let before = backend.generations(&repo_path).unwrap();
    let after = backend
        .stage_patch(&repo_path, &selection, before)
        .await
        .unwrap();
    assert_eq!(
        index_blob(&repo_path, "deleted.txt").unwrap(),
        b"one\nthree\n"
    );
    assert!(!repo_path.0.join("deleted.txt").exists());
    assert_eq!(after.working_tree, before.working_tree + 1);

    // Deleted: partial unstage is intentionally unsupported: reverse apply
    // would otherwise restore more than the selected deletion. It must fail
    // before any Git mutation or generation advance.
    let staged = backend
        .working_file_diff(&repo_path, "deleted.txt", true)
        .await
        .unwrap();
    let mut unstage = staged_patch_selection(&staged, [0]);
    unstage.hunks[0].lines = vec![0];
    let before = backend.generations(&repo_path).unwrap();
    let index_before = index_blob(&repo_path, "deleted.txt");
    assert!(matches!(
        backend.unstage_patch(&repo_path, &unstage, before).await,
        Err(GitError::PatchUnsupported(_))
    ));
    assert_eq!(index_blob(&repo_path, "deleted.txt"), index_before);
    assert!(!repo_path.0.join("deleted.txt").exists());
    assert_eq!(backend.generations(&repo_path).unwrap(), before);

    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    commit_fixture(
        &backend,
        &repo_path,
        &[("deleted.txt", b"one\ntwo\nthree\n")],
    )
    .await;
    std::fs::remove_file(repo_path.0.join("deleted.txt")).unwrap();
    let detail = backend
        .working_file_diff(&repo_path, "deleted.txt", false)
        .await
        .unwrap();
    let mut discard = whole_patch_selection(&detail, [0]);
    discard.hunks[0].lines = vec![detail.hunks[0]
        .lines
        .iter()
        .position(|line| line.kind == DiffLineKind::Deletion && line.content == "two")
        .unwrap() as u32];
    let before = backend.generations(&repo_path).unwrap();
    let after = discard_confirmed(&backend, &repo_path, &discard, before)
        .await
        .unwrap();
    assert_eq!(
        std::fs::read(repo_path.0.join("deleted.txt")).unwrap(),
        b"two\n"
    );
    assert_eq!(
        index_blob(&repo_path, "deleted.txt").unwrap(),
        b"one\ntwo\nthree\n"
    );
    assert_eq!(after.working_tree, before.working_tree + 1);
}

#[tokio::test]
async fn unstage_patch_removes_a_complete_hunk_without_touching_the_worktree() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    let base = b"one\ntwo\nthree\n";
    let worktree = b"one\nTWO\nthree\n";
    commit_fixture(&backend, &repo_path, &[("file.txt", base)]).await;
    write_bytes(&repo_path, "file.txt", worktree);
    backend
        .stage(&repo_path, &[PathBuf::from("file.txt")])
        .await
        .unwrap();

    let detail = backend
        .working_file_diff(&repo_path, "file.txt", true)
        .await
        .unwrap();
    let selection = staged_patch_selection(&detail, 0..detail.hunks.len());
    let before = backend.generations(&repo_path).unwrap();
    let after = backend
        .unstage_patch(&repo_path, &selection, before)
        .await
        .unwrap();

    assert_eq!(index_blob(&repo_path, "file.txt").unwrap(), base);
    assert_eq!(
        std::fs::read(repo_path.0.join("file.txt")).unwrap(),
        worktree
    );
    assert_eq!(after.working_tree, before.working_tree + 1);
    assert_eq!(after.refs, before.refs);
    assert_eq!(after.history, before.history);
    assert_eq!(after.stash, before.stash);
    assert_eq!(after.config, before.config);
    assert!(git_output(
        &backend,
        &repo_path,
        &["diff", "--cached", "--", "file.txt"]
    )
    .is_empty());
    assert!(String::from_utf8_lossy(&git_output(
        &backend,
        &repo_path,
        &["diff", "--", "file.txt"],
    ))
    .contains("TWO"));

    let index_after = std::fs::read(repo_path.0.join(".git").join("index")).unwrap();
    assert!(matches!(
        backend.unstage_patch(&repo_path, &selection, before).await,
        Err(GitError::PatchStale)
    ));
    assert_eq!(
        std::fs::read(repo_path.0.join(".git").join("index")).unwrap(),
        index_after
    );
}

#[tokio::test]
async fn unstage_patch_removes_one_of_two_staged_hunks() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    let base = (1..=20)
        .map(|line| format!("line {line}"))
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    let worktree = base
        .replace("line 2\n", "unstaged 2\n")
        .replace("line 19\n", "kept staged 19\n");
    let expected_index = base.replace("line 19\n", "kept staged 19\n");
    commit_fixture(&backend, &repo_path, &[("two-hunks.txt", base.as_bytes())]).await;
    write_file(&repo_path, "two-hunks.txt", &worktree);
    backend
        .stage(&repo_path, &[PathBuf::from("two-hunks.txt")])
        .await
        .unwrap();

    let detail = backend
        .working_file_diff(&repo_path, "two-hunks.txt", true)
        .await
        .unwrap();
    assert_eq!(detail.hunks.len(), 2);
    let selection = staged_patch_selection(&detail, [0]);
    let generations = backend.generations(&repo_path).unwrap();
    backend
        .unstage_patch(&repo_path, &selection, generations)
        .await
        .unwrap();

    assert_eq!(
        index_blob(&repo_path, "two-hunks.txt").unwrap(),
        expected_index.as_bytes()
    );
    assert_eq!(
        std::fs::read(repo_path.0.join("two-hunks.txt")).unwrap(),
        worktree.as_bytes()
    );
    let cached = String::from_utf8_lossy(&git_output(
        &backend,
        &repo_path,
        &["diff", "--cached", "--", "two-hunks.txt"],
    ))
    .into_owned();
    let unstaged = String::from_utf8_lossy(&git_output(
        &backend,
        &repo_path,
        &["diff", "--", "two-hunks.txt"],
    ))
    .into_owned();
    assert!(cached.contains("kept staged 19"));
    assert!(!cached.contains("unstaged 2"));
    assert!(unstaged.contains("unstaged 2"));
    assert!(!unstaged.contains("kept staged 19"));
}

#[tokio::test]
async fn unstage_patch_removes_selected_lines_and_keeps_other_staged_lines() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    let base = b"one\ntwo\nthree\nfour\nfive\n";
    let worktree = b"one\nTWO\nthree\nFOUR\nfive\n";
    let expected_index = b"one\ntwo\nthree\nFOUR\nfive\n";
    commit_fixture(&backend, &repo_path, &[("lines.txt", base)]).await;
    write_bytes(&repo_path, "lines.txt", worktree);
    backend
        .stage(&repo_path, &[PathBuf::from("lines.txt")])
        .await
        .unwrap();

    let detail = backend
        .working_file_diff(&repo_path, "lines.txt", true)
        .await
        .unwrap();
    let selected_lines = detail.hunks[0]
        .lines
        .iter()
        .enumerate()
        .filter(|(_, line)| {
            line.kind != DiffLineKind::Context
                && (line.old_lineno == Some(2) || line.new_lineno == Some(2))
        })
        .map(|(index, _)| index as u32)
        .collect::<Vec<_>>();
    assert_eq!(selected_lines.len(), 2);
    let mut selection = staged_patch_selection(&detail, [0]);
    selection.hunks[0].lines = selected_lines;
    let generations = backend.generations(&repo_path).unwrap();
    backend
        .unstage_patch(&repo_path, &selection, generations)
        .await
        .unwrap();

    assert_eq!(index_blob(&repo_path, "lines.txt").unwrap(), expected_index);
    assert_eq!(
        std::fs::read(repo_path.0.join("lines.txt")).unwrap(),
        worktree
    );
    let cached = String::from_utf8_lossy(&git_output(
        &backend,
        &repo_path,
        &["diff", "--cached", "--", "lines.txt"],
    ))
    .into_owned();
    let unstaged = String::from_utf8_lossy(&git_output(
        &backend,
        &repo_path,
        &["diff", "--", "lines.txt"],
    ))
    .into_owned();
    assert!(cached.lines().any(|line| line == "+FOUR"));
    assert!(!cached.lines().any(|line| matches!(line, "+TWO" | "-TWO")));
    assert!(unstaged.lines().any(|line| line == "+TWO"));
    assert!(!unstaged
        .lines()
        .any(|line| matches!(line, "+FOUR" | "-FOUR")));
}

#[tokio::test]
async fn unstage_patch_preserves_mixed_and_unrelated_staged_and_unstaged_state() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    commit_fixture(
        &backend,
        &repo_path,
        &[
            ("target.txt", b"one\ntwo\nthree\nfour\nfive\n"),
            ("staged.txt", b"staged base\n"),
            ("unstaged.txt", b"unstaged base\n"),
        ],
    )
    .await;
    write_file(&repo_path, "target.txt", "one\nTWO\nthree\nfour\nfive\n");
    write_file(&repo_path, "staged.txt", "staged outside selection\n");
    backend
        .stage(
            &repo_path,
            &[PathBuf::from("target.txt"), PathBuf::from("staged.txt")],
        )
        .await
        .unwrap();
    let target_worktree = b"one\nTWO\nthree\nfour\nFIVE\n";
    let unrelated_worktree = b"unstaged outside selection\n";
    write_bytes(&repo_path, "target.txt", target_worktree);
    write_bytes(&repo_path, "unstaged.txt", unrelated_worktree);

    let staged_before = git_output(
        &backend,
        &repo_path,
        &["diff", "--cached", "--", "staged.txt"],
    );
    let unrelated_before = git_output(&backend, &repo_path, &["diff", "--", "unstaged.txt"]);
    let detail = backend
        .working_file_diff(&repo_path, "target.txt", true)
        .await
        .unwrap();
    let selection = staged_patch_selection(&detail, 0..detail.hunks.len());
    let generations = backend.generations(&repo_path).unwrap();
    backend
        .unstage_patch(&repo_path, &selection, generations)
        .await
        .unwrap();

    assert_eq!(
        index_blob(&repo_path, "target.txt").unwrap(),
        b"one\ntwo\nthree\nfour\nfive\n"
    );
    assert_eq!(
        index_blob(&repo_path, "staged.txt").unwrap(),
        b"staged outside selection\n"
    );
    assert_eq!(
        git_output(
            &backend,
            &repo_path,
            &["diff", "--cached", "--", "staged.txt"]
        ),
        staged_before
    );
    assert_eq!(
        git_output(&backend, &repo_path, &["diff", "--", "unstaged.txt"]),
        unrelated_before
    );
    assert_eq!(
        std::fs::read(repo_path.0.join("target.txt")).unwrap(),
        target_worktree
    );
    assert_eq!(
        std::fs::read(repo_path.0.join("unstaged.txt")).unwrap(),
        unrelated_worktree
    );
    let target_unstaged = String::from_utf8_lossy(&git_output(
        &backend,
        &repo_path,
        &["diff", "--", "target.txt"],
    ))
    .into_owned();
    assert!(target_unstaged.contains("TWO"));
    assert!(target_unstaged.contains("FIVE"));
}

#[tokio::test]
async fn unstage_patch_rejects_stale_generation_and_external_index_changes() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    commit_fixture(
        &backend,
        &repo_path,
        &[("target.txt", b"base\n"), ("other.txt", b"other base\n")],
    )
    .await;
    write_file(&repo_path, "target.txt", "selected\n");
    backend
        .stage(&repo_path, &[PathBuf::from("target.txt")])
        .await
        .unwrap();
    let detail = backend
        .working_file_diff(&repo_path, "target.txt", true)
        .await
        .unwrap();
    let selection = staged_patch_selection(&detail, 0..detail.hunks.len());
    let stale_generations = backend.generations(&repo_path).unwrap();
    write_file(&repo_path, "other.txt", "other staged\n");
    backend
        .stage(&repo_path, &[PathBuf::from("other.txt")])
        .await
        .unwrap();
    let index_after_other_change = std::fs::read(repo_path.0.join(".git").join("index")).unwrap();

    assert!(matches!(
        backend
            .unstage_patch(&repo_path, &selection, stale_generations)
            .await,
        Err(GitError::PatchStale)
    ));
    assert_eq!(
        std::fs::read(repo_path.0.join(".git").join("index")).unwrap(),
        index_after_other_change
    );

    let current_generations = backend.generations(&repo_path).unwrap();
    let refreshed = backend
        .working_file_diff(&repo_path, "target.txt", true)
        .await
        .unwrap();
    let external_selection = staged_patch_selection(&refreshed, 0..refreshed.hunks.len());
    write_file(&repo_path, "target.txt", "changed externally\n");
    run_git_success(&backend, &repo_path, &["add", "target.txt"]);
    let index_before_external = std::fs::read(repo_path.0.join(".git").join("index")).unwrap();

    assert!(matches!(
        backend
            .unstage_patch(&repo_path, &external_selection, current_generations)
            .await,
        Err(GitError::PatchStale)
    ));
    assert_eq!(
        backend.generations(&repo_path).unwrap(),
        current_generations
    );
    assert_eq!(
        std::fs::read(repo_path.0.join(".git").join("index")).unwrap(),
        index_before_external
    );
    assert_eq!(
        std::fs::read(repo_path.0.join("target.txt")).unwrap(),
        b"changed externally\n"
    );
}

#[tokio::test]
async fn unstage_patch_reverse_failures_and_unsupported_selections_do_not_bump() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    commit_fixture(
        &backend,
        &repo_path,
        &[("file.txt", b"base\n"), ("binary.dat", b"\0base")],
    )
    .await;
    write_file(&repo_path, "file.txt", "changed\n");
    write_bytes(&repo_path, "binary.dat", b"\0changed");
    backend
        .stage(
            &repo_path,
            &[PathBuf::from("file.txt"), PathBuf::from("binary.dat")],
        )
        .await
        .unwrap();
    let detail = backend
        .working_file_diff(&repo_path, "file.txt", true)
        .await
        .unwrap();
    let mut unsupported = staged_patch_selection(&detail, 0..detail.hunks.len());
    unsupported.source = PatchSource::Worktree;
    let generations = backend.generations(&repo_path).unwrap();
    let index_before = std::fs::read(repo_path.0.join(".git").join("index")).unwrap();

    assert!(matches!(
        backend
            .unstage_patch(&repo_path, &unsupported, generations)
            .await,
        Err(GitError::PatchUnsupported(_))
    ));
    let binary = backend
        .working_file_diff(&repo_path, "binary.dat", true)
        .await
        .unwrap();
    assert!(binary.is_binary);
    let binary_selection = staged_patch_selection(&binary, 0..binary.hunks.len());
    assert!(matches!(
        backend
            .unstage_patch(&repo_path, &binary_selection, generations)
            .await,
        Err(GitError::PatchUnsupported(_))
    ));
    assert!(matches!(
        working_tree::run_git_apply_to_index(
            &backend.commands,
            &repo_path,
            b"this is not a patch\n",
            false,
            true,
        ),
        Err(GitError::PatchApplyFailed(_))
    ));
    assert_eq!(backend.generations(&repo_path).unwrap(), generations);
    assert_eq!(
        std::fs::read(repo_path.0.join(".git").join("index")).unwrap(),
        index_before
    );
    assert_eq!(
        std::fs::read(repo_path.0.join("file.txt")).unwrap(),
        b"changed\n"
    );
}

#[tokio::test]
async fn unstage_patch_preserves_crlf_and_missing_final_newline_and_reverses_file_states() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    let base = b"old\r\nmiddle\r\nlast";
    let worktree = b"new\r\nmiddle\r\nLAST";
    commit_fixture(
        &backend,
        &repo_path,
        &[("eol.txt", base), ("deleted.txt", b"remove me\n")],
    )
    .await;
    write_bytes(&repo_path, "eol.txt", worktree);
    write_file(&repo_path, "added.txt", "add me\n");
    std::fs::remove_file(repo_path.0.join("deleted.txt")).unwrap();
    backend
        .stage(
            &repo_path,
            &[
                PathBuf::from("eol.txt"),
                PathBuf::from("added.txt"),
                PathBuf::from("deleted.txt"),
            ],
        )
        .await
        .unwrap();

    let eol = backend
        .working_file_diff(&repo_path, "eol.txt", true)
        .await
        .unwrap();
    let eol_selection = staged_patch_selection(&eol, 0..eol.hunks.len());
    let after_eol = backend
        .unstage_patch(
            &repo_path,
            &eol_selection,
            backend.generations(&repo_path).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(index_blob(&repo_path, "eol.txt").unwrap(), base);
    assert_eq!(
        std::fs::read(repo_path.0.join("eol.txt")).unwrap(),
        worktree
    );

    let added = backend
        .working_file_diff(&repo_path, "added.txt", true)
        .await
        .unwrap();
    let added_selection = staged_patch_selection(&added, 0..added.hunks.len());
    let after_added = backend
        .unstage_patch(&repo_path, &added_selection, after_eol)
        .await
        .unwrap();
    assert!(index_blob(&repo_path, "added.txt").is_none());
    assert_eq!(
        std::fs::read(repo_path.0.join("added.txt")).unwrap(),
        b"add me\n"
    );

    let deleted = backend
        .working_file_diff(&repo_path, "deleted.txt", true)
        .await
        .unwrap();
    let deleted_selection = staged_patch_selection(&deleted, 0..deleted.hunks.len());
    let after_deleted = backend
        .unstage_patch(&repo_path, &deleted_selection, after_added)
        .await
        .unwrap();
    assert_eq!(
        index_blob(&repo_path, "deleted.txt").unwrap(),
        b"remove me\n"
    );
    assert!(!repo_path.0.join("deleted.txt").exists());
    assert_eq!(after_deleted.working_tree, after_added.working_tree + 1);
}

/// P8 safety finding #2. `apply.whitespace=fix` must not rewrite the
/// backend-constructed patch, and `apply.ignoreWhitespace` must not relax the
/// exact-context contract that the checked patch is applied under.
#[tokio::test]
async fn patch_apply_is_deterministic_under_hostile_apply_configuration() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    // This one file covers CRLF, a missing final newline, trailing spaces,
    // tabs, and a whitespace-only replacement.
    let base = b"first\r\ncontext\t \r\nchanged old \t\r\n \t \r\nlast";
    let changed = b"first\r\ncontext\t \r\nchanged new \t \r\n\t  \r\nlast";
    commit_fixture(&backend, &repo_path, &[("whitespace.txt", base)]).await;
    set_hostile_apply_config(&repo_path);
    write_bytes(&repo_path, "whitespace.txt", changed);

    // Each operation runs its own `--check` then mutation internally. Exact
    // bytes prove that neither invocation honored the hostile rewrite setting.
    let unstaged = backend
        .working_file_diff(&repo_path, "whitespace.txt", false)
        .await
        .unwrap();
    let stage_selection = whole_patch_selection(&unstaged, 0..unstaged.hunks.len());
    let stage_patch = patch::build_unified_patch(&unstaged, &stage_selection).unwrap();
    assert_patch_applies_without_mutation(&backend, &repo_path, &stage_patch);
    backend
        .stage_patch(
            &repo_path,
            &stage_selection,
            backend.generations(&repo_path).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(index_blob(&repo_path, "whitespace.txt").unwrap(), changed);
    assert_eq!(
        std::fs::read(repo_path.0.join("whitespace.txt")).unwrap(),
        changed
    );

    let staged = backend
        .working_file_diff(&repo_path, "whitespace.txt", true)
        .await
        .unwrap();
    let unstage_selection = staged_patch_selection(&staged, 0..staged.hunks.len());
    backend
        .unstage_patch(
            &repo_path,
            &unstage_selection,
            backend.generations(&repo_path).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(index_blob(&repo_path, "whitespace.txt").unwrap(), base);
    assert_eq!(
        std::fs::read(repo_path.0.join("whitespace.txt")).unwrap(),
        changed
    );

    let unstaged = backend
        .working_file_diff(&repo_path, "whitespace.txt", false)
        .await
        .unwrap();
    let discard_selection = whole_patch_selection(&unstaged, 0..unstaged.hunks.len());
    discard_confirmed(
        &backend,
        &repo_path,
        &discard_selection,
        backend.generations(&repo_path).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(index_blob(&repo_path, "whitespace.txt").unwrap(), base);
    assert_eq!(
        std::fs::read(repo_path.0.join("whitespace.txt")).unwrap(),
        base
    );
}

#[tokio::test]
async fn the_same_generated_patch_has_identical_checked_and_applied_bytes_across_apply_configs() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    let base = b"base \t\r\nwhitespace only\r\nlast";
    let changed = b"base \t \r\n \t \r\nlast";
    commit_fixture(&backend, &repo_path, &[("same-patch.txt", base)]).await;
    write_bytes(&repo_path, "same-patch.txt", changed);
    let detail = backend
        .working_file_diff(&repo_path, "same-patch.txt", false)
        .await
        .unwrap();
    let selection = whole_patch_selection(&detail, 0..detail.hunks.len());
    let patch = patch::build_unified_patch(&detail, &selection).unwrap();

    set_apply_whitespace_config(&repo_path, "warn");
    working_tree::run_git_apply_to_index(&backend.commands, &repo_path, &patch, true, false)
        .unwrap();
    working_tree::run_git_apply_to_index(&backend.commands, &repo_path, &patch, false, false)
        .unwrap();
    let ordinary_index = index_blob(&repo_path, "same-patch.txt").unwrap();

    // Reset only the temporary test index, retaining the identical worktree,
    // backend instance, and exact generated patch for the hostile-config run.
    backend
        .unstage(&repo_path, &[PathBuf::from("same-patch.txt")])
        .await
        .unwrap();
    assert_eq!(index_blob(&repo_path, "same-patch.txt").unwrap(), base);
    set_hostile_apply_config(&repo_path);
    working_tree::run_git_apply_to_index(&backend.commands, &repo_path, &patch, true, false)
        .unwrap();
    working_tree::run_git_apply_to_index(&backend.commands, &repo_path, &patch, false, false)
        .unwrap();

    assert_eq!(ordinary_index, changed);
    assert_eq!(
        index_blob(&repo_path, "same-patch.txt").unwrap(),
        ordinary_index
    );
    assert_eq!(
        std::fs::read(repo_path.0.join("same-patch.txt")).unwrap(),
        changed
    );
}

#[tokio::test]
async fn discard_patch_discards_one_hunk_and_preserves_everything_else() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    let base = (1..=30)
        .map(|line| format!("line {line}"))
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    commit_fixture(
        &backend,
        &repo_path,
        &[
            ("target.txt", base.as_bytes()),
            ("other.txt", b"other base\n"),
        ],
    )
    .await;
    let worktree = base
        .replace("line 2\n", "discard me\n")
        .replace("line 29\n", "keep me\n");
    write_file(&repo_path, "target.txt", &worktree);
    write_file(
        &repo_path,
        "other.txt",
        "untouched bytes\r\nwithout final newline",
    );
    let other_before = std::fs::read(repo_path.0.join("other.txt")).unwrap();
    let cached_before = git_output(&backend, &repo_path, &["diff", "--cached"]);
    let detail = backend
        .working_file_diff(&repo_path, "target.txt", false)
        .await
        .unwrap();
    assert_eq!(detail.hunks.len(), 2);
    let selection = whole_patch_selection(&detail, [0]);
    let before = backend.generations(&repo_path).unwrap();

    let after = discard_confirmed(&backend, &repo_path, &selection, before)
        .await
        .unwrap();

    assert_eq!(
        std::fs::read_to_string(repo_path.0.join("target.txt")).unwrap(),
        base.replace("line 29\n", "keep me\n")
    );
    assert_eq!(
        std::fs::read(repo_path.0.join("other.txt")).unwrap(),
        other_before
    );
    assert_eq!(
        git_output(&backend, &repo_path, &["diff", "--cached"]),
        cached_before
    );
    assert_eq!(after.working_tree, before.working_tree + 1);
    assert_eq!(after.refs, before.refs);
    assert_eq!(after.history, before.history);
    assert_eq!(after.stash, before.stash);
    assert_eq!(after.config, before.config);
}

#[tokio::test]
async fn discard_patch_preserves_staged_changes_under_selected_unstaged_lines() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    let base = (1..=30)
        .map(|line| format!("line {line}"))
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    commit_fixture(
        &backend,
        &repo_path,
        &[("mixed.txt", base.as_bytes()), ("unrelated.txt", b"base\n")],
    )
    .await;

    let staged = base.replace("line 2\n", "staged S\n");
    write_file(&repo_path, "mixed.txt", &staged);
    backend
        .stage(&repo_path, &[PathBuf::from("mixed.txt")])
        .await
        .unwrap();
    let worktree = staged
        .replace("line 10\n", "discard U1\n")
        .replace("line 29\n", "keep U2\n");
    write_file(&repo_path, "mixed.txt", &worktree);
    write_file(&repo_path, "unrelated.txt", "unrelated unstaged\n");
    let cached_before = git_output(&backend, &repo_path, &["diff", "--cached"]);
    let unrelated_before = std::fs::read(repo_path.0.join("unrelated.txt")).unwrap();
    let detail = backend
        .working_file_diff(&repo_path, "mixed.txt", false)
        .await
        .unwrap();
    assert_eq!(detail.hunks.len(), 2);
    let selected_lines = detail.hunks[0]
        .lines
        .iter()
        .enumerate()
        .filter(|(_, line)| line.kind != DiffLineKind::Context)
        .map(|(index, _)| index as u32)
        .collect::<Vec<_>>();
    let mut selection = whole_patch_selection(&detail, [0]);
    selection.hunks[0].lines = selected_lines;
    let before = backend.generations(&repo_path).unwrap();

    discard_confirmed(&backend, &repo_path, &selection, before)
        .await
        .unwrap();

    let expected_worktree = staged.replace("line 29\n", "keep U2\n");
    assert_eq!(
        index_blob(&repo_path, "mixed.txt").unwrap(),
        staged.as_bytes()
    );
    assert_eq!(
        std::fs::read(repo_path.0.join("mixed.txt")).unwrap(),
        expected_worktree.as_bytes()
    );
    assert_eq!(
        git_output(&backend, &repo_path, &["diff", "--cached"]),
        cached_before
    );
    assert_eq!(
        std::fs::read(repo_path.0.join("unrelated.txt")).unwrap(),
        unrelated_before
    );
}

#[tokio::test]
async fn discard_patch_handles_individual_added_and_deleted_lines_in_a_replacement() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    commit_fixture(
        &backend,
        &repo_path,
        &[("replacement.txt", b"before\nold-a\nold-b\nafter\n")],
    )
    .await;
    write_file(
        &repo_path,
        "replacement.txt",
        "before\nnew-a\nnew-b\nafter\n",
    );

    let detail = backend
        .working_file_diff(&repo_path, "replacement.txt", false)
        .await
        .unwrap();
    let new_a = detail.hunks[0]
        .lines
        .iter()
        .position(|line| line.kind == DiffLineKind::Addition && line.content == "new-a")
        .unwrap() as u32;
    let mut remove_added = whole_patch_selection(&detail, [0]);
    remove_added.hunks[0].lines = vec![new_a];
    let after_added = discard_confirmed(
        &backend,
        &repo_path,
        &remove_added,
        backend.generations(&repo_path).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(
        std::fs::read(repo_path.0.join("replacement.txt")).unwrap(),
        b"before\nnew-b\nafter\n"
    );

    let detail = backend
        .working_file_diff(&repo_path, "replacement.txt", false)
        .await
        .unwrap();
    let old_a = detail.hunks[0]
        .lines
        .iter()
        .position(|line| line.kind == DiffLineKind::Deletion && line.content == "old-a")
        .unwrap() as u32;
    let mut restore_deleted = whole_patch_selection(&detail, [0]);
    restore_deleted.hunks[0].lines = vec![old_a];
    discard_confirmed(&backend, &repo_path, &restore_deleted, after_added)
        .await
        .unwrap();
    assert_eq!(
        std::fs::read(repo_path.0.join("replacement.txt")).unwrap(),
        b"before\nold-a\nnew-b\nafter\n"
    );
}

#[tokio::test]
async fn discard_patch_preserves_crlf_final_newline_state_and_supports_file_add_delete() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    commit_fixture(
        &backend,
        &repo_path,
        &[
            ("eol.txt", b"first\r\nmiddle\r\nlast"),
            ("deleted.txt", b"restore me\n"),
        ],
    )
    .await;
    write_bytes(&repo_path, "eol.txt", b"FIRST\r\nmiddle\r\nLAST");
    write_file(&repo_path, "added.txt", "remove me\n");
    std::fs::remove_file(repo_path.0.join("deleted.txt")).unwrap();

    for path in ["eol.txt", "added.txt", "deleted.txt"] {
        let detail = backend
            .working_file_diff(&repo_path, path, false)
            .await
            .unwrap();
        let selection = whole_patch_selection(&detail, 0..detail.hunks.len());
        discard_confirmed(
            &backend,
            &repo_path,
            &selection,
            backend.generations(&repo_path).unwrap(),
        )
        .await
        .unwrap();
    }

    assert_eq!(
        std::fs::read(repo_path.0.join("eol.txt")).unwrap(),
        b"first\r\nmiddle\r\nlast"
    );
    assert!(!repo_path.0.join("added.txt").exists());
    assert_eq!(
        std::fs::read(repo_path.0.join("deleted.txt")).unwrap(),
        b"restore me\n"
    );
}

#[tokio::test]
async fn discard_patch_stale_and_unsupported_failures_are_atomic() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    commit_fixture(
        &backend,
        &repo_path,
        &[
            ("target.txt", b"base\n"),
            ("other.txt", b"other\n"),
            ("binary.dat", b"\0base"),
        ],
    )
    .await;
    write_file(&repo_path, "target.txt", "selected\n");
    write_bytes(&repo_path, "binary.dat", b"\0changed");
    let detail = backend
        .working_file_diff(&repo_path, "target.txt", false)
        .await
        .unwrap();
    let selection = whole_patch_selection(&detail, 0..detail.hunks.len());
    let stale_generations = backend.generations(&repo_path).unwrap();
    let (stale_action, stale_token) =
        issue_discard_confirmation(&backend, &repo_path, &selection, stale_generations).await;
    write_file(&repo_path, "other.txt", "staged elsewhere\n");
    backend
        .stage(&repo_path, &[PathBuf::from("other.txt")])
        .await
        .unwrap();

    let assert_unchanged = |expected_generation: GenerationSet,
                            worktree: Vec<u8>,
                            cached: Vec<u8>,
                            unstaged: Vec<u8>| {
        assert_eq!(
            backend.generations(&repo_path).unwrap(),
            expected_generation
        );
        assert_eq!(
            std::fs::read(repo_path.0.join("target.txt")).unwrap(),
            worktree
        );
        assert_eq!(
            git_output(&backend, &repo_path, &["diff", "--cached"]),
            cached
        );
        assert_eq!(git_output(&backend, &repo_path, &["diff"]), unstaged);
    };
    let current = backend.generations(&repo_path).unwrap();
    let worktree_before = std::fs::read(repo_path.0.join("target.txt")).unwrap();
    let cached_before = git_output(&backend, &repo_path, &["diff", "--cached"]);
    let unstaged_before = git_output(&backend, &repo_path, &["diff"]);
    assert!(matches!(
        backend
            .discard_patch(
                &repo_path,
                &stale_action,
                &selection,
                stale_generations,
                &stale_token,
            )
            .await,
        Err(GitError::PreflightStale)
    ));
    assert_unchanged(
        current,
        worktree_before.clone(),
        cached_before.clone(),
        unstaged_before.clone(),
    );

    let mut invalid_selection = selection.clone();
    invalid_selection.hunks[0].lines = vec![u32::MAX];
    let (invalid_action, invalid_token) =
        issue_discard_confirmation(&backend, &repo_path, &selection, current).await;
    assert!(matches!(
        backend
            .discard_patch(
                &repo_path,
                &invalid_action,
                &invalid_selection,
                current,
                &invalid_token,
            )
            .await,
        Err(GitError::PreflightStale)
    ));
    assert_unchanged(
        current,
        worktree_before.clone(),
        cached_before.clone(),
        unstaged_before,
    );

    let (changed_action, changed_token) =
        issue_discard_confirmation(&backend, &repo_path, &selection, current).await;
    write_file(&repo_path, "target.txt", "changed after selection\n");
    let changed_before = std::fs::read(repo_path.0.join("target.txt")).unwrap();
    let changed_diff = git_output(&backend, &repo_path, &["diff"]);
    assert!(matches!(
        backend
            .discard_patch(
                &repo_path,
                &changed_action,
                &selection,
                current,
                &changed_token,
            )
            .await,
        Err(GitError::PatchStale)
    ));
    assert_unchanged(current, changed_before, cached_before.clone(), changed_diff);

    let binary = backend
        .working_file_diff(&repo_path, "binary.dat", false)
        .await
        .unwrap();
    let binary_selection = whole_patch_selection(&binary, 0..binary.hunks.len());
    assert!(matches!(
        backend
            .issue_discard_confirmation(
                &repo_path,
                &discard_action(&binary_selection),
                &binary_selection,
                current,
            )
            .await,
        Err(GitError::PatchUnsupported(_))
    ));
    assert_eq!(backend.generations(&repo_path).unwrap(), current);
}

#[tokio::test]
async fn discard_patch_rejects_external_index_change_and_git_apply_failures_without_effect() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    commit_fixture(&backend, &repo_path, &[("target.txt", b"base\n")]).await;
    write_file(&repo_path, "target.txt", "selected\n");
    let detail = backend
        .working_file_diff(&repo_path, "target.txt", false)
        .await
        .unwrap();
    let selection = whole_patch_selection(&detail, 0..detail.hunks.len());
    let generations = backend.generations(&repo_path).unwrap();
    let (action, token) =
        issue_discard_confirmation(&backend, &repo_path, &selection, generations).await;

    run_git_success(&backend, &repo_path, &["add", "target.txt"]);
    let before = std::fs::read(repo_path.0.join("target.txt")).unwrap();
    let cached_before = git_output(&backend, &repo_path, &["diff", "--cached"]);
    assert!(matches!(
        backend
            .discard_patch(&repo_path, &action, &selection, generations, &token)
            .await,
        Err(GitError::PatchStale)
    ));
    assert_eq!(
        std::fs::read(repo_path.0.join("target.txt")).unwrap(),
        before
    );
    assert_eq!(
        git_output(&backend, &repo_path, &["diff", "--cached"]),
        cached_before
    );
    assert_eq!(backend.generations(&repo_path).unwrap(), generations);

    assert!(matches!(
        working_tree::run_git_apply_to_worktree(
            &backend.commands,
            &repo_path,
            b"this is not a patch\n",
            true,
        ),
        Err(GitError::PatchApplyFailed(_))
    ));
    assert!(matches!(
        working_tree::run_git_apply_to_worktree(
            &backend.commands,
            &repo_path,
            b"this is not a patch\n",
            false,
        ),
        Err(GitError::PatchApplyFailed(_))
    ));
    assert_eq!(
        std::fs::read(repo_path.0.join("target.txt")).unwrap(),
        before
    );
    assert_eq!(
        git_output(&backend, &repo_path, &["diff", "--cached"]),
        cached_before
    );
    assert_eq!(backend.generations(&repo_path).unwrap(), generations);
}

#[tokio::test]
async fn discard_confirmation_rejects_scope_escalation_and_hunk_substitution_atomically() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    let base = (1..=40)
        .map(|line| format!("line {line}"))
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    commit_fixture(&backend, &repo_path, &[("target.txt", base.as_bytes())]).await;
    write_file(
        &repo_path,
        "target.txt",
        &base
            .replace("line 2\n", "changed A\n")
            .replace("line 39\n", "changed B\n"),
    );
    let detail = backend
        .working_file_diff(&repo_path, "target.txt", false)
        .await
        .unwrap();
    assert_eq!(detail.hunks.len(), 2);
    let generations = backend.generations(&repo_path).unwrap();
    let hunk_a = whole_patch_selection(&detail, [0]);
    let hunk_b = whole_patch_selection(&detail, [1]);
    let whole_file = whole_patch_selection(&detail, 0..detail.hunks.len());
    let mut one_line = hunk_a.clone();
    one_line.hunks[0].lines = vec![detail.hunks[0]
        .lines
        .iter()
        .position(|line| line.kind != DiffLineKind::Context)
        .unwrap() as u32];
    let unchanged = patch_state(&backend, &repo_path);

    let (_, line_token) =
        issue_discard_confirmation(&backend, &repo_path, &one_line, generations).await;
    assert!(matches!(
        backend
            .discard_patch(
                &repo_path,
                &discard_action(&hunk_a),
                &hunk_a,
                generations,
                &line_token,
            )
            .await,
        Err(GitError::PreflightStale)
    ));
    assert_eq!(patch_state(&backend, &repo_path), unchanged);

    let (_, line_token) =
        issue_discard_confirmation(&backend, &repo_path, &one_line, generations).await;
    assert!(matches!(
        backend
            .discard_patch(
                &repo_path,
                &discard_action(&whole_file),
                &whole_file,
                generations,
                &line_token,
            )
            .await,
        Err(GitError::PreflightStale)
    ));
    assert_eq!(patch_state(&backend, &repo_path), unchanged);

    let (_, hunk_a_token) =
        issue_discard_confirmation(&backend, &repo_path, &hunk_a, generations).await;
    assert!(matches!(
        backend
            .discard_patch(
                &repo_path,
                &discard_action(&hunk_b),
                &hunk_b,
                generations,
                &hunk_a_token,
            )
            .await,
        Err(GitError::PreflightStale)
    ));
    assert_eq!(patch_state(&backend, &repo_path), unchanged);
}

#[tokio::test]
async fn discard_confirmation_rejects_digest_generation_repository_expiry_and_replay_atomically() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    commit_fixture(&backend, &repo_path, &[("target.txt", b"base\n")]).await;
    write_file(&repo_path, "target.txt", "changed\n");
    let detail = backend
        .working_file_diff(&repo_path, "target.txt", false)
        .await
        .unwrap();
    let selection = whole_patch_selection(&detail, [0]);
    let generations = backend.generations(&repo_path).unwrap();
    let unchanged = patch_state(&backend, &repo_path);

    let (action, digest_token) =
        issue_discard_confirmation(&backend, &repo_path, &selection, generations).await;
    let mut changed_digest = selection.clone();
    changed_digest.base_digest = "different-digest".to_string();
    assert!(matches!(
        backend
            .discard_patch(
                &repo_path,
                &action,
                &changed_digest,
                generations,
                &digest_token,
            )
            .await,
        Err(GitError::PreflightStale)
    ));
    assert_eq!(patch_state(&backend, &repo_path), unchanged);

    let (action, submitted_generation_token) =
        issue_discard_confirmation(&backend, &repo_path, &selection, generations).await;
    let submitted_generations = GenerationSet {
        working_tree: generations.working_tree + 1,
        ..generations
    };
    assert!(matches!(
        backend
            .discard_patch(
                &repo_path,
                &action,
                &selection,
                submitted_generations,
                &submitted_generation_token,
            )
            .await,
        Err(GitError::PreflightStale)
    ));
    assert_eq!(patch_state(&backend, &repo_path), unchanged);

    let (action, generation_token) =
        issue_discard_confirmation(&backend, &repo_path, &selection, generations).await;
    runtime::bump_mutation(&repo_path, MutationKind::Stage);
    let changed_generations = backend.generations(&repo_path).unwrap();
    let generation_unchanged = patch_state(&backend, &repo_path);
    assert!(matches!(
        backend
            .discard_patch(
                &repo_path,
                &action,
                &selection,
                generations,
                &generation_token,
            )
            .await,
        Err(GitError::PreflightStale)
    ));
    assert_eq!(patch_state(&backend, &repo_path), generation_unchanged);

    let (_other_dir, other_repo) = empty_repo();
    commit_fixture(&backend, &other_repo, &[("target.txt", b"base\n")]).await;
    write_file(&other_repo, "target.txt", "changed\n");
    let other_unchanged = patch_state(&backend, &other_repo);
    let (action, repository_token) =
        issue_discard_confirmation(&backend, &repo_path, &selection, changed_generations).await;
    assert!(matches!(
        backend
            .discard_patch(
                &other_repo,
                &action,
                &selection,
                changed_generations,
                &repository_token,
            )
            .await,
        Err(GitError::PreflightStale)
    ));
    assert_eq!(patch_state(&backend, &other_repo), other_unchanged);
    assert_eq!(patch_state(&backend, &repo_path), generation_unchanged);

    let (action, replay_token) =
        issue_discard_confirmation(&backend, &repo_path, &selection, changed_generations).await;
    backend
        .discard_patch(
            &repo_path,
            &action,
            &selection,
            changed_generations,
            &replay_token,
        )
        .await
        .unwrap();
    let after_success = patch_state(&backend, &repo_path);
    assert!(matches!(
        backend
            .discard_patch(
                &repo_path,
                &action,
                &selection,
                changed_generations,
                &replay_token,
            )
            .await,
        Err(GitError::PreflightStale)
    ));
    assert_eq!(patch_state(&backend, &repo_path), after_success);

    let (_stale_dir, stale_repo) = empty_repo();
    let stale_backend = LocalGitBackend::with_confirmation_ttl(std::time::Duration::ZERO);
    commit_fixture(&stale_backend, &stale_repo, &[("target.txt", b"base\n")]).await;
    write_file(&stale_repo, "target.txt", "changed\n");
    let stale_detail = stale_backend
        .working_file_diff(&stale_repo, "target.txt", false)
        .await
        .unwrap();
    let stale_selection = whole_patch_selection(&stale_detail, [0]);
    let stale_generations = stale_backend.generations(&stale_repo).unwrap();
    let (stale_action, stale_token) = issue_discard_confirmation(
        &stale_backend,
        &stale_repo,
        &stale_selection,
        stale_generations,
    )
    .await;
    let stale_unchanged = patch_state(&stale_backend, &stale_repo);
    assert!(matches!(
        stale_backend
            .discard_patch(
                &stale_repo,
                &stale_action,
                &stale_selection,
                stale_generations,
                &stale_token,
            )
            .await,
        Err(GitError::PreflightStale)
    ));
    assert_eq!(patch_state(&stale_backend, &stale_repo), stale_unchanged);
}

#[tokio::test]
async fn discard_confirmation_allows_one_successful_exact_match() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    commit_fixture(&backend, &repo_path, &[("target.txt", b"base\n")]).await;
    write_file(&repo_path, "target.txt", "changed\n");
    let detail = backend
        .working_file_diff(&repo_path, "target.txt", false)
        .await
        .unwrap();
    let selection = whole_patch_selection(&detail, [0]);
    let generations = backend.generations(&repo_path).unwrap();

    discard_confirmed(&backend, &repo_path, &selection, generations)
        .await
        .unwrap();

    assert_eq!(
        std::fs::read(repo_path.0.join("target.txt")).unwrap(),
        b"base\n"
    );
    assert!(git_output(&backend, &repo_path, &["diff", "--cached"]).is_empty());
}

#[tokio::test]
async fn patch_digests_cover_multiple_hunks_and_multiple_changed_files() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    let base = (1..=14)
        .map(|line| format!("line {line}"))
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    write_file(&repo_path, "first.txt", &base);
    write_file(&repo_path, "second.txt", "base\n");
    backend
        .stage(
            &repo_path,
            &[PathBuf::from("first.txt"), PathBuf::from("second.txt")],
        )
        .await
        .unwrap();
    backend.commit(&repo_path, "Initial commit").await.unwrap();

    let changed = base
        .replace("line 2", "line two")
        .replace("line 13", "line thirteen");
    write_file(&repo_path, "first.txt", &changed);
    write_file(&repo_path, "second.txt", "base\nadded\n");

    let changes = backend.working_changes(&repo_path).await.unwrap();
    let mut paths = changes
        .unstaged
        .iter()
        .map(|file| file.path.as_str())
        .collect::<Vec<_>>();
    paths.sort_unstable();
    assert_eq!(paths, ["first.txt", "second.txt"]);

    let first = backend
        .working_file_diff(&repo_path, "first.txt", false)
        .await
        .unwrap();
    let second = backend
        .working_file_diff(&repo_path, "second.txt", false)
        .await
        .unwrap();
    assert_eq!(first.hunks.len(), 2);
    assert_eq!(second.hunks.len(), 1);
    assert_ne!(
        patch::base_digest(&first, PatchSource::Worktree),
        patch::base_digest(&second, PatchSource::Worktree)
    );
    let first_selection = fjord_domain::PatchSelection {
        path: first.path.clone(),
        source: PatchSource::Worktree,
        hunks: first
            .hunks
            .iter()
            .map(|hunk| fjord_domain::HunkSelection {
                old_start: hunk.old_start,
                old_lines: hunk.old_lines,
                new_start: hunk.new_start,
                new_lines: hunk.new_lines,
                lines: Vec::new(),
            })
            .collect(),
        base_digest: patch::base_digest(&first, PatchSource::Worktree),
    };
    let generated = patch::build_unified_patch(&first, &first_selection).unwrap();
    assert_patch_applies_without_mutation(&backend, &repo_path, &generated);
}

#[tokio::test]
async fn unreachable_commit_preflight_counts_exactly_and_bounds_the_sample() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    write_file(&repo_path, "README.md", "base\n");
    backend
        .stage(&repo_path, &[PathBuf::from("README.md")])
        .await
        .unwrap();
    let base = backend.commit(&repo_path, "Base").await.unwrap();

    let mut tip = String::new();
    for revision in 1..=7 {
        write_file(&repo_path, "README.md", &format!("revision {revision}\n"));
        backend
            .stage(&repo_path, &[PathBuf::from("README.md")])
            .await
            .unwrap();
        tip = backend
            .commit(&repo_path, &format!("Remote revision {revision}"))
            .await
            .unwrap();
    }
    backend.reset(&repo_path, &base, "hard").await.unwrap();

    let (count, sample) = backend
        .commits_unreachable_from_head(&repo_path, &tip, 5)
        .await
        .unwrap();

    assert_eq!(count, 7);
    assert_eq!(sample.len(), 5);
    assert_eq!(sample[0].message, "Remote revision 7");
}

#[tokio::test]
async fn oversized_working_file_diff_returns_metadata_without_content() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    write_file(&repo_path, "large.txt", "base\n");
    backend
        .stage(&repo_path, &[PathBuf::from("large.txt")])
        .await
        .unwrap();
    backend.commit(&repo_path, "Initial commit").await.unwrap();
    let content = "x".repeat(11 * 1024 * 1024);
    write_file(&repo_path, "large.txt", &content);

    let window = backend
        .working_file_diff_window(&repo_path, "large.txt", false, 0, 1_000, 10 * 1024 * 1024)
        .await
        .unwrap();

    assert!(window.too_large);
    assert!(window.file_bytes > 10 * 1024 * 1024);
    assert!(window.hunks.is_empty());
}

#[tokio::test]
async fn staging_a_deleted_file_records_the_deletion() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    write_file(&repo_path, "README.md", "base\n");
    backend
        .stage(&repo_path, &[PathBuf::from("README.md")])
        .await
        .unwrap();
    backend.commit(&repo_path, "Initial commit").await.unwrap();

    std::fs::remove_file(repo_path.0.join("README.md")).unwrap();
    backend
        .stage(&repo_path, &[PathBuf::from("README.md")])
        .await
        .unwrap();

    let changes = backend.working_changes(&repo_path).await.unwrap();
    assert_eq!(changes.staged.len(), 1);
    assert_eq!(changes.staged[0].change_type, FileChangeType::Deleted);
    assert!(changes.unstaged.is_empty());
}

#[tokio::test]
async fn create_branch_optionally_switches_to_it() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    write_file(&repo_path, "README.md", "# Fjord\n");
    backend
        .stage(&repo_path, &[PathBuf::from("README.md")])
        .await
        .unwrap();
    backend.commit(&repo_path, "Initial commit").await.unwrap();

    backend
        .create_branch(&repo_path, "feature/a", false)
        .await
        .unwrap();
    assert_eq!(
        Repository::open(&repo_path.0)
            .unwrap()
            .head()
            .unwrap()
            .shorthand()
            .unwrap(),
        "main",
        "creating without checkout must leave HEAD alone"
    );

    backend
        .create_branch(&repo_path, "feature/b", true)
        .await
        .unwrap();
    assert_eq!(
        Repository::open(&repo_path.0)
            .unwrap()
            .head()
            .unwrap()
            .shorthand()
            .unwrap(),
        "feature/b"
    );
}

#[tokio::test]
async fn create_branch_rejects_an_existing_name() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    write_file(&repo_path, "README.md", "# Fjord\n");
    backend
        .stage(&repo_path, &[PathBuf::from("README.md")])
        .await
        .unwrap();
    backend.commit(&repo_path, "Initial commit").await.unwrap();

    backend
        .create_branch(&repo_path, "feature", false)
        .await
        .unwrap();
    let result = backend.create_branch(&repo_path, "feature", false).await;

    assert!(matches!(result, Err(GitError::BranchExists(name)) if name == "feature"));
}

#[tokio::test]
async fn context_menu_ref_operations_update_real_git_refs() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    write_file(&repo_path, "README.md", "base\n");
    backend
        .stage(&repo_path, &[PathBuf::from("README.md")])
        .await
        .unwrap();
    let base = backend.commit(&repo_path, "Initial commit").await.unwrap();

    backend
        .create_branch_at(&repo_path, "feature/menu", &base, true)
        .await
        .unwrap();
    backend
        .rename_branch(&repo_path, "feature/menu", "feature/context-menu")
        .await
        .unwrap();
    backend
        .create_tag(&repo_path, "v-context", &base)
        .await
        .unwrap();

    let git = Repository::open(&repo_path.0).unwrap();
    assert_eq!(
        git.head().unwrap().shorthand().unwrap(),
        "feature/context-menu"
    );
    assert!(git.find_reference("refs/tags/v-context").is_ok());
    drop(git);

    backend.delete_tag(&repo_path, "v-context").await.unwrap();
    backend.checkout(&repo_path, "main").await.unwrap();
    backend
        .delete_branch(&repo_path, "feature/context-menu")
        .await
        .unwrap();

    let git = Repository::open(&repo_path.0).unwrap();
    assert!(git.find_reference("refs/tags/v-context").is_err());
    assert!(git
        .find_reference("refs/heads/feature/context-menu")
        .is_err());
}

#[tokio::test]
async fn context_menu_commit_operations_cherry_pick_revert_and_reset() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    write_file(&repo_path, "README.md", "base\n");
    backend
        .stage(&repo_path, &[PathBuf::from("README.md")])
        .await
        .unwrap();
    let base = backend.commit(&repo_path, "Initial commit").await.unwrap();
    write_file(&repo_path, "README.md", "next\n");
    backend
        .stage(&repo_path, &[PathBuf::from("README.md")])
        .await
        .unwrap();
    let next = backend.commit(&repo_path, "Second commit").await.unwrap();

    backend.reset(&repo_path, &base, "hard").await.unwrap();
    assert_eq!(
        std::fs::read_to_string(repo_path.0.join("README.md")).unwrap(),
        "base\n"
    );

    backend.cherry_pick(&repo_path, &next).await.unwrap();
    assert_eq!(
        std::fs::read_to_string(repo_path.0.join("README.md")).unwrap(),
        "next\n"
    );
    backend.revert(&repo_path, &next).await.unwrap();
    assert_eq!(
        std::fs::read_to_string(repo_path.0.join("README.md")).unwrap(),
        "base\n"
    );
}

#[tokio::test]
async fn stash_push_then_pop_round_trips_a_dirty_worktree() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    write_file(&repo_path, "README.md", "committed\n");
    backend
        .stage(&repo_path, &[PathBuf::from("README.md")])
        .await
        .unwrap();
    backend.commit(&repo_path, "Initial commit").await.unwrap();

    write_file(&repo_path, "README.md", "work in progress\n");
    backend.stash_push(&repo_path, Some("wip")).await.unwrap();

    assert_eq!(
        std::fs::read_to_string(repo_path.0.join("README.md")).unwrap(),
        "committed\n",
        "stashing must restore the committed content"
    );
    let stashes = backend.stashes(&repo_path).await.unwrap();
    assert_eq!(stashes.len(), 1);
    assert_eq!(stashes[0].index, 0);
    assert!(stashes[0].message.contains("wip"));

    backend.stash_pop(&repo_path).await.unwrap();

    assert_eq!(
        std::fs::read_to_string(repo_path.0.join("README.md")).unwrap(),
        "work in progress\n"
    );
    assert!(backend.stashes(&repo_path).await.unwrap().is_empty());
}

#[tokio::test]
async fn stash_push_on_a_clean_worktree_reports_nothing_to_stash() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    write_file(&repo_path, "README.md", "committed\n");
    backend
        .stage(&repo_path, &[PathBuf::from("README.md")])
        .await
        .unwrap();
    backend.commit(&repo_path, "Initial commit").await.unwrap();

    let result = backend.stash_push(&repo_path, None).await;

    assert!(matches!(result, Err(GitError::NothingToStash)));
}

#[tokio::test]
async fn stash_pop_on_an_empty_stack_reports_stash_empty() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    write_file(&repo_path, "README.md", "committed\n");
    backend
        .stage(&repo_path, &[PathBuf::from("README.md")])
        .await
        .unwrap();
    backend.commit(&repo_path, "Initial commit").await.unwrap();

    let result = backend.stash_pop(&repo_path).await;

    assert!(matches!(result, Err(GitError::StashEmpty)));
}

#[tokio::test]
async fn failed_checkout_keeps_head_on_original_branch() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    write_file(&repo_path, "README.md", "base\n");
    backend
        .stage(&repo_path, &[PathBuf::from("README.md")])
        .await
        .unwrap();
    backend.commit(&repo_path, "Initial commit").await.unwrap();

    let repo = Repository::open(&repo_path.0).unwrap();
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    repo.branch("feature", &head, false).unwrap();
    drop(head);
    drop(repo);

    backend.checkout(&repo_path, "feature").await.unwrap();
    write_file(&repo_path, "README.md", "feature\n");
    backend
        .stage(&repo_path, &[PathBuf::from("README.md")])
        .await
        .unwrap();
    backend.commit(&repo_path, "Feature change").await.unwrap();

    backend.checkout(&repo_path, "main").await.unwrap();
    write_file(&repo_path, "README.md", "local edit\n");

    let result = backend.checkout(&repo_path, "feature").await;

    assert!(result.is_err());
    let repo = Repository::open(&repo_path.0).unwrap();
    assert_eq!(repo.head().unwrap().shorthand().unwrap(), "main");
    assert_eq!(
        std::fs::read_to_string(repo_path.0.join("README.md")).unwrap(),
        "local edit\n"
    );
}

#[tokio::test]
async fn status_reports_merge_conflicts() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    write_file(&repo_path, "README.md", "base\n");
    backend
        .stage(&repo_path, &[PathBuf::from("README.md")])
        .await
        .unwrap();
    backend.commit(&repo_path, "Initial commit").await.unwrap();

    let repo = Repository::open(&repo_path.0).unwrap();
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    repo.branch("feature", &head, false).unwrap();
    drop(head);
    drop(repo);

    backend.checkout(&repo_path, "feature").await.unwrap();
    write_file(&repo_path, "README.md", "feature\n");
    backend
        .stage(&repo_path, &[PathBuf::from("README.md")])
        .await
        .unwrap();
    backend.commit(&repo_path, "Feature change").await.unwrap();

    backend.checkout(&repo_path, "main").await.unwrap();
    write_file(&repo_path, "README.md", "main\n");
    backend
        .stage(&repo_path, &[PathBuf::from("README.md")])
        .await
        .unwrap();
    backend.commit(&repo_path, "Main change").await.unwrap();

    let repo = Repository::open(&repo_path.0).unwrap();
    let feature_ref = repo.find_reference("refs/heads/feature").unwrap();
    let feature = repo.reference_to_annotated_commit(&feature_ref).unwrap();
    let mut checkout = CheckoutBuilder::new();
    checkout.allow_conflicts(true).conflict_style_merge(true);
    repo.merge(&[&feature], None, Some(&mut checkout)).unwrap();

    let status = backend.status(&repo_path).await.unwrap();
    assert!(status.has_conflict);
}

#[tokio::test]
async fn open_merge_tool_requires_conflicts() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();

    let result = backend.open_merge_tool(&repo_path).await;

    assert!(matches!(result, Err(GitError::NoConflicts)));
}

/// P5-20. With no usable executable, subprocess-backed local operations must
/// report the same condition remote transport does instead of quietly running
/// whatever `git` happens to be on `PATH`.
#[tokio::test]
async fn subprocess_operations_fail_when_no_git_executable_is_available() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    write_file(&repo_path, "README.md", "base\n");
    backend
        .stage(&repo_path, &[PathBuf::from("README.md")])
        .await
        .unwrap();
    let head = backend.commit(&repo_path, "Initial").await.unwrap();

    backend.set_git_executable(GitExecutableResolution::Unavailable);

    // A mutation that shells out.
    let reset = backend.reset(&repo_path, &head, "soft").await;
    assert!(
        matches!(reset, Err(GitError::ExecutableNotFound)),
        "unexpected reset result: {reset:?}"
    );

    // A conflict-resolution hand-off that shells out.
    let cherry_pick = backend.cherry_pick(&repo_path, &head).await;
    assert!(
        matches!(cherry_pick, Err(GitError::ExecutableNotFound)),
        "unexpected cherry-pick result: {cherry_pick:?}"
    );

    // And a read path that shells out for line statistics.
    let diff = backend.diff(&repo_path, &head).await;
    assert!(
        matches!(diff, Err(GitError::ExecutableNotFound)),
        "unexpected diff result: {diff:?}"
    );
}

/// The library-backed paths must stay usable so a broken executable setting
/// degrades the app rather than bricking it — `gix` and `git2` need no binary.
#[tokio::test]
async fn library_reads_survive_an_unavailable_executable() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    write_file(&repo_path, "README.md", "base\n");
    backend
        .stage(&repo_path, &[PathBuf::from("README.md")])
        .await
        .unwrap();
    backend.commit(&repo_path, "Initial").await.unwrap();

    backend.set_git_executable(GitExecutableResolution::Unavailable);

    backend.status(&repo_path).await.unwrap();
    assert!(!backend.branches(&repo_path).await.unwrap().is_empty());
    assert!(!backend
        .log(&repo_path, None, 10)
        .await
        .unwrap()
        .commits
        .is_empty());
    backend.working_changes(&repo_path).await.unwrap();
}

/// Phase 8 safety finding #3. The real index lock is held across discard's
/// final validation and worktree apply, so an external add cannot move the
/// patch base from A to C and leave the stale worktree reversal at A.
#[tokio::test]
async fn discard_patch_serializes_external_git_add_at_the_mutation_boundary() {
    let (_dir, repo_path) = empty_repo();
    let backend = std::sync::Arc::new(LocalGitBackend::new());
    commit_fixture(&backend, &repo_path, &[("target.txt", b"A\n")]).await;
    write_file(&repo_path, "target.txt", "C\n");
    let detail = backend
        .working_file_diff(&repo_path, "target.txt", false)
        .await
        .unwrap();
    let selection = whole_patch_selection(&detail, 0..detail.hunks.len());
    let generations = backend.generations(&repo_path).unwrap();
    let (action, token) =
        issue_discard_confirmation(&backend, &repo_path, &selection, generations).await;
    let before = atomic_patch_state(&backend, &repo_path, &["target.txt"]);
    let mut pause = patch_transaction::install_mutation_pause(&repo_path);

    let operation = {
        let backend = std::sync::Arc::clone(&backend);
        let repo_path = repo_path.clone();
        let action = action.clone();
        let selection = selection.clone();
        tokio::spawn(async move {
            backend
                .discard_patch(&repo_path, &action, &selection, generations, &token)
                .await
        })
    };
    pause.wait_until_reached().await;
    let external_add = run_git_status(&backend, &repo_path, &["add", "target.txt"]);
    pause.resume();
    let result = operation.await.unwrap().unwrap();

    assert!(
        !external_add.success(),
        "external add must honor index.lock"
    );
    assert_eq!(result.working_tree, before.generations.working_tree + 1);
    let after = atomic_patch_state(&backend, &repo_path, &["target.txt"]);
    assert_eq!(after.head, before.head);
    assert_eq!(after.cached_diff, Vec::<u8>::new());
    assert_eq!(after.worktree_diff, Vec::<u8>::new());
    assert_eq!(
        after.worktree_files[0].1.as_deref(),
        Some(b"A\n".as_slice())
    );
    assert_eq!(
        index_blob(&repo_path, "target.txt").as_deref(),
        Some(b"A\n".as_slice())
    );
    assert_index_lock_cleaned(&repo_path);
}

/// HEAD=A, INDEX=B, WORKTREE=B must never become HEAD=B, INDEX=A because a
/// commit crossed unstage's final validation. The prepared update-ref verify
/// transaction and index lock make the external commit fail before changing
/// either state owner.
#[tokio::test]
async fn unstage_patch_serializes_external_commit_at_the_mutation_boundary() {
    let (_dir, repo_path) = empty_repo();
    let backend = std::sync::Arc::new(LocalGitBackend::new());
    commit_fixture(&backend, &repo_path, &[("target.txt", b"A\n")]).await;
    write_file(&repo_path, "target.txt", "B\n");
    backend
        .stage(&repo_path, &[PathBuf::from("target.txt")])
        .await
        .unwrap();
    let detail = backend
        .working_file_diff(&repo_path, "target.txt", true)
        .await
        .unwrap();
    let selection = staged_patch_selection(&detail, 0..detail.hunks.len());
    let generations = backend.generations(&repo_path).unwrap();
    let before = atomic_patch_state(&backend, &repo_path, &["target.txt"]);
    let mut pause = patch_transaction::install_mutation_pause(&repo_path);

    let operation = {
        let backend = std::sync::Arc::clone(&backend);
        let repo_path = repo_path.clone();
        let selection = selection.clone();
        tokio::spawn(async move {
            backend
                .unstage_patch(&repo_path, &selection, generations)
                .await
        })
    };
    pause.wait_until_reached().await;
    let external_commit = run_git_status(&backend, &repo_path, &["commit", "-m", "external"]);
    pause.resume();
    operation.await.unwrap().unwrap();

    assert!(
        !external_commit.success(),
        "external commit must not cross the prepared HEAD/index locks"
    );
    let after = atomic_patch_state(&backend, &repo_path, &["target.txt"]);
    assert_eq!(after.head, before.head);
    assert_eq!(after.cached_diff, Vec::<u8>::new());
    assert!(!after.worktree_diff.is_empty());
    assert_eq!(
        after.worktree_files[0].1.as_deref(),
        Some(b"B\n".as_slice())
    );
    assert_eq!(
        index_blob(&repo_path, "target.txt").as_deref(),
        Some(b"A\n".as_slice())
    );
    assert_eq!(head_blob(&repo_path, "target.txt"), b"A\n");
    assert_index_lock_cleaned(&repo_path);
    assert_head_locks_cleaned(&backend, &repo_path);
}

/// Even a writer that ignores Git's index.lock is detected by the exact raw
/// index fingerprint before publication. The external index bytes survive and
/// both the index and prepared HEAD/ref locks are cleaned on the stale failure.
#[tokio::test]
async fn unstage_patch_rejects_nonconforming_index_replacement_without_partial_mutation() {
    let (_dir, repo_path) = empty_repo();
    let backend = std::sync::Arc::new(LocalGitBackend::new());
    commit_fixture(
        &backend,
        &repo_path,
        &[("target.txt", b"A\n"), ("other.txt", b"other A\n")],
    )
    .await;
    write_file(&repo_path, "target.txt", "B\n");
    backend
        .stage(&repo_path, &[PathBuf::from("target.txt")])
        .await
        .unwrap();
    let detail = backend
        .working_file_diff(&repo_path, "target.txt", true)
        .await
        .unwrap();
    let selection = staged_patch_selection(&detail, 0..detail.hunks.len());
    let generations = backend.generations(&repo_path).unwrap();
    let original_index = std::fs::read(resolved_index_path(&repo_path)).unwrap();

    write_file(&repo_path, "other.txt", "other B changed size\n");
    run_git_success(&backend, &repo_path, &["add", "other.txt"]);
    let replacement_index = std::fs::read(resolved_index_path(&repo_path)).unwrap();
    std::fs::write(resolved_index_path(&repo_path), &original_index).unwrap();
    let before = atomic_patch_state(&backend, &repo_path, &["target.txt", "other.txt"]);
    let mut pause = patch_transaction::install_mutation_pause(&repo_path);

    let operation = {
        let backend = std::sync::Arc::clone(&backend);
        let repo_path = repo_path.clone();
        let selection = selection.clone();
        tokio::spawn(async move {
            backend
                .unstage_patch(&repo_path, &selection, generations)
                .await
        })
    };
    pause.wait_until_reached().await;
    std::fs::write(resolved_index_path(&repo_path), &replacement_index).unwrap();
    pause.resume();
    let result = operation.await.unwrap();

    assert!(matches!(result, Err(GitError::PatchStale)));
    let after = atomic_patch_state(&backend, &repo_path, &["target.txt", "other.txt"]);
    assert_eq!(after.head, before.head);
    assert_eq!(after.index.as_deref(), Some(replacement_index.as_slice()));
    assert_eq!(after.generations, before.generations);
    assert_eq!(after.worktree_files, before.worktree_files);
    assert_eq!(
        index_blob(&repo_path, "target.txt").as_deref(),
        Some(b"B\n".as_slice())
    );
    assert_eq!(
        index_blob(&repo_path, "other.txt").as_deref(),
        Some(b"other B changed size\n".as_slice())
    );
    assert_index_lock_cleaned(&repo_path);
    assert_head_locks_cleaned(&backend, &repo_path);
}

/// An external index writer cannot replace or be silently overwritten by the
/// prepared stage transaction. Existing unrelated staged state survives, and
/// the attempted concurrent add remains only in the worktree.
#[tokio::test]
async fn stage_patch_serializes_external_index_mutation_and_preserves_unrelated_state() {
    let (_dir, repo_path) = empty_repo();
    let backend = std::sync::Arc::new(LocalGitBackend::new());
    commit_fixture(
        &backend,
        &repo_path,
        &[
            ("target.txt", b"A\n"),
            ("other.txt", b"other A\n"),
            ("existing.txt", b"existing A\n"),
        ],
    )
    .await;
    write_file(&repo_path, "existing.txt", "existing B\n");
    backend
        .stage(&repo_path, &[PathBuf::from("existing.txt")])
        .await
        .unwrap();
    write_file(&repo_path, "target.txt", "C\n");
    write_file(&repo_path, "other.txt", "other B changed size\n");
    let detail = backend
        .working_file_diff(&repo_path, "target.txt", false)
        .await
        .unwrap();
    let selection = whole_patch_selection(&detail, 0..detail.hunks.len());
    let generations = backend.generations(&repo_path).unwrap();
    let before = atomic_patch_state(
        &backend,
        &repo_path,
        &["target.txt", "other.txt", "existing.txt"],
    );
    let mut pause = patch_transaction::install_mutation_pause(&repo_path);

    let operation = {
        let backend = std::sync::Arc::clone(&backend);
        let repo_path = repo_path.clone();
        let selection = selection.clone();
        tokio::spawn(async move {
            backend
                .stage_patch(&repo_path, &selection, generations)
                .await
        })
    };
    pause.wait_until_reached().await;
    let external_add = run_git_status(&backend, &repo_path, &["add", "other.txt"]);
    pause.resume();
    operation.await.unwrap().unwrap();

    assert!(
        !external_add.success(),
        "external add must honor index.lock"
    );
    let after = atomic_patch_state(
        &backend,
        &repo_path,
        &["target.txt", "other.txt", "existing.txt"],
    );
    assert_eq!(after.head, before.head);
    assert_eq!(
        index_blob(&repo_path, "target.txt").as_deref(),
        Some(b"C\n".as_slice())
    );
    assert_eq!(
        index_blob(&repo_path, "existing.txt").as_deref(),
        Some(b"existing B\n".as_slice())
    );
    assert_eq!(
        index_blob(&repo_path, "other.txt").as_deref(),
        Some(b"other A\n".as_slice())
    );
    assert_eq!(after.worktree_files, before.worktree_files);
    assert!(!after.worktree_diff.is_empty());
    assert_index_lock_cleaned(&repo_path);
}

/// Checkout/switch/reset-style worktree changes also need the index lock. A
/// checkout racing stage must fail rather than let Fjord stage C after the
/// worktree has returned to A.
#[tokio::test]
async fn stage_patch_serializes_external_git_worktree_mutation() {
    let (_dir, repo_path) = empty_repo();
    let backend = std::sync::Arc::new(LocalGitBackend::new());
    commit_fixture(&backend, &repo_path, &[("target.txt", b"A\n")]).await;
    write_file(&repo_path, "target.txt", "C\n");
    let detail = backend
        .working_file_diff(&repo_path, "target.txt", false)
        .await
        .unwrap();
    let selection = whole_patch_selection(&detail, 0..detail.hunks.len());
    let generations = backend.generations(&repo_path).unwrap();
    let mut pause = patch_transaction::install_mutation_pause(&repo_path);

    let operation = {
        let backend = std::sync::Arc::clone(&backend);
        let repo_path = repo_path.clone();
        let selection = selection.clone();
        tokio::spawn(async move {
            backend
                .stage_patch(&repo_path, &selection, generations)
                .await
        })
    };
    pause.wait_until_reached().await;
    let external_checkout = run_git_status(
        &backend,
        &repo_path,
        &["checkout", "HEAD", "--", "target.txt"],
    );
    pause.resume();
    operation.await.unwrap().unwrap();

    assert!(
        !external_checkout.success(),
        "external checkout must honor index.lock"
    );
    assert_eq!(
        index_blob(&repo_path, "target.txt").as_deref(),
        Some(b"C\n".as_slice())
    );
    assert_eq!(
        std::fs::read(repo_path.0.join("target.txt")).unwrap(),
        b"C\n"
    );
    assert_index_lock_cleaned(&repo_path);
}

/// Editors do not honor index.lock. The final backend reconstruction catches a
/// deterministic edit at the boundary, rejects with patch_stale, and leaves
/// HEAD, index, cached state, and generations untouched.
#[tokio::test]
async fn stage_patch_rejects_editor_change_at_the_mutation_boundary_atomically() {
    let (_dir, repo_path) = empty_repo();
    let backend = std::sync::Arc::new(LocalGitBackend::new());
    commit_fixture(&backend, &repo_path, &[("target.txt", b"A\n")]).await;
    write_file(&repo_path, "target.txt", "C\n");
    let detail = backend
        .working_file_diff(&repo_path, "target.txt", false)
        .await
        .unwrap();
    let selection = whole_patch_selection(&detail, 0..detail.hunks.len());
    let generations = backend.generations(&repo_path).unwrap();
    let before = atomic_patch_state(&backend, &repo_path, &["target.txt"]);
    let mut pause = patch_transaction::install_mutation_pause(&repo_path);

    let operation = {
        let backend = std::sync::Arc::clone(&backend);
        let repo_path = repo_path.clone();
        let selection = selection.clone();
        tokio::spawn(async move {
            backend
                .stage_patch(&repo_path, &selection, generations)
                .await
        })
    };
    pause.wait_until_reached().await;
    write_file(&repo_path, "target.txt", "D from editor\n");
    pause.resume();
    let result = operation.await.unwrap();

    assert!(matches!(result, Err(GitError::PatchStale)));
    let after = atomic_patch_state(&backend, &repo_path, &["target.txt"]);
    assert_eq!(after.head, before.head);
    assert_eq!(after.index, before.index);
    assert_eq!(after.cached_diff, before.cached_diff);
    assert_eq!(after.generations, before.generations);
    assert_eq!(
        after.worktree_files[0].1.as_deref(),
        Some(b"D from editor\n".as_slice())
    );
    assert!(String::from_utf8_lossy(&after.worktree_diff).contains("D from editor"));
    assert_index_lock_cleaned(&repo_path);
}

/// `Index::path()` resolves the per-worktree index rather than assuming
/// `.git/index`. The linked worktree owns the lock and cleanup; the main
/// worktree's index is never locked or replaced.
#[tokio::test]
async fn stage_patch_uses_the_linked_worktree_index_transaction() {
    let (_main_dir, main_repo) = empty_repo();
    let backend = std::sync::Arc::new(LocalGitBackend::new());
    commit_fixture(&backend, &main_repo, &[("target.txt", b"A\n")]).await;
    let linked_parent = TempDir::new().unwrap();
    let linked_path = linked_parent.path().join("linked");
    let linked_text = linked_path.to_string_lossy().into_owned();
    run_git_success(
        &backend,
        &main_repo,
        &["worktree", "add", "--detach", &linked_text],
    );
    let linked_repo = RepoPath(linked_path);
    write_file(&linked_repo, "target.txt", "C\n");
    let detail = backend
        .working_file_diff(&linked_repo, "target.txt", false)
        .await
        .unwrap();
    let selection = whole_patch_selection(&detail, 0..detail.hunks.len());
    let generations = backend.generations(&linked_repo).unwrap();
    let mut pause = patch_transaction::install_mutation_pause(&linked_repo);
    let linked_index_lock = lock_path(&resolved_index_path(&linked_repo));
    let main_index_lock = lock_path(&resolved_index_path(&main_repo));

    let operation = {
        let backend = std::sync::Arc::clone(&backend);
        let linked_repo = linked_repo.clone();
        let selection = selection.clone();
        tokio::spawn(async move {
            backend
                .stage_patch(&linked_repo, &selection, generations)
                .await
        })
    };
    pause.wait_until_reached().await;
    assert!(linked_index_lock.exists());
    assert!(!main_index_lock.exists());
    pause.resume();
    operation.await.unwrap().unwrap();

    assert_eq!(
        index_blob(&linked_repo, "target.txt").as_deref(),
        Some(b"C\n".as_slice())
    );
    assert!(!linked_index_lock.exists());
    assert!(!main_index_lock.exists());

    let staged = backend
        .working_file_diff(&linked_repo, "target.txt", true)
        .await
        .unwrap();
    let unstage_selection = staged_patch_selection(&staged, 0..staged.hunks.len());
    backend
        .unstage_patch(
            &linked_repo,
            &unstage_selection,
            backend.generations(&linked_repo).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        index_blob(&linked_repo, "target.txt").as_deref(),
        Some(b"A\n".as_slice())
    );
    assert_eq!(
        std::fs::read(linked_repo.0.join("target.txt")).unwrap(),
        b"C\n"
    );
    assert_index_lock_cleaned(&linked_repo);
    assert_head_locks_cleaned(&backend, &linked_repo);
}

/// Missing indexes and unborn HEAD are explicit fingerprint states. Git creates
/// the transactional empty index, while update-ref verifies and locks the
/// unborn symbolic target before unstage publishes its inverse.
#[tokio::test]
async fn patch_transaction_supports_a_missing_index_and_unborn_head() {
    let (_dir, repo_path) = empty_repo();
    let backend = LocalGitBackend::new();
    assert!(!resolved_index_path(&repo_path).exists());
    write_file(&repo_path, "new.txt", "new\n");
    let unstaged = backend
        .working_file_diff(&repo_path, "new.txt", false)
        .await
        .unwrap();
    let stage_selection = whole_patch_selection(&unstaged, 0..unstaged.hunks.len());
    let after_stage = backend
        .stage_patch(
            &repo_path,
            &stage_selection,
            backend.generations(&repo_path).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        index_blob(&repo_path, "new.txt").as_deref(),
        Some(b"new\n".as_slice())
    );

    let staged = backend
        .working_file_diff(&repo_path, "new.txt", true)
        .await
        .unwrap();
    let unstage_selection = staged_patch_selection(&staged, 0..staged.hunks.len());
    backend
        .unstage_patch(&repo_path, &unstage_selection, after_stage)
        .await
        .unwrap();

    assert_eq!(index_blob(&repo_path, "new.txt"), None);
    assert_eq!(
        std::fs::read(repo_path.0.join("new.txt")).unwrap(),
        b"new\n"
    );
    assert_index_lock_cleaned(&repo_path);
    assert_head_locks_cleaned(&backend, &repo_path);
}

#[test]
fn libgit2_ownership_refusal_has_a_typed_error() {
    let error =
        git2::Error::from_str("repository path 'C:/repos/fjord' is not owned by current user");

    let mapped = LocalGitBackend::map_git2_error(error);

    assert!(matches!(
        mapped,
        GitError::RepositoryOwnership(message)
            if message.contains("C:/repos/fjord")
    ));
}
