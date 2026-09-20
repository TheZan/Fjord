//! Interactive rebase: Fjord writes the todo list Git reads and drives its
//! own synthetic pause points to apply reword/squash messages, without ever
//! opening an interactive editor. Git still owns the sequencer — Phase 9's
//! Continue/Skip/Abort remain the only controls that touch it once a real
//! conflict appears; see `docs/specs/workspace-workflows.md` §2 and
//! `docs/specs/repository-safety.md` §2.
//!
//! Git's todo grammar includes `break`, exposed precisely so a script or GUI
//! can stop the sequencer without applying a commit. Every `Reword`/`Squash`
//! step compiles to its commit line(s) followed by a `break`; the exact
//! message to apply at that break is queued, in order, as one file per
//! pending message under the repository's git-dir. Draining that queue
//! (amend, then `rebase --continue`) is shared with the Phase 9 Continue
//! control in `operation_control.rs`, so a real conflict encountered
//! mid-sequence still surfaces normally, and a later manual Continue resumes
//! the same drain exactly where it left off.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use fjord_domain::{
    CommitId, IntegrationBlocker, InteractiveRebaseTodo, MergeDirtyPolicy, MergeSource, RebaseKind,
    RebasePreflight, RebaseResult, RebaseTodoAction, RebaseTodoStep, RepoOperation,
    RepoOperationState,
};
use fjord_ports::{GitError, GitOperationContext, RepoPath};

use crate::executable::GitCommandFactory;
use crate::generation::MutationKind;
use crate::remote::process_runner::{GitCommandSpec, GitProcessRunner};

use super::integration;
use super::operation_control::{command_spec, current_state, map_process_error, step_diagnostics};
use super::operation_state::{OperationFamily, OperationOriginTracker};
use super::rebase::{observe, preflight_locked, retained, TodoCommitEntry};
use super::{bump_repository_mutation, LocalGitBackend};

const PLAN_DIR_NAME: &str = "fjord-rebase-plan";
const TODO_SOURCE_FILE_NAME: &str = "fjord-rebase-todo-source";

/// The same preflight basic rebase uses, plus the seeded todo list (all
/// `Pick`, in commit order) for the editor to start from.
pub(super) async fn todo(
    commands: GitCommandFactory,
    origins: Arc<OperationOriginTracker>,
    repo: &RepoPath,
    onto: &MergeSource,
) -> Result<InteractiveRebaseTodo, GitError> {
    let _guard = LocalGitBackend::acquire_repo_read_lock(repo).await;
    let (preflight, entries) = preflight_locked(&commands, repo, onto, &origins).await?;
    let steps = entries
        .into_iter()
        .map(|entry| RebaseTodoStep {
            commit: CommitId(entry.id.to_string()),
            short_id: entry.short_id,
            subject: entry.subject,
            action: RebaseTodoAction::Pick,
        })
        .collect();
    Ok(InteractiveRebaseTodo { preflight, steps })
}

