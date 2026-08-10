//! Integration tests for the local backend, exercised through the
//! `GitBackend` trait against real fixture repositories.

use super::*;
use crate::GenerationSet;
use git2::{BranchType, Oid, Repository, RepositoryInitOptions, Status};
use std::path::Path;
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
