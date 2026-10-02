//! Regressions found by comparing an independent implementation of
//! `P10-01`–`P10-03` and `P10-11` against the shipped one.

use super::*;
use fjord_domain::{Consequence, DestructiveAction, RebaseTodoAction, WorktreeBranch};

/// A sibling unique to this fixture, so parallel tests never share a path.
fn sibling(repo: &RepoPath, name: &str) -> PathBuf {
    let fixture = repo.0.file_name().unwrap().to_string_lossy();
    repo.0.with_file_name(format!("{fixture}-{name}"))
}

/// Returns the worktree's path and the administrative name Git gave it.
async fn add_worktree(backend: &LocalGitBackend, repo: &RepoPath, name: &str) -> (PathBuf, String) {
    let path = sibling(repo, name);
    let created = backend
        .create_worktree(
            repo,
            name,
            &path,
            WorktreeBranch::New {
                name: name.into(),
                start_point: "HEAD".into(),
            },
        )
        .await
        .unwrap();
    (path, created.name)
}

async fn confirm_removal(
    backend: &LocalGitBackend,
    repo: &RepoPath,
    action: &DestructiveAction,
) -> (GenerationSet, String) {
    let generations = backend.generations(repo).unwrap();
    let token = backend
        .issue_action_confirmation(repo, action, generations)
        .await
        .unwrap();
    (generations, token)
}

fn worktree_names(worktrees: &[fjord_domain::Worktree]) -> Vec<String> {
    let mut names = worktrees
        .iter()
        .filter(|worktree| !worktree.is_main)
        .map(|worktree| worktree.name.clone())
        .collect::<Vec<_>>();
    names.sort();
    names
}

#[tokio::test]
async fn removing_one_missing_worktree_keeps_the_other_missing_ones() {
    let (_directory, repo) = empty_repo();
    let backend = LocalGitBackend::new();
    commit_with_cli(&backend, &repo, "base\n", "base");
    let mut names = Vec::new();
    for name in ["gone-a", "gone-b"] {
        let (path, name) = add_worktree(&backend, &repo, name).await;
        std::fs::remove_dir_all(path).unwrap();
        names.push(name);
    }

    backend
        .remove_worktree(&repo, &names[0], false)
        .await
        .unwrap();

    assert_eq!(
        worktree_names(&backend.worktrees(&repo).await.unwrap()),
        [names[1].clone()]
    );
}

#[tokio::test]
async fn a_forced_removal_refuses_work_written_after_its_preflight() {
    let (_directory, repo) = empty_repo();
    let backend = LocalGitBackend::new();
    commit_with_cli(&backend, &repo, "base\n", "base");
    let (path, name) = add_worktree(&backend, &repo, "wt-forced").await;
    let action = DestructiveAction::RemoveWorktree { name, force: true };
    let (generations, token) = confirm_removal(&backend, &repo, &action).await;
    // Another worktree's files are invisible to this repository's generations.
    std::fs::write(path.join("written-after-preflight.txt"), "precious").unwrap();
    assert_eq!(backend.generations(&repo).unwrap(), generations);

    let stale = backend
        .execute_confirmed_destructive_action(
            &repo,
            &action,
            generations,
            &token,
            GitOperationContext::default(),
        )
        .await;

    assert!(matches!(stale, Err(GitError::PreflightStale)), "{stale:?}");
    assert!(path.join("written-after-preflight.txt").exists());

    // A fresh confirmation of the new state removes it.
    let (generations, token) = confirm_removal(&backend, &repo, &action).await;
    backend
        .execute_confirmed_destructive_action(
            &repo,
            &action,
            generations,
            &token,
            GitOperationContext::default(),
        )
        .await
        .unwrap();
    assert!(!path.exists());
}

#[tokio::test]
async fn removing_a_detached_worktree_reports_commits_only_it_retains() {
    let (_directory, repo) = empty_repo();
    let backend = LocalGitBackend::new();
    commit_with_cli(&backend, &repo, "base\n", "base");
    let path = sibling(&repo, "wt-detached");
    run_git_success(
        &backend,
        &repo,
        &["worktree", "add", "-q", "--detach", path.to_str().unwrap()],
    );
    commit_with_cli(&backend, &RepoPath::new(path), "only here\n", "only here");
    let name = backend
        .worktrees(&repo)
        .await
        .unwrap()
        .into_iter()
        .find(|worktree| !worktree.is_main)
        .unwrap()
        .name;

    let facts = backend
        .destructive_action_facts(
            &repo,
            &DestructiveAction::RemoveWorktree { name, force: false },
            5,
        )
        .await
        .unwrap();

    assert!(facts.consequences.iter().any(|consequence| matches!(
        consequence,
        Consequence::CommitsUnreachable { count: 1, sample } if sample[0].message == "only here"
    )));
}