pub(super) async fn run_preflighted(
    commands: GitCommandFactory,
    origins: Arc<OperationOriginTracker>,
    repo: &RepoPath,
    expected: &RebasePreflight,
    steps: &[RebaseTodoStep],
    policy: MergeDirtyPolicy,
    context: GitOperationContext,
) -> Result<RebaseResult, GitError> {
    let _guard = LocalGitBackend::acquire_repo_write_lock(repo).await;
    let (current, entries) = preflight_locked(&commands, repo, &expected.onto, &origins).await?;
    if &current != expected {
        return Err(GitError::PreflightStale);
    }
    validate_steps(steps, &entries)?;
    for blocker in &current.blockers {
        if !matches!(
            blocker,
            IntegrationBlocker::IndexHasStagedChanges | IntegrationBlocker::WouldOverwrite
        ) || policy == MergeDirtyPolicy::Refuse
        {
            return Err(GitError::IntegrationBlocked(*blocker));
        }
    }
    let before = observe(repo, &origins).await?;
    if current.already_up_to_date {
        return Ok(RebaseResult {
            state: before.state,
            stash_ref: None,
            generations: current.generations,
        });
    }
    commands.executable()?;
    let needs_stash = policy == MergeDirtyPolicy::StashFirst
        && (current.dirty.staged > 0
            || current.dirty.modified > 0
            || !current.dirty.would_overwrite.is_empty());
    let mut stash_id = None;
    if needs_stash {
        context.emit(fjord_ports::GitProgress {
            completed: 0,
            total: 0,
            message: Some("Stashing local changes".into()),
        });
        let (created, result) = integration::stash(
            &commands,
            repo,
            format!(
                "Fjord rebase: {} -> {}",
                current.current_branch, current.onto_label
            ),
            context.clone(),
        )
        .await;
        if created {
            stash_id = integration::stash_tip(repo)?;
        }
        if let Err(error) = result {
            if created {
                bump_repository_mutation(repo, MutationKind::RebaseWithStash);
            }
            return Err(retained(repo, stash_id.as_deref(), error));
        }
        let validation = preflight_locked(&commands, repo, &expected.onto, &origins)
            .await
            .and_then(|(after, _)| {
                if after.current_branch != current.current_branch
                    || after.current_commit != current.current_commit
                    || after.onto_commit != current.onto_commit
                    || after.published_rewrite != current.published_rewrite
                {
                    return Err(GitError::PreflightStale);
                }
                if let Some(blocker) = after.blockers.first() {
                    return Err(GitError::IntegrationBlocked(*blocker));
                }
                Ok(())
            });
        if let Err(error) = validation {
            if created {
                bump_repository_mutation(repo, MutationKind::RebaseWithStash);
            }
            return Err(retained(repo, stash_id.as_deref(), error));
        }
    }
    let result = run_locked(
        commands,
        origins,
        repo,
        &current.onto_commit.0,
        steps,
        context,
        before,
        stash_id.is_some(),
    )
    .await;
    let state = result.map_err(|error| retained(repo, stash_id.as_deref(), error))?;
    Ok(RebaseResult {
        state,
        stash_ref: stash_id
            .as_deref()
            .map(|id| integration::stash_ref(repo, id)),
        generations: super::repository_generations(repo)?,
    })
}

