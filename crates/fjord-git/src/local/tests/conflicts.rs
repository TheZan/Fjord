//! `docs/specs/conflict-resolution.md` §Testing strategy: the eleven
//! backend/integration cases, each against a real repository.

use super::*;
use fjord_domain::{ConflictKind, ConflictResolution, ConflictSet};

/// `None` deletes the path.
type Change<'a> = (&'a str, Option<&'a str>);

fn apply_changes(repo: &RepoPath, changes: &[Change]) {
    for (path, content) in changes {
        match content {
            Some(content) => write_nested_file(repo, path, content.as_bytes()),
            None => std::fs::remove_file(repo.0.join(path)).unwrap(),
        }
    }
}

fn commit_all(backend: &LocalGitBackend, repo: &RepoPath, message: &str) {
    run_git_success(backend, repo, &["add", "-A"]);
    run_git_success(backend, repo, &["commit", "-q", "-m", message]);
}

/// `main` and `topic` both diverge from `base`; `main` is checked out.
fn diverged(
    base: &[Change],
    main: &[Change],
    topic: &[Change],
) -> (TempDir, RepoPath, LocalGitBackend) {
    let (directory, repo) = empty_repo();
    let backend = LocalGitBackend::new();
    write_file(&repo, "keep.txt", "unrelated\n");
    apply_changes(&repo, base);
    commit_all(&backend, &repo, "base");
    run_git_success(&backend, &repo, &["branch", "topic"]);
    apply_changes(&repo, main);
    commit_all(&backend, &repo, "main change");
    run_git_success(&backend, &repo, &["checkout", "-q", "topic"]);
    apply_changes(&repo, topic);
    commit_all(&backend, &repo, "topic change");
    run_git_success(&backend, &repo, &["checkout", "-q", "main"]);
    (directory, repo, backend)
}

fn merge_topic(backend: &LocalGitBackend, repo: &RepoPath) {
    assert!(!run_git_status(backend, repo, &["merge", "--no-edit", "topic"]).success());
}

fn blob_at(repo: &RepoPath, revision: &str, path: &str) -> String {
    let git = Repository::open(&repo.0).unwrap();
    let tree = git
        .revparse_single(revision)
        .unwrap()
        .peel_to_tree()
        .unwrap();
    tree.get_path(Path::new(path)).unwrap().id().to_string()
}

fn worktree_blob(repo: &RepoPath, path: &str) -> String {
    let git = Repository::open(&repo.0).unwrap();
    git.blob_path(&repo.0.join(path)).unwrap().to_string()
}

fn stage0_blob(repo: &RepoPath, path: &str) -> Option<String> {
    let git = Repository::open(&repo.0).unwrap();
    let mut index = git.index().unwrap();
    index.read(true).unwrap();
    index
        .get_path(Path::new(path), 0)
        .map(|entry| entry.id.to_string())
}

fn index_has_any_stage(repo: &RepoPath, path: &str) -> bool {
    let git = Repository::open(&repo.0).unwrap();
    let mut index = git.index().unwrap();
    index.read(true).unwrap();
    (0..=3).any(|stage| index.get_path(Path::new(path), stage).is_some())
}

fn conflicted_paths(set: &ConflictSet) -> Vec<&str> {
    set.entries
        .iter()
        .map(|entry| entry.path.as_str())
        .collect()
}

async fn resolve(
    backend: &LocalGitBackend,
    repo: &RepoPath,
    path: &str,
    resolution: ConflictResolution,
) -> Result<ConflictSet, GitError> {
    let expected = backend.generations(repo).unwrap();
    backend
        .resolve_conflict(repo, path, resolution, false, expected)
        .await
}

fn both_modified() -> (TempDir, RepoPath, LocalGitBackend) {
    diverged(
        &[("a.txt", Some("base a\n")), ("b.txt", Some("base b\n"))],
        &[("a.txt", Some("main a\n")), ("b.txt", Some("main b\n"))],
        &[("a.txt", Some("topic a\n")), ("b.txt", Some("topic b\n"))],
    )
}