#[tokio::test]
async fn interactive_rebase_edits_an_already_based_branch_and_flags_published_commits() {
    let (_directory, repo) = empty_repo();
    let backend = LocalGitBackend::new();
    commit_with_cli(&backend, &repo, "base\n", "base");
    run_git_success(&backend, &repo, &["checkout", "-q", "-b", "feature"]);
    for name in ["one", "two", "three"] {
        write_file(&repo, &format!("{name}.txt"), name);
        run_git_success(&backend, &repo, &["add", "."]);
        run_git_success(&backend, &repo, &["commit", "-q", "-m", name]);
    }
    // `one` is published through a locally known upstream.
    run_git_success(&backend, &repo, &["branch", "upstream-feature", "HEAD~2"]);
    run_git_success(
        &backend,
        &repo,
        &["branch", "--set-upstream-to=upstream-feature"],
    );

    let mut todo = backend
        .rebase_todo(&repo, &local_merge_source("main"))
        .await
        .unwrap();
    assert!(todo.preflight.already_up_to_date);
    assert_eq!(
        todo.steps
            .iter()
            .map(|step| (step.subject.as_str(), step.published))
            .collect::<Vec<_>>(),
        [("one", true), ("two", false), ("three", false)]
    );

    // The unedited todo stays a no-op …
    let head = git_output(&backend, &repo, &["rev-parse", "HEAD"]);
    backend
        .start_interactive_rebase(
            &repo,
            &todo.preflight,
            &todo.steps,
            MergeDirtyPolicy::Refuse,
            GitOperationContext::default(),
        )
        .await
        .unwrap();
    assert_eq!(git_output(&backend, &repo, &["rev-parse", "HEAD"]), head);

    // … while an edit of the branch's own commits is applied.
    todo.steps[1].action = RebaseTodoAction::Drop;
    let result = backend
        .start_interactive_rebase(
            &repo,
            &todo.preflight,
            &todo.steps,
            MergeDirtyPolicy::Refuse,
            GitOperationContext::default(),
        )
        .await
        .unwrap();
    assert_normal_operation(&result.state);
    assert_eq!(
        String::from_utf8(git_output(
            &backend,
            &repo,
            &["log", "--reverse", "--format=%s", "main..HEAD"]
        ))
        .unwrap(),
        "one\nthree\n"
    );
}

#[tokio::test]
async fn skipping_a_conflicting_reword_never_rewords_another_commit() {
    let (_directory, repo, backend) = divergent_operation_fixture();
    run_git_success(&backend, &repo, &["checkout", "topic"]);
    write_file(&repo, "second.txt", "second\n");
    run_git_success(&backend, &repo, &["add", "second.txt"]);
    run_git_success(&backend, &repo, &["commit", "-q", "-m", "second"]);
    let mut todo = backend
        .rebase_todo(&repo, &local_merge_source("main"))
        .await
        .unwrap();
    todo.steps[0].action = RebaseTodoAction::Reword {
        message: "REWORDED FIRST".into(),
    };
    todo.steps[1].action = RebaseTodoAction::Reword {
        message: "REWORDED SECOND".into(),
    };

    let state = backend
        .start_interactive_rebase(
            &repo,
            &todo.preflight,
            &todo.steps,
            MergeDirtyPolicy::Refuse,
            GitOperationContext::default(),
        )
        .await
        .unwrap()
        .state;
    assert_eq!(state.conflicted_paths, ["operation.txt"]);

    let resumed = backend.skip_operation(&repo).await.unwrap();

    assert_normal_operation(&resumed);
    assert_no_rebase_markers(&repo);
    assert!(!repo.0.join(".git/fjord-rebase-plan").exists());
    // The skipped commit's message is dropped with it; the target commit keeps
    // its own message and the second reword still applies to its own commit.
    assert_eq!(
        String::from_utf8(git_output(&backend, &repo, &["log", "--format=%s", "-3"])).unwrap(),
        "REWORDED SECOND\nmain change\nbase\n"
    );
}
