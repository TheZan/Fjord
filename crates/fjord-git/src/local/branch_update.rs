//! **Update `<branch>` from `<source>`**: a fast-forward of a local branch
//! that is not checked out (`docs/specs/branch-merge.md` §10.3,
//! `P12-MERGE-04`).
//!
//! Not a merge: it can never create a commit or a conflict. Ancestry is
//! verified with `graph_descendant_of` under the repository write lock, and
//! the move is applied by `git update-ref <ref> <new> <old>` — a
//! compare-and-swap on the old value — so a concurrent change fails instead
//! of being clobbered. No checkout, no working-tree write, no network.

use std::ffi::OsString;
use std::path::Path;
use std::process::Stdio;

use fjord_domain::{CommitId, MergeSource};

use super::*;

pub(super) async fn run(
    commands: &GitCommandFactory,
    repo: &RepoPath,
    branch: &str,
    source: &MergeSource,
    expected_tip: &CommitId,
) -> Result<crate::GenerationSet, GitError> {
    let commands = commands.clone();
    let repo = repo.clone();
    let branch = branch.to_string();
    let source = source.clone();
    let expected_tip = expected_tip.clone();
    let _guard = LocalGitBackend::acquire_repo_write_lock(&repo).await;
    tokio::task::spawn_blocking(move || {
        run_locked(&commands, &repo, &branch, &source, &expected_tip)
    })
    .await
    .map_err(|error| GitError::Git2(error.to_string()))?
}

/// What the write-lock checks established, before any ref moves.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct FastForwardPlan {
    pub ref_name: String,
    pub old: git2::Oid,
    pub new: git2::Oid,
}

fn run_locked(
    commands: &GitCommandFactory,
    repo: &RepoPath,
    branch: &str,
    source: &MergeSource,
    expected_tip: &CommitId,
) -> Result<crate::GenerationSet, GitError> {
    let checked_out = checked_out_branches(commands, repo)?;
    let plan = LocalGitBackend::with_runtime_git2(repo, |git| {
        plan(git, branch, source, expected_tip, &checked_out)
    })?;

    super::patch_transaction::pause_before_mutation(repo);
    update_ref(commands, repo, &plan, &source.ref_name)?;
    runtime::bump_mutation(repo, MutationKind::FastForwardBranch);
    runtime::generations(repo)
}

/// Every check the fast-forward depends on, in refusal order.
pub(super) fn plan(
    git: &git2::Repository,
    branch: &str,
    source: &MergeSource,
    expected_tip: &CommitId,
    checked_out: &[String],
) -> Result<FastForwardPlan, GitError> {
    let ref_name = format!("refs/heads/{branch}");
    if branch.is_empty() || !git2::Reference::is_valid_name(&ref_name) {
        return Err(GitError::BranchUpdateBranchNotFound);
    }
    let old = match git.find_reference(&ref_name) {
        Ok(reference) => reference
            .peel_to_commit()
            .map_err(LocalGitBackend::map_git2_error)?
            .id(),
        Err(error) if error.code() == ErrorCode::NotFound => {
            return Err(GitError::BranchUpdateBranchNotFound)
        }
        Err(error) => return Err(LocalGitBackend::map_git2_error(error)),
    };
    if checked_out.iter().any(|name| name == branch) {
        return Err(GitError::BranchUpdateCheckedOut);
    }
    if old.to_string() != expected_tip.0 {
        return Err(GitError::PreflightStale);
    }
    let kind = integration::classify_source(&source.ref_name)?;
    let new = integration::resolve_source_commit(git, source, kind)?.id();
    if new == old
        || git
            .graph_descendant_of(old, new)
            .map_err(LocalGitBackend::map_git2_error)?
    {
        return Err(GitError::BranchUpdateAlreadyUpToDate);
    }
    if !git
        .graph_descendant_of(new, old)
        .map_err(LocalGitBackend::map_git2_error)?
    {
        return Err(GitError::BranchUpdateNotFastForward);
    }
    Ok(FastForwardPlan { ref_name, old, new })
}