// 1.
#[tokio::test]
async fn case_01_both_modified_reports_all_three_stages_with_their_object_ids() {
    let (_directory, repo, backend) = both_modified();
    merge_topic(&backend, &repo);

    let set = backend.conflicts(&repo).await.unwrap();

    assert_eq!(conflicted_paths(&set), ["a.txt", "b.txt"]);
    assert_eq!(set.total, 2);
    assert!(!set.truncated);
    let entry = &set.entries[0];
    assert_eq!(entry.kind, ConflictKind::BothModified);
    assert_eq!(
        entry.base.as_ref().unwrap().blob.0,
        blob_at(&repo, "main~1", "a.txt")
    );
    assert_eq!(
        entry.ours.as_ref().unwrap().blob.0,
        blob_at(&repo, "main", "a.txt")
    );
    assert_eq!(
        entry.theirs.as_ref().unwrap().blob.0,
        blob_at(&repo, "topic", "a.txt")
    );
    assert_eq!(entry.ours.as_ref().unwrap().size, Some(7));
    assert!(!entry.ours.as_ref().unwrap().binary);
    assert_eq!(set.sides.ours_label, "main");
    assert_eq!(set.sides.theirs_label, "topic");
    assert!(!set.sides.inverted);
    assert_eq!(set.generations, backend.generations(&repo).unwrap());
}

// 2.
#[tokio::test]
async fn case_02_take_ours_and_take_theirs_write_exactly_that_stage() {
    let (_directory, repo, backend) = both_modified();
    merge_topic(&backend, &repo);

    let after_ours = resolve(&backend, &repo, "a.txt", ConflictResolution::TakeOurs)
        .await
        .unwrap();
    assert_eq!(conflicted_paths(&after_ours), ["b.txt"]);
    let ours = blob_at(&repo, "main", "a.txt");
    assert_eq!(worktree_blob(&repo, "a.txt"), ours);
    assert_eq!(stage0_blob(&repo, "a.txt"), Some(ours));

    let after_theirs = resolve(&backend, &repo, "b.txt", ConflictResolution::TakeTheirs)
        .await
        .unwrap();
    assert!(after_theirs.entries.is_empty());
    assert_eq!(after_theirs.total, 0);
    let theirs = blob_at(&repo, "topic", "b.txt");
    assert_eq!(worktree_blob(&repo, "b.txt"), theirs);
    assert_eq!(stage0_blob(&repo, "b.txt"), Some(theirs));
}

// 3.
#[tokio::test]
async fn case_03_modify_delete_offers_only_keep_or_delete_and_refuses_a_side() {
    let (_directory, repo, backend) = diverged(
        &[("gone.txt", Some("base\n")), ("kept.txt", Some("base\n"))],
        &[("gone.txt", Some("main edit\n")), ("kept.txt", None)],
        &[("gone.txt", None), ("kept.txt", Some("topic edit\n"))],
    );
    merge_topic(&backend, &repo);

    let set = backend.conflicts(&repo).await.unwrap();
    let kinds = set
        .entries
        .iter()
        .map(|entry| (entry.path.as_str(), entry.kind))
        .collect::<Vec<_>>();
    assert_eq!(
        kinds,
        [
            ("gone.txt", ConflictKind::DeletedByThem),
            ("kept.txt", ConflictKind::DeletedByUs)
        ]
    );
    assert!(set.entries[0].theirs.is_none() && set.entries[0].ours.is_some());
    assert!(set.entries[1].ours.is_none() && set.entries[1].theirs.is_some());
    for entry in &set.entries {
        assert_eq!(
            entry.kind.resolutions(),
            [ConflictResolution::KeepFile, ConflictResolution::DeleteFile]
        );
    }

    let before = backend.generations(&repo).unwrap();
    let index_before = std::fs::read(resolved_index_path(&repo)).unwrap();
    let refused = resolve(&backend, &repo, "gone.txt", ConflictResolution::TakeTheirs).await;
    assert!(matches!(
        refused,
        Err(GitError::ConflictResolutionNotApplicable)
    ));
    assert_eq!(
        std::fs::read(resolved_index_path(&repo)).unwrap(),
        index_before
    );
    assert_eq!(backend.generations(&repo).unwrap(), before);

    // Keep takes the surviving side of each mirror.
    resolve(&backend, &repo, "gone.txt", ConflictResolution::KeepFile)
        .await
        .unwrap();
    assert_eq!(
        stage0_blob(&repo, "gone.txt"),
        Some(blob_at(&repo, "main", "gone.txt"))
    );
    let done = resolve(&backend, &repo, "kept.txt", ConflictResolution::KeepFile)
        .await
        .unwrap();
    assert_eq!(
        stage0_blob(&repo, "kept.txt"),
        Some(blob_at(&repo, "topic", "kept.txt"))
    );
    assert_eq!(done.total, 0);
}

