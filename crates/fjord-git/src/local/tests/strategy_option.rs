//! `P12-MERGE-05` (`docs/specs/branch-merge.md` §10.4): `-X ours|theirs` as a
//! typed merge option, asserted by the content that survives a real conflict.

use super::*;
use fjord_domain::MergeStrategyOption;

const BASE: &str = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\n";
// `main` edits line 2 (conflicting) and line 9 (clean on its own).
const MAIN: &str = "one\nmain two\nthree\nfour\nfive\nsix\nseven\neight\nmain nine\n";
// `topic` edits line 2 (conflicting) and line 5 (clean on its own).
const TOPIC: &str = "one\ntopic two\nthree\nfour\ntopic five\nsix\nseven\neight\nnine\n";

fn fixture() -> (TempDir, RepoPath, LocalGitBackend) {
    let (directory, repo) = empty_repo();
    let backend = LocalGitBackend::new();
    let commit = |content: &str, message: &str| {
        write_file(&repo, "shared.txt", content);
        run_git_success(&backend, &repo, &["add", "shared.txt"]);
        run_git_success(&backend, &repo, &["commit", "-q", "-m", message]);
    };
    commit(BASE, "base");
    run_git_success(&backend, &repo, &["branch", "topic"]);
    commit(MAIN, "main change");
    run_git_success(&backend, &repo, &["checkout", "-q", "topic"]);
    commit(TOPIC, "topic change");
    run_git_success(&backend, &repo, &["checkout", "-q", "main"]);
    (directory, repo, backend)
}

async fn merge(
    backend: &LocalGitBackend,
    repo: &RepoPath,
    strategy_option: Option<MergeStrategyOption>,
) -> MergeOutcome {
    backend
        .merge_branch_with_options(
            repo,
            &local_merge_source("topic"),
            MergeMode::Default,
            MergeDirtyPolicy::Refuse,
            fjord_ports::MergeBranchOptions {
                allow_unrelated_histories: false,
                message: None,
                strategy_option,
            },
            GitOperationContext::default(),
        )
        .await
        .unwrap()
        .outcome
}

fn committed_shared(repo: &RepoPath) -> String {
    String::from_utf8(head_blob(repo, "shared.txt")).unwrap()
}

fn head_parents(repo: &RepoPath) -> usize {
    Repository::open(&repo.0)
        .unwrap()
        .head()
        .unwrap()
        .peel_to_commit()
        .unwrap()
        .parent_count()
}

#[tokio::test]
async fn without_an_option_the_same_lines_conflict() {
    let (_directory, repo, backend) = fixture();
    assert!(matches!(
        merge(&backend, &repo, None).await,
        MergeOutcome::Conflicted { .. }
    ));
}

#[tokio::test]
async fn prefer_target_keeps_the_checked_out_branch_for_conflicting_lines_only() {
    let (_directory, repo, backend) = fixture();

    let outcome = merge(&backend, &repo, Some(MergeStrategyOption::PreferTarget)).await;

    assert!(matches!(outcome, MergeOutcome::Merged { .. }));
    assert_eq!(head_parents(&repo), 2);
    // Line 2 is `main`'s; `topic`'s non-conflicting line 5 still arrives.
    assert_eq!(
        committed_shared(&repo),
        "one\nmain two\nthree\nfour\ntopic five\nsix\nseven\neight\nmain nine\n"
    );
    assert_eq!(
        backend.operation_state(&repo).await.unwrap().operation,
        RepoOperation::Normal
    );
}

#[tokio::test]
async fn prefer_source_takes_the_merged_branch_for_conflicting_lines_only() {
    let (_directory, repo, backend) = fixture();

    let outcome = merge(&backend, &repo, Some(MergeStrategyOption::PreferSource)).await;

    assert!(matches!(outcome, MergeOutcome::Merged { .. }));
    assert_eq!(head_parents(&repo), 2);
    // Line 2 is `topic`'s; `main`'s non-conflicting line 9 is kept.
    assert_eq!(
        committed_shared(&repo),
        "one\ntopic two\nthree\nfour\ntopic five\nsix\nseven\neight\nmain nine\n"
    );
}