/// Branches that must not move underneath a worktree: the branch checked out
/// in the main or any linked worktree, plus any branch a worktree is in the
/// middle of rebasing (its `HEAD` is detached, but Git still owns the branch).
fn checked_out_branches(
    commands: &GitCommandFactory,
    repo: &RepoPath,
) -> Result<Vec<String>, GitError> {
    let mut names = super::worktrees::list_uncached(commands, repo)?
        .into_iter()
        .filter_map(|worktree| worktree.branch)
        .collect::<Vec<_>>();
    let common = LocalGitBackend::with_runtime_git2(repo, |git| Ok(git.commondir().to_path_buf()))?;
    let mut git_dirs = vec![common.clone()];
    if let Ok(entries) = std::fs::read_dir(common.join("worktrees")) {
        git_dirs.extend(entries.flatten().map(|entry| entry.path()));
    }
    for git_dir in git_dirs {
        names.extend(rebasing_branch(&git_dir));
    }
    Ok(names)
}

fn rebasing_branch(git_dir: &Path) -> Option<String> {
    ["rebase-merge", "rebase-apply"]
        .iter()
        .find_map(|directory| {
            std::fs::read_to_string(git_dir.join(directory).join("head-name"))
                .ok()
                .and_then(|name| name.trim().strip_prefix("refs/heads/").map(str::to_string))
        })
}

/// The update-ref invocation: the ref, the new value and the expected old
/// value are separate arguments; Git refuses unless the ref still holds `old`.
pub(super) fn update_ref_args(plan: &FastForwardPlan, source_label: &str) -> Vec<OsString> {
    vec![
        OsString::from("update-ref"),
        OsString::from("-m"),
        OsString::from(format!("fjord: fast-forward from {source_label}")),
        OsString::from(&plan.ref_name),
        OsString::from(plan.new.to_string()),
        OsString::from(plan.old.to_string()),
    ]
}

fn update_ref(
    commands: &GitCommandFactory,
    repo: &RepoPath,
    plan: &FastForwardPlan,
    source_label: &str,
) -> Result<(), GitError> {
    let output = commands
        .command()?
        .args(update_ref_args(plan, source_label))
        .current_dir(&repo.0)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .env("LANG", "C")
        .stdin(Stdio::null())
        .output()
        .map_err(|error| {
            GitError::Git2(format!("failed to run git update-ref: {}", error.kind()))
        })?;
    if output.status.success() {
        return Ok(());
    }
    // The only expected failure is the compare-and-swap: the ref no longer
    // holds `old`. Anything that moved it wins; nothing is overwritten.
    let current = LocalGitBackend::with_runtime_git2(repo, |git| {
        Ok(git
            .find_reference(&plan.ref_name)
            .ok()
            .and_then(|reference| reference.target()))
    })?;
    if current != Some(plan.old) {
        return Err(GitError::BranchUpdateRefMoved);
    }
    Err(GitError::Git2(
        String::from_utf8_lossy(&output.stderr)
            .trim()
            .chars()
            .take(4096)
            .collect(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn update_ref_arguments_are_a_compare_and_swap_with_no_shell_string() {
        let plan = FastForwardPlan {
            ref_name: "refs/heads/main".into(),
            old: git2::Oid::from_str("1111111111111111111111111111111111111111").unwrap(),
            new: git2::Oid::from_str("2222222222222222222222222222222222222222").unwrap(),
        };
        let args = update_ref_args(&plan, "refs/remotes/origin/main; rm -rf /")
            .into_iter()
            .map(|arg| arg.into_string().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            args,
            [
                "update-ref",
                "-m",
                "fjord: fast-forward from refs/remotes/origin/main; rm -rf /",
                "refs/heads/main",
                "2222222222222222222222222222222222222222",
                "1111111111111111111111111111111111111111",
            ]
        );
    }

    #[test]
    fn rebasing_branch_reads_both_backends() {
        let directory = tempfile::TempDir::new().unwrap();
        assert_eq!(rebasing_branch(directory.path()), None);
        std::fs::create_dir(directory.path().join("rebase-apply")).unwrap();
        std::fs::write(
            directory.path().join("rebase-apply/head-name"),
            "refs/heads/topic\n",
        )
        .unwrap();
        assert_eq!(rebasing_branch(directory.path()), Some("topic".into()));
    }
}