// 4.
#[tokio::test]
async fn case_04_delete_file_removes_the_path_and_the_merge_can_continue() {
    let (_directory, repo, backend) = diverged(
        &[("gone.txt", Some("base\n"))],
        &[("gone.txt", Some("main edit\n"))],
        &[("gone.txt", None)],
    );
    merge_topic(&backend, &repo);

    let set = resolve(&backend, &repo, "gone.txt", ConflictResolution::DeleteFile)
        .await
        .unwrap();

    assert_eq!(set.total, 0);
    assert!(!index_has_any_stage(&repo, "gone.txt"));
    assert!(!repo.0.join("gone.txt").exists());
    let state = backend.continue_operation(&repo).await.unwrap();
    assert_eq!(state.operation, RepoOperation::Normal);
    let git = Repository::open(&repo.0).unwrap();
    let head = git.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(head.parent_count(), 2);
    assert!(head
        .tree()
        .unwrap()
        .get_path(Path::new("gone.txt"))
        .is_err());
}

// 5.
#[tokio::test]
async fn case_05_add_add_is_both_added_without_a_base() {
    let (_directory, repo, backend) = diverged(
        &[],
        &[("new.txt", Some("main new\n"))],
        &[("new.txt", Some("topic new\n"))],
    );
    merge_topic(&backend, &repo);

    let set = backend.conflicts(&repo).await.unwrap();

    assert_eq!(set.entries.len(), 1);
    let entry = &set.entries[0];
    assert_eq!(entry.kind, ConflictKind::BothAdded);
    assert!(entry.base.is_none());
    assert!(entry.ours.is_some() && entry.theirs.is_some());
    let resolved = resolve(&backend, &repo, "new.txt", ConflictResolution::TakeTheirs)
        .await
        .unwrap();
    assert_eq!(resolved.total, 0);
    assert_eq!(
        stage0_blob(&repo, "new.txt"),
        Some(blob_at(&repo, "topic", "new.txt"))
    );
}