fn validate_steps(steps: &[RebaseTodoStep], entries: &[TodoCommitEntry]) -> Result<(), GitError> {
    if steps.len() != entries.len() {
        return Err(GitError::RebaseTodoInvalid(
            "the todo list does not match the commits being rebased".into(),
        ));
    }
    let mut expected: HashSet<String> = entries.iter().map(|entry| entry.id.to_string()).collect();
    for step in steps {
        if !expected.remove(&step.commit.0) {
            return Err(GitError::RebaseTodoInvalid(
                "the todo list references an unknown or duplicate commit".into(),
            ));
        }
        let empty_message = match &step.action {
            RebaseTodoAction::Reword { message } | RebaseTodoAction::Squash { message } => {
                message.trim().is_empty()
            }
            RebaseTodoAction::Pick | RebaseTodoAction::Fixup | RebaseTodoAction::Drop => false,
        };
        if empty_message {
            return Err(GitError::RebaseTodoInvalid(
                "reword and squash require a non-empty message".into(),
            ));
        }
    }
    match steps
        .iter()
        .find(|step| !matches!(step.action, RebaseTodoAction::Drop))
    {
        Some(first)
            if matches!(
                first.action,
                RebaseTodoAction::Fixup | RebaseTodoAction::Squash { .. }
            ) =>
        {
            Err(GitError::RebaseTodoInvalid(
                "the first surviving commit cannot be a fixup or squash".into(),
            ))
        }
        Some(_) => Ok(()),
        None => Err(GitError::RebaseTodoInvalid(
            "the todo list drops every commit".into(),
        )),
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_locked(
    commands: GitCommandFactory,
    origins: Arc<OperationOriginTracker>,
    repo: &RepoPath,
    onto: &str,
    steps: &[RebaseTodoStep],
    context: GitOperationContext,
    before: super::rebase::Observation,
    stashed: bool,
) -> Result<RepoOperationState, GitError> {
    let mutation = if stashed {
        MutationKind::RebaseWithStash
    } else {
        MutationKind::Rebase
    };
    let dir = git_dir(repo).inspect_err(|_| {
        if stashed {
            bump_repository_mutation(repo, mutation);
        }
    })?;
    let (todo_content, plan) = compile_todo(steps);
    let start = (|| -> Result<PathBuf, GitError> {
        write_plan(&dir, &plan)?;
        let todo_source = dir.join(TODO_SOURCE_FILE_NAME);
        std::fs::write(&todo_source, todo_content).map_err(io_error)?;
        Ok(todo_source)
    })();
    let todo_source = start.inspect_err(|_| {
        if stashed {
            bump_repository_mutation(repo, mutation);
        }
    })?;
    let spec = interactive_rebase_spec(&commands, repo, onto, &todo_source).inspect_err(|_| {
        if stashed {
            bump_repository_mutation(repo, mutation);
        }
    })?;

    let result = GitProcessRunner.run(&spec, context.clone(), None).await;
    origins.record_if_in_progress(repo, OperationFamily::Rebase);
    let after = observe(repo, &origins).await;
    let after_failed_mid_operation =
        after.is_err() && !matches!(&result, Err(fjord_ports::GitRemoteError::SpawnFailed(_)));
    if stashed || after.as_ref().is_ok_and(|after| after != &before) || after_failed_mid_operation {
        bump_repository_mutation(repo, mutation);
    }
    let result = result.map_err(map_process_error)?;
    let state = after?.state;
    if !matches!(state.operation, RepoOperation::Rebase { .. }) && result.exit_code != Some(0) {
        let _ = clear_plan(&dir);
        return Err(GitError::OperationStepFailed(
            "Git could not start the interactive rebase".into(),
        ));
    }
    drain_synthetic_breaks(&commands, &origins, repo, context, state).await
}

/// Applies every queued reword/squash message and resumes the sequencer past
/// its own synthetic pause, stopping only on a real conflict or completion.
/// Shared by the initial start and by the Phase 9 Continue control, so a
/// conflict resolved manually and continued later drains the same queue.
pub(super) async fn drain_synthetic_breaks(
    commands: &GitCommandFactory,
    origins: &Arc<OperationOriginTracker>,
    repo: &RepoPath,
    context: GitOperationContext,
    mut state: RepoOperationState,
) -> Result<RepoOperationState, GitError> {
    while state.conflicted_paths.is_empty()
        && matches!(
            state.operation,
            RepoOperation::Rebase {
                rebase_kind: RebaseKind::Interactive,
                ..
            }
        )
    {
        let dir = git_dir(repo)?;
        let Some(message) = pop_plan_entry(&dir)? else {
            break;
        };
        amend_head_message(commands, repo, &message, context.clone()).await?;
        let spec = command_spec(
            commands.executable()?,
            repo,
            vec!["rebase".into(), "--continue".into()],
        );
        let process_result = GitProcessRunner.run(&spec, context.clone(), None).await;
        bump_repository_mutation(repo, MutationKind::OperationStep);
        let result = process_result.map_err(map_process_error)?;
        if result.exit_code != Some(0) {
            return Err(GitError::OperationStepFailed(step_diagnostics(
                &result.stderr_tail,
                &result.stdout,
            )));
        }
        state = current_state(repo, origins)?;
    }
    if !matches!(state.operation, RepoOperation::Rebase { .. }) {
        if let Ok(dir) = git_dir(repo) {
            let _ = clear_plan(&dir);
        }
    }
    Ok(state)
}

async fn amend_head_message(
    commands: &GitCommandFactory,
    repo: &RepoPath,
    message: &str,
    context: GitOperationContext,
) -> Result<(), GitError> {
    let spec = command_spec(
        commands.executable()?,
        repo,
        vec![
            "commit".into(),
            "--amend".into(),
            "-m".into(),
            message.into(),
        ],
    );
    let result = GitProcessRunner
        .run(&spec, context, None)
        .await
        .map_err(map_process_error)?;
    bump_repository_mutation(repo, MutationKind::OperationStep);
    if result.exit_code != Some(0) {
        return Err(GitError::OperationStepFailed(step_diagnostics(
            &result.stderr_tail,
            &result.stdout,
        )));
    }
    Ok(())
}

/// Compiles the edited todo list into Git's todo grammar plus the ordered
/// amend-message queue. `Reword` and `Squash` (with a message) both stop the
/// sequencer via `break` right after their commit line(s) are applied;
/// `Fixup` and a message-less `Squash` combine silently, matching Git's own
/// `fixup` (a `Squash` without a message keeps the retained commit's message,
/// same as `Fixup` — Fjord never opens an editor to concatenate messages).
fn compile_todo(steps: &[RebaseTodoStep]) -> (String, Vec<String>) {
    let mut todo = String::new();
    let mut plan = Vec::new();
    for step in steps {
        match &step.action {
            RebaseTodoAction::Drop => {
                todo.push_str(&format!("drop {} {}\n", step.commit.0, step.subject));
            }
            RebaseTodoAction::Pick => {
                todo.push_str(&format!("pick {} {}\n", step.commit.0, step.subject));
            }
            RebaseTodoAction::Fixup => {
                todo.push_str(&format!("fixup {} {}\n", step.commit.0, step.subject));
            }
            RebaseTodoAction::Reword { message } => {
                todo.push_str(&format!("pick {} {}\n", step.commit.0, step.subject));
                todo.push_str("break\n");
                plan.push(message.clone());
            }
            RebaseTodoAction::Squash { message } => {
                todo.push_str(&format!("fixup {} {}\n", step.commit.0, step.subject));
                todo.push_str("break\n");
                plan.push(message.clone());
            }
        }
    }
    (todo, plan)
}

fn interactive_rebase_spec(
    commands: &GitCommandFactory,
    repo: &RepoPath,
    onto: &str,
    todo_source: &Path,
) -> Result<GitCommandSpec, GitError> {
    let mut spec = command_spec(
        commands.executable()?,
        repo,
        [
            "-c",
            "rebase.updateRefs=false",
            "-c",
            "rebase.rebaseMerges=false",
            "-c",
            "rebase.autoSquash=false",
            "rebase",
            "--interactive",
            "--no-autostash",
            "--",
            onto,
        ]
        .into_iter()
        .map(Into::into)
        .collect(),
    );
    spec.environment.extend([
        ("GIT_NO_LAZY_FETCH".into(), "1".into()),
        ("GIT_ALLOW_PROTOCOL".into(), "".into()),
        (
            "GIT_SEQUENCE_EDITOR".into(),
            sequence_editor_command(todo_source).into(),
        ),
    ]);
    Ok(spec)
}

/// Overrides the base `GIT_SEQUENCE_EDITOR=true` (a later entry with the same
/// key wins). Git always invokes the sequence editor through its own bundled
/// shell, appending the todo path it generated as the final argument, so
/// `cp <our file>` becomes `cp <our file> <git's todo path>` and replaces
/// Git's default all-`pick` list with the one Fjord already computed —
/// without a custom editor binary. Verified on Windows, where Git's bundled
/// coreutils resolve `cp` the same way the existing `GIT_EDITOR=true` no-op
/// already relies on `true` being resolvable.
fn sequence_editor_command(todo_source: &Path) -> String {
    format!(
        "cp {}",
        shell_single_quote(&todo_source.display().to_string())
    )
}

fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

fn git_dir(repo: &RepoPath) -> Result<PathBuf, GitError> {
    LocalGitBackend::with_runtime_git2(repo, |git| Ok(git.path().to_path_buf()))
}

fn plan_dir(git_dir: &Path) -> PathBuf {
    git_dir.join(PLAN_DIR_NAME)
}

fn write_plan(git_dir: &Path, messages: &[String]) -> Result<(), GitError> {
    if messages.is_empty() {
        return Ok(());
    }
    let dir = plan_dir(git_dir);
    std::fs::create_dir_all(&dir).map_err(io_error)?;
    for (index, message) in messages.iter().enumerate() {
        std::fs::write(dir.join(format!("{:06}", index + 1)), message).map_err(io_error)?;
    }
    Ok(())
}

/// Pops the lowest-numbered pending message, if any. Filesystem order, not a
/// sequence-position match against Git's todo file: Fjord's own breaks are
/// hit in exactly the order they were written, so a FIFO queue is sufficient
/// and needs no correlation with Git's internal step numbering.
fn pop_plan_entry(git_dir: &Path) -> Result<Option<String>, GitError> {
    let dir = plan_dir(git_dir);
    let mut entries: Vec<PathBuf> = match std::fs::read_dir(&dir) {
        Ok(read) => read
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .collect(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(io_error(error)),
    };
    entries.sort();
    let Some(next) = entries.into_iter().next() else {
        let _ = std::fs::remove_dir(&dir);
        return Ok(None);
    };
    let message = std::fs::read_to_string(&next).map_err(io_error)?;
    std::fs::remove_file(&next).map_err(io_error)?;
    Ok(Some(message))
}

pub(super) fn clear_plan(git_dir: &Path) -> Result<(), GitError> {
    match std::fs::remove_dir_all(plan_dir(git_dir)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(io_error(error)),
    }
}

fn io_error(error: std::io::Error) -> GitError {
    GitError::OperationStepFailed(format!("Rebase plan I/O failed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use fjord_domain::CommitId;

    fn step(id: &str, action: RebaseTodoAction) -> RebaseTodoStep {
        RebaseTodoStep {
            commit: CommitId(id.into()),
            short_id: id[..7.min(id.len())].into(),
            subject: format!("subject {id}"),
            action,
        }
    }

    #[test]
    fn compile_todo_emits_break_only_for_reword_and_squash() {
        let steps = vec![
            step("aaa", RebaseTodoAction::Pick),
            step(
                "bbb",
                RebaseTodoAction::Reword {
                    message: "new message".into(),
                },
            ),
            step("ccc", RebaseTodoAction::Fixup),
            step(
                "ddd",
                RebaseTodoAction::Squash {
                    message: "combined message".into(),
                },
            ),
            step("eee", RebaseTodoAction::Drop),
        ];
        let (todo, plan) = compile_todo(&steps);
        assert_eq!(
            todo,
            "pick aaa subject aaa\n\
             pick bbb subject bbb\n\
             break\n\
             fixup ccc subject ccc\n\
             fixup ddd subject ddd\n\
             break\n\
             drop eee subject eee\n"
        );
        assert_eq!(
            plan,
            vec!["new message".to_string(), "combined message".to_string()]
        );
    }

    #[test]
    fn validate_steps_rejects_a_fixup_first() {
        let entries = vec![TodoCommitEntry {
            id: git2::Oid::from_str("0000000000000000000000000000000000000a").unwrap(),
            short_id: "0000000".into(),
            subject: "s".into(),
        }];
        let steps = vec![step(
            "0000000000000000000000000000000000000a",
            RebaseTodoAction::Fixup,
        )];
        let error = validate_steps(&steps, &entries).unwrap_err();
        assert!(matches!(error, GitError::RebaseTodoInvalid(_)));
    }

    #[test]
    fn validate_steps_rejects_an_unknown_commit() {
        let entries = vec![TodoCommitEntry {
            id: git2::Oid::from_str("0000000000000000000000000000000000000a").unwrap(),
            short_id: "0000000".into(),
            subject: "s".into(),
        }];
        let steps = vec![step(
            "0000000000000000000000000000000000000b",
            RebaseTodoAction::Pick,
        )];
        let error = validate_steps(&steps, &entries).unwrap_err();
        assert!(matches!(error, GitError::RebaseTodoInvalid(_)));
    }

    #[test]
    fn validate_steps_rejects_an_empty_reword_message() {
        let entries = vec![TodoCommitEntry {
            id: git2::Oid::from_str("0000000000000000000000000000000000000a").unwrap(),
            short_id: "0000000".into(),
            subject: "s".into(),
        }];
        let steps = vec![step(
            "0000000000000000000000000000000000000a",
            RebaseTodoAction::Reword {
                message: "  ".into(),
            },
        )];
        let error = validate_steps(&steps, &entries).unwrap_err();
        assert!(matches!(error, GitError::RebaseTodoInvalid(_)));
    }

    #[test]
    fn sequence_editor_command_quotes_a_windows_style_path_with_spaces() {
        let path = Path::new(r"C:\Users\A User\repo\.git\fjord-rebase-todo-source");
        let command = sequence_editor_command(path);
        assert_eq!(
            command,
            r"cp 'C:\Users\A User\repo\.git\fjord-rebase-todo-source'"
        );
    }

    #[test]
    fn plan_files_round_trip_in_order_including_multi_line_messages() {
        let dir = tempfile::tempdir().unwrap();
        write_plan(
            dir.path(),
            &[
                "first line\n\nsecond paragraph".to_string(),
                "second message".to_string(),
            ],
        )
        .unwrap();
        assert_eq!(
            pop_plan_entry(dir.path()).unwrap().as_deref(),
            Some("first line\n\nsecond paragraph")
        );
        assert_eq!(
            pop_plan_entry(dir.path()).unwrap().as_deref(),
            Some("second message")
        );
        assert_eq!(pop_plan_entry(dir.path()).unwrap(), None);
    }
}
