//! `P12-MERGE-04` (`docs/specs/branch-merge.md` §10.3): fast-forwarding a
//! local branch that is not checked out, against real repositories.

use super::*;
use fjord_domain::CommitId;

fn rev(backend: &LocalGitBackend, repo: &RepoPath, revision: &str) -> String {
    String::from_utf8(git_output(backend, repo, &["rev-parse", revision]))
        .unwrap()
        .trim()
        .to_string()
}

fn commit_file(backend: &LocalGitBackend, repo: &RepoPath, path: &str, content: &str) {
    write_file(repo, path, content);
    run_git_success(backend, repo, &["add", path]);
    run_git_success(backend, repo, &["commit", "-q", "-m", content.trim()]);
}

/// `main` is checked out and dirty. `release` sits at the base; the
/// remote-tracking `origin/release` is two commits ahead of it.
fn fixture() -> (TempDir, RepoPath, LocalGitBackend) {
    let (directory, repo) = empty_repo();
    let backend = LocalGitBackend::new();
    commit_file(&backend, &repo, "base.txt", "base\n");
    run_git_success(&backend, &repo, &["branch", "release"]);
    run_git_success(&backend, &repo, &["checkout", "-q", "-b", "incoming"]);
    commit_file(&backend, &repo, "one.txt", "one\n");
    commit_file(&backend, &repo, "two.txt", "two\n");
    let incoming = rev(&backend, &repo, "incoming");
    run_git_success(
        &backend,
        &repo,
        &["update-ref", "refs/remotes/origin/release", &incoming],
    );
    run_git_success(&backend, &repo, &["checkout", "-q", "main"]);
    run_git_success(&backend, &repo, &["branch", "-D", "incoming"]);
    write_file(&repo, "base.txt", "dirty edit\n");
    write_file(&repo, "untracked.txt", "untracked\n");
    run_git_success(&backend, &repo, &["add", "untracked.txt"]);
    (directory, repo, backend)
}

fn upstream() -> MergeSource {
    MergeSource {
        ref_name: "refs/remotes/origin/release".into(),
        kind: MergeSourceKind::RemoteTracking,
    }
}

/// Everything a fast-forward of a non-checked-out branch must not touch.
fn untouched_state(
    backend: &LocalGitBackend,
    repo: &RepoPath,
) -> (Vec<u8>, String, Vec<u8>, Vec<u8>) {
    (
        std::fs::read(repo.0.join(".git/HEAD")).unwrap(),
        rev(backend, repo, "HEAD"),
        git_output(
            backend,
            repo,
            &["status", "--porcelain=v2", "--untracked-files=all"],
        ),
        std::fs::read(resolved_index_path(repo)).unwrap(),
    )
}

async fn update(
    backend: &LocalGitBackend,
    repo: &RepoPath,
    branch: &str,
    source: &MergeSource,
    expected_tip: &str,
) -> Result<GenerationSet, GitError> {
    backend
        .update_branch_fast_forward(repo, branch, source, &CommitId(expected_tip.into()))
        .await
}

#[tokio::test]
async fn fast_forwards_to_the_exact_source_tip_leaving_head_and_the_worktree_alone() {
    let (_directory, repo, backend) = fixture();
    let before_state = untouched_state(&backend, &repo);
    let before = backend.generations(&repo).unwrap();
    let old = rev(&backend, &repo, "release");
    let target = rev(&backend, &repo, "origin/release");

    let generations = update(&backend, &repo, "release", &upstream(), &old)
        .await
        .unwrap();

    assert_eq!(rev(&backend, &repo, "release"), target);
    assert_eq!(untouched_state(&backend, &repo), before_state);
    assert_eq!(
        generations,
        GenerationSet {
            refs: before.refs + 1,
            history: before.history + 1,
            ..before
        }
    );
    assert_eq!(backend.generations(&repo).unwrap(), generations);
    let reflog = String::from_utf8(git_output(
        &backend,
        &repo,
        &[
            "reflog",
            "show",
            "--format=%gs",
            "-n",
            "1",
            "refs/heads/release",
        ],
    ))
    .unwrap();
    assert_eq!(
        reflog.trim(),
        "fjord: fast-forward from refs/remotes/origin/release"
    );
}

#[tokio::test]
async fn accepts_a_tag_or_a_commit_as_the_source() {
    let (_directory, repo, backend) = fixture();
    let target = rev(&backend, &repo, "origin/release");
    let middle = rev(&backend, &repo, "origin/release~1");
    run_git_success(&backend, &repo, &["tag", "v1", &middle]);

    update(
        &backend,
        &repo,
        "release",
        &MergeSource {
            ref_name: "refs/tags/v1".into(),
            kind: MergeSourceKind::Tag,
        },
        &rev(&backend, &repo, "release"),
    )
    .await
    .unwrap();
    assert_eq!(rev(&backend, &repo, "release"), middle);

    update(
        &backend,
        &repo,
        "release",
        &MergeSource {
            ref_name: target.clone(),
            kind: MergeSourceKind::Commit,
        },
        &middle,
    )
    .await
    .unwrap();
    assert_eq!(rev(&backend, &repo, "release"), target);
}

#[tokio::test]
async fn refuses_the_branch_checked_out_in_the_main_worktree() {
    let (_directory, repo, backend) = fixture();
    run_git_success(
        &backend,
        &repo,
        &[
            "update-ref",
            "refs/remotes/origin/main",
            &rev(&backend, &repo, "origin/release"),
        ],
    );
    let before_state = untouched_state(&backend, &repo);
    let before = backend.generations(&repo).unwrap();
    let main = rev(&backend, &repo, "main");

    let refused = update(
        &backend,
        &repo,
        "main",
        &MergeSource {
            ref_name: "refs/remotes/origin/main".into(),
            kind: MergeSourceKind::RemoteTracking,
        },
        &main,
    )
    .await;

    assert!(matches!(refused, Err(GitError::BranchUpdateCheckedOut)));
    assert_eq!(rev(&backend, &repo, "main"), main);
    assert_eq!(untouched_state(&backend, &repo), before_state);
    assert_eq!(backend.generations(&repo).unwrap(), before);
}