// 6.
#[tokio::test]
async fn case_06_mark_resolved_refuses_markers_and_succeeds_with_acknowledgement() {
    let (_directory, repo, backend) = both_modified();
    merge_topic(&backend, &repo);
    let marked = std::fs::read_to_string(repo.0.join("a.txt")).unwrap();
    assert!(marked.starts_with("<<<<<<< "));

    let before = backend.generations(&repo).unwrap();
    let index_before = std::fs::read(resolved_index_path(&repo)).unwrap();
    let refused = backend
        .resolve_conflict(
            &repo,
            "a.txt",
            ConflictResolution::MarkResolved,
            false,
            before,
        )
        .await;
    match refused {
        Err(GitError::ConflictMarkersPresent { path, line }) => {
            assert_eq!(path, "a.txt");
            assert_eq!(line, 1);
        }
        other => panic!("expected conflict_markers_present, got {other:?}"),
    }
    assert_eq!(backend.generations(&repo).unwrap(), before);
    assert_eq!(
        std::fs::read(resolved_index_path(&repo)).unwrap(),
        index_before
    );
    assert_eq!(
        std::fs::read_to_string(repo.0.join("a.txt")).unwrap(),
        marked
    );

    // A file edited clean is staged without an acknowledgement…
    write_file(&repo, "b.txt", "hand merged\n");
    let after_clean = resolve(&backend, &repo, "b.txt", ConflictResolution::MarkResolved)
        .await
        .unwrap();
    assert_eq!(conflicted_paths(&after_clean), ["a.txt"]);

    // …and one still carrying markers only with it.
    let acknowledged = backend
        .resolve_conflict(
            &repo,
            "a.txt",
            ConflictResolution::MarkResolved,
            true,
            backend.generations(&repo).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(acknowledged.total, 0);
    assert_eq!(
        index_blob(&repo, "a.txt").unwrap(),
        marked.as_bytes().to_vec()
    );
}

// 7.
#[tokio::test]
async fn case_07_resolution_works_against_a_conflicted_squash_merge() {
    let (_directory, repo, backend) = both_modified();
    let result = backend
        .squash_merge_branch(
            &repo,
            &local_merge_source("topic"),
            MergeDirtyPolicy::Refuse,
            GitOperationContext::default(),
        )
        .await
        .unwrap();
    assert!(matches!(
        result.outcome,
        SquashMergeOutcome::Conflicted { .. }
    ));
    assert_eq!(
        backend.operation_state(&repo).await.unwrap().operation,
        RepoOperation::Normal
    );

    let set = backend.conflicts(&repo).await.unwrap();
    assert_eq!(conflicted_paths(&set), ["a.txt", "b.txt"]);
    assert_eq!(set.sides.ours_label, "main");
    assert_eq!(set.sides.theirs_label, "topic");
    assert!(!set.sides.inverted);

    resolve(&backend, &repo, "a.txt", ConflictResolution::TakeOurs)
        .await
        .unwrap();
    let done = resolve(&backend, &repo, "b.txt", ConflictResolution::TakeTheirs)
        .await
        .unwrap();
    assert_eq!(done.total, 0);
    assert_eq!(
        backend.operation_state(&repo).await.unwrap().operation,
        RepoOperation::Normal
    );
    assert_eq!(
        stage0_blob(&repo, "b.txt"),
        Some(blob_at(&repo, "topic", "b.txt"))
    );
    // Nothing moved: the squash still has to be committed by the user.
    assert_eq!(
        Repository::open(&repo.0)
            .unwrap()
            .head()
            .unwrap()
            .peel_to_commit()
            .unwrap()
            .id()
            .to_string(),
        blob_commit(&repo, "main")
    );
}

fn blob_commit(repo: &RepoPath, revision: &str) -> String {
    Repository::open(&repo.0)
        .unwrap()
        .revparse_single(revision)
        .unwrap()
        .peel_to_commit()
        .unwrap()
        .id()
        .to_string()
}

// 8.
#[tokio::test]
async fn case_08_rebase_reports_the_onto_branch_as_ours_and_inverted() {
    let (_directory, repo, backend) = both_modified();
    run_git_success(&backend, &repo, &["checkout", "-q", "topic"]);
    assert!(!run_git_status_with_env(
        &backend,
        &repo,
        &["rebase", "main"],
        &[("GIT_EDITOR", "true")]
    )
    .success());
    assert!(matches!(
        backend.operation_state(&repo).await.unwrap().operation,
        RepoOperation::Rebase { .. }
    ));

    let set = backend.conflicts(&repo).await.unwrap();

    assert_eq!(set.sides.ours_label, "main");
    assert_eq!(set.sides.theirs_label, "topic");
    assert!(set.sides.inverted);
    // Git's "ours" during a rebase really is the onto-branch.
    assert_eq!(
        set.entries[0].ours.as_ref().unwrap().blob.0,
        blob_at(&repo, "main", "a.txt")
    );
    resolve(&backend, &repo, "a.txt", ConflictResolution::TakeOurs)
        .await
        .unwrap();
    assert_eq!(
        stage0_blob(&repo, "a.txt"),
        Some(blob_at(&repo, "main", "a.txt"))
    );
    let done = resolve(&backend, &repo, "b.txt", ConflictResolution::TakeTheirs)
        .await
        .unwrap();
    assert_eq!(done.total, 0);
    assert_eq!(
        stage0_blob(&repo, "b.txt"),
        Some(blob_at(&repo, "topic", "b.txt"))
    );
    let state = backend.continue_operation(&repo).await.unwrap();
    assert_eq!(state.operation, RepoOperation::Normal);
}

// 9.
#[tokio::test]
async fn case_09_resolution_works_against_a_conflicted_stash_apply() {
    let (_directory, repo) = empty_repo();
    let backend = LocalGitBackend::new();
    write_file(&repo, "a.txt", "base\n");
    commit_all(&backend, &repo, "base");
    write_file(&repo, "a.txt", "stashed\n");
    run_git_success(&backend, &repo, &["stash", "push", "-m", "work"]);
    write_file(&repo, "a.txt", "committed\n");
    commit_all(&backend, &repo, "upstream change");
    let stash = backend.stashes(&repo).await.unwrap().remove(0);

    let applied = backend.apply_stash(&repo, &stash.id, false).await.unwrap();
    assert!(matches!(
        applied.outcome,
        StashApplyOutcome::Conflicted { .. }
    ));
    assert_eq!(
        backend.operation_state(&repo).await.unwrap().operation,
        RepoOperation::Normal
    );

    let set = backend.conflicts(&repo).await.unwrap();
    assert_eq!(conflicted_paths(&set), ["a.txt"]);
    assert_eq!(set.sides.ours_label, "main");
    assert_eq!(set.sides.theirs_label, "stash@{0}");
    let done = resolve(&backend, &repo, "a.txt", ConflictResolution::TakeTheirs)
        .await
        .unwrap();
    assert_eq!(done.total, 0);
    assert_eq!(
        std::fs::read_to_string(repo.0.join("a.txt")).unwrap(),
        "stashed\n"
    );
}

// 10.
#[tokio::test]
async fn case_10_resolving_the_last_path_enables_continue_through_the_existing_derivation() {
    let (_directory, repo, backend) = both_modified();
    merge_topic(&backend, &repo);
    let before = backend.operation_state(&repo).await.unwrap();
    assert!(!before.available.contains(&OperationControl::Continue));

    resolve(&backend, &repo, "a.txt", ConflictResolution::TakeOurs)
        .await
        .unwrap();
    let partial = backend.operation_state(&repo).await.unwrap();
    assert_eq!(partial.conflicted_paths, ["b.txt"]);
    assert!(!partial.available.contains(&OperationControl::Continue));

    resolve(&backend, &repo, "b.txt", ConflictResolution::TakeOurs)
        .await
        .unwrap();
    let after = backend.operation_state(&repo).await.unwrap();
    assert!(after.conflicted_paths.is_empty());
    assert_eq!(
        after.available,
        [OperationControl::Continue, OperationControl::Abort]
    );
}

// 11.
#[tokio::test]
async fn case_11_generations_advance_working_tree_only_and_stale_views_are_refused() {
    let (_directory, repo, backend) = both_modified();
    merge_topic(&backend, &repo);
    let before = backend.generations(&repo).unwrap();

    let resolved = backend
        .resolve_conflict(&repo, "a.txt", ConflictResolution::TakeOurs, false, before)
        .await
        .unwrap();
    let after = backend.generations(&repo).unwrap();
    assert_eq!(
        after,
        GenerationSet {
            working_tree: before.working_tree + 1,
            ..before
        }
    );
    assert_eq!(resolved.generations, after);

    // Refused: nothing advances.
    let refused = backend
        .resolve_conflict(&repo, "b.txt", ConflictResolution::DeleteFile, false, after)
        .await;
    assert!(matches!(
        refused,
        Err(GitError::ConflictResolutionNotApplicable)
    ));
    assert_eq!(backend.generations(&repo).unwrap(), after);

    // Stale: refused before any mutation.
    let index_before = std::fs::read(resolved_index_path(&repo)).unwrap();
    let stale = backend
        .resolve_conflict(&repo, "b.txt", ConflictResolution::TakeOurs, false, before)
        .await;
    assert!(matches!(stale, Err(GitError::PreflightStale)));
    assert_eq!(
        std::fs::read(resolved_index_path(&repo)).unwrap(),
        index_before
    );
    assert_eq!(backend.generations(&repo).unwrap(), after);

    // A path that is not a current conflict, or could escape the worktree,
    // is a stale view too.
    for path in ["keep.txt", "../outside.txt", ".git/config"] {
        assert!(matches!(
            backend
                .resolve_conflict(&repo, path, ConflictResolution::TakeOurs, false, after)
                .await,
            Err(GitError::PreflightStale)
        ));
    }
    assert_eq!(backend.generations(&repo).unwrap(), after);
}

#[tokio::test]
async fn literal_pathspecs_resolve_only_the_named_path() {
    // `[ab].txt` is a legal file name on every platform and, read as a glob,
    // would also match `a.txt`. Only the literal path may be resolved.
    let (_directory, repo, backend) = diverged(
        &[
            ("[ab].txt", Some("base glob\n")),
            ("a.txt", Some("base a\n")),
        ],
        &[
            ("[ab].txt", Some("main glob\n")),
            ("a.txt", Some("main a\n")),
        ],
        &[
            ("[ab].txt", Some("topic glob\n")),
            ("a.txt", Some("topic a\n")),
        ],
    );
    merge_topic(&backend, &repo);

    let set = resolve(&backend, &repo, "[ab].txt", ConflictResolution::TakeTheirs)
        .await
        .unwrap();

    assert_eq!(conflicted_paths(&set), ["a.txt"]);
    assert_eq!(
        stage0_blob(&repo, "[ab].txt"),
        Some(blob_at(&repo, "topic", "[ab].txt"))
    );
    assert_eq!(stage0_blob(&repo, "a.txt"), None);
}

#[tokio::test]
async fn conflict_set_is_bounded_with_an_exact_total() {
    let count = 1005;
    let names = (0..count)
        .map(|index| format!("f{index:04}.txt"))
        .collect::<Vec<_>>();
    let base = names
        .iter()
        .map(|name| (name.as_str(), Some("base\n")))
        .collect::<Vec<_>>();
    let main = names
        .iter()
        .map(|name| (name.as_str(), Some("main\n")))
        .collect::<Vec<_>>();
    let topic = names
        .iter()
        .map(|name| (name.as_str(), Some("topic\n")))
        .collect::<Vec<_>>();
    let (_directory, repo, backend) = diverged(&base, &main, &topic);
    merge_topic(&backend, &repo);

    let set = backend.conflicts(&repo).await.unwrap();

    assert_eq!(set.total, count as u32);
    assert!(set.truncated);
    assert_eq!(set.entries.len(), 1000);
    assert_eq!(set.entries[0].path, "f0000.txt");
    assert_eq!(set.entries[999].path, "f0999.txt");
    assert_eq!(
        backend
            .operation_state(&repo)
            .await
            .unwrap()
            .conflicted_paths
            .len(),
        count
    );
}

#[tokio::test]
async fn a_clean_index_has_an_empty_set() {
    let (_directory, repo, backend) = both_modified();
    let set = backend.conflicts(&repo).await.unwrap();
    assert_eq!(set.total, 0);
    assert!(set.entries.is_empty());
    assert!(set.sides.ours_label.is_empty());
}

#[tokio::test]
async fn cherry_pick_and_revert_sides_name_the_current_branch_and_the_commit() {
    let (_directory, repo, backend) = both_modified();
    assert!(!run_git_status(&backend, &repo, &["cherry-pick", "topic"]).success());
    let picked = backend.conflicts(&repo).await.unwrap();
    assert_eq!(picked.sides.ours_label, "main");
    assert_eq!(picked.sides.theirs_label, "topic");
    assert!(!picked.sides.inverted);
    run_git_success(&backend, &repo, &["cherry-pick", "--abort"]);

    // Revert the base commit's parent-less change on top of `main`: the
    // reverted commit has no ref of its own, so it is named by its short id.
    write_file(&repo, "a.txt", "main a again\n");
    commit_all(&backend, &repo, "edit again");
    let reverted = blob_commit(&repo, "main~1");
    assert!(!run_git_status(&backend, &repo, &["revert", "--no-edit", "main~1"]).success());
    let set = backend.conflicts(&repo).await.unwrap();
    assert_eq!(set.sides.ours_label, "main");
    assert!(reverted.starts_with(&set.sides.theirs_label));
    assert!(set.sides.theirs_label.len() >= 7);
}