#[tokio::test]
async fn refuses_a_branch_checked_out_in_a_linked_worktree() {
    let (directory, repo, backend) = fixture();
    let linked = directory.path().with_extension("release-wt");
    run_git_success(
        &backend,
        &repo,
        &["worktree", "add", "-q", linked.to_str().unwrap(), "release"],
    );
    let before = backend.generations(&repo).unwrap();
    let old = rev(&backend, &repo, "release");

    let refused = update(&backend, &repo, "release", &upstream(), &old).await;

    assert!(matches!(refused, Err(GitError::BranchUpdateCheckedOut)));
    assert_eq!(rev(&backend, &repo, "release"), old);
    assert_eq!(backend.generations(&repo).unwrap(), before);
    run_git_success(
        &backend,
        &repo,
        &["worktree", "remove", "--force", linked.to_str().unwrap()],
    );
}

#[tokio::test]
async fn refuses_a_branch_a_worktree_is_rebasing() {
    let (_directory, repo, backend) = fixture();
    let rebase_dir = repo.0.join(".git/rebase-merge");
    std::fs::create_dir(&rebase_dir).unwrap();
    std::fs::write(rebase_dir.join("head-name"), "refs/heads/release\n").unwrap();
    let old = rev(&backend, &repo, "release");

    let refused = update(&backend, &repo, "release", &upstream(), &old).await;

    assert!(matches!(refused, Err(GitError::BranchUpdateCheckedOut)));
    assert_eq!(rev(&backend, &repo, "release"), old);
}

#[tokio::test]
async fn refuses_a_diverged_source_and_changes_nothing() {
    let (_directory, repo, backend) = fixture();
    run_git_success(&backend, &repo, &["stash", "-q", "-u"]);
    run_git_success(&backend, &repo, &["checkout", "-q", "release"]);
    commit_file(&backend, &repo, "local.txt", "local only\n");
    run_git_success(&backend, &repo, &["checkout", "-q", "main"]);
    run_git_success(&backend, &repo, &["stash", "pop", "-q"]);
    let before_state = untouched_state(&backend, &repo);
    let before = backend.generations(&repo).unwrap();
    let old = rev(&backend, &repo, "release");

    let refused = update(&backend, &repo, "release", &upstream(), &old).await;

    assert!(matches!(refused, Err(GitError::BranchUpdateNotFastForward)));
    assert_eq!(rev(&backend, &repo, "release"), old);
    assert_eq!(untouched_state(&backend, &repo), before_state);
    assert_eq!(backend.generations(&repo).unwrap(), before);
}

#[tokio::test]
async fn refuses_when_already_up_to_date_or_the_view_is_stale() {
    let (_directory, repo, backend) = fixture();
    let old = rev(&backend, &repo, "release");
    let target = rev(&backend, &repo, "origin/release");
    let before = backend.generations(&repo).unwrap();

    assert!(matches!(
        update(&backend, &repo, "release", &upstream(), &target).await,
        Err(GitError::PreflightStale)
    ));
    assert!(matches!(
        update(&backend, &repo, "nope", &upstream(), &old).await,
        Err(GitError::BranchUpdateBranchNotFound)
    ));
    assert!(matches!(
        update(&backend, &repo, "../main", &upstream(), &old).await,
        Err(GitError::BranchUpdateBranchNotFound)
    ));
    // A source behind the branch is "up to date", never a rewind.
    let base_source = MergeSource {
        ref_name: old.clone(),
        kind: MergeSourceKind::Commit,
    };
    update(&backend, &repo, "release", &upstream(), &old)
        .await
        .unwrap();
    assert!(matches!(
        update(&backend, &repo, "release", &base_source, &target).await,
        Err(GitError::BranchUpdateAlreadyUpToDate)
    ));
    assert!(matches!(
        update(&backend, &repo, "release", &upstream(), &target).await,
        Err(GitError::BranchUpdateAlreadyUpToDate)
    ));
    assert_eq!(rev(&backend, &repo, "release"), target);
    assert_eq!(
        backend.generations(&repo).unwrap(),
        GenerationSet {
            refs: before.refs + 1,
            history: before.history + 1,
            ..before
        }
    );
}

#[tokio::test]
async fn a_ref_moved_between_the_check_and_the_write_fails_instead_of_clobbering() {
    let (_directory, repo, backend) = fixture();
    let old = rev(&backend, &repo, "release");
    let concurrent = rev(&backend, &repo, "origin/release~1");
    let before = backend.generations(&repo).unwrap();
    let mut pause = patch_transaction::install_mutation_pause(&repo);

    let task = {
        let backend_repo = repo.clone();
        let old = old.clone();
        tokio::spawn(async move {
            let backend = LocalGitBackend::new();
            update(&backend, &backend_repo, "release", &upstream(), &old).await
        })
    };
    pause.wait_until_reached().await;
    // Another client moves the branch after Fjord verified ancestry.
    run_git_success(
        &backend,
        &repo,
        &["update-ref", "refs/heads/release", &concurrent, &old],
    );
    pause.resume();
    let result = task.await.unwrap();

    assert!(matches!(result, Err(GitError::BranchUpdateRefMoved)));
    assert_eq!(rev(&backend, &repo, "release"), concurrent);
    assert_eq!(backend.generations(&repo).unwrap(), before);
}
