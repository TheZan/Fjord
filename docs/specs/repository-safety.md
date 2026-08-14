# Spec: repository operation state, destructive-action safety, and recovery

Referenced by: P8-00, P9-01–P9-10, SDD §9, §15.
Related: [`git-backend.md`](git-backend.md), [`ipc-commands.md`](ipc-commands.md),
[`working-tree-and-diff.md`](working-tree-and-diff.md),
[`workspace-workflows.md`](workspace-workflows.md).

## Problem

Fjord currently models exactly one abnormal repository condition: "the index has
conflicts" (`RepoStatus.has_conflict`, computed as
`index.has_conflicts()` in `crates/fjord-git/src/local/status.rs`). Everything
else about a repository's operational state is invisible. Three consequences:

1. **An in-progress operation is unrecognizable.** A repository mid-rebase,
   mid-cherry-pick, mid-revert, mid-merge, or mid-bisect looks to Fjord like a
   normal repository, possibly with conflicts. The user gets a red "conflict"
   banner and an "open merge tool" button, with no way to continue, skip, or abort
   the operation that caused it — so they leave for a terminal, and Fjord's state
   is then stale in a way it cannot detect. This applies equally to operations
   started outside Fjord, which is the common case today precisely because Fjord
   cannot start most of them.
2. **Destructive actions ask for confirmation without saying what is lost.**
   `ConfirmActionDialog` (`src/presentation/GitContextMenu.tsx`) shows a title, a
   description, and a target name for reset, branch deletion, and stash pop. It
   cannot say "this discards 14 modified files and 3 commits", because nothing
   computes that. A confirmation that carries no information trains users to click
   through it.
3. **There is no recovery path.** Git keeps a reflog that makes most accidents
   recoverable, and Fjord exposes none of it. A user who resets to the wrong commit
   has no in-app way back, even though the data is right there.

Additionally, `checkout_branch` today can fail with a libgit2 error when local
changes would be overwritten, leaving the user with an error string and no offered
resolution.

## Goals

- Detect and model every Git operation state a repository can be in, including
  states created outside Fjord.
- Offer Continue / Skip / Abort for in-progress operations, with backend contracts
  that are honest about which are legal in the current state.
- Preflight every destructive action with its concrete consequences, computed
  against the current repository, not described in general terms.
- Make checkout safe: detect an overwrite before it happens and offer real
  alternatives.
- Expose the reflog and build a Recovery Center that turns "I lost work" into a
  bounded, understandable set of restore options.
- Never present recovery as magic. If an option is reflog-based, say so, and say
  what it can and cannot recover.

## Non-goals

- A general undo stack over Git operations. Git has no such model; faking one
  would be a promise Fjord cannot keep. Recovery is explicitly reflog-shaped.
- A conflict-resolution editor (SDD §3). Conflict *state* is modeled here;
  conflict *content* remains the merge tool's job.
- Starting rebase or bisect. Detecting and finishing them is here; starting a
  rebase is [`workspace-workflows.md`](workspace-workflows.md) §2.
- Recovering data Git itself did not retain (unstaged changes discarded without a
  stash, garbage-collected unreachable objects). The UI must not imply otherwise.
- Automatic recovery. Every restore is user-initiated and confirmed.

## Current state

| Area | State |
|---|---|
| Operation state | ✅ P9-01–P9-04 implement the domain model, local detector, typed IPC/query and snapshot-schema-v2 inclusion, cancellable continue/skip/abort controls, and the persistent operation banner. Controls return the newly detected state and advance `working_tree`/`refs`/`history` generations after a launched step. |
| Conflict UI | ✅ The operation banner identifies the sequencer, rebase progress, external origin, bounded conflicted-file sample, legal controls, and merge-tool handoff. Conflicted files remain flagged in the working list (`WorkingFile.conflicted`); conflict content stays owned by the external merge tool. |
| Destructive preflight | ✅ One bounded domain/IPC/dialog contract computes generation-coherent facts for Phase 8 discard/force-with-lease and every P9-05 action. P9-06 renders every action/blocker/recovery label through the shared dialog, re-runs preflight at confirmation, and consumes the exact one-use binding before execution. |
| Reset | ✅ Soft/mixed/hard and Recovery Center restore have concrete facts and execute only through a fresh confirmation token. |
| Branch deletion | ✅ Local/remote deletion reports the exact ref, unmerged state, bounded commit sample, current-branch blocker, and conservative recoverability, then executes only the confirmed action. |
| Checkout | ⚠️ `checkout_branch`; remote branches materialize via a targeted fetch first (`remote_checkout_refspec` + `checkout_local`). No overwrite preflight, no stash-and-checkout. |
| Stash | ✅ `stash_push`, `stash_pop` (pops `stash@{0}` only), `get_stashes`, and exact stash-entry consumption facts. |
| Reflog | 🚧 Absent from the domain, ports, IPC, and UI. |
| Discard | ✅ File, hunk, and line discard. A backend-issued, short-lived, one-use token is bound to the repository, exact action and selection/digest, and complete `GenerationSet`; it is consumed under the repository write lock before `INDEX -> WORKTREE` reconstruction and contextual apply. |

The implemented Phase 8 partial-patch safety scope has passed independent final
verification: **SAFE TO PROCEED WITH DOCUMENTED LIMITATIONS**. Its supported
cross-process guarantee is limited to concurrent Fjord operations, standard Git
commands, and Git clients that respect Git's index/ref locking protocol.

## Proposed design

### 1. Repository operation state

New domain type, computed from on-disk Git state — never cached across a
generation bump:

```rust
pub enum RepoOperation {
    Normal,
    Merge          { head: String, incoming: Vec<String> },
    Rebase         { rebase_kind: RebaseKind, onto: String, current: u32, total: u32, head_name: Option<String> },
    CherryPick     { commit: String },
    Revert         { commit: String },
    Bisect         { good: u32, bad: u32 },
    Detached       { head: String },
    UnbornBranch,
}

pub enum RebaseKind { Apply, Merge, Interactive }

pub struct RepoOperationState {
    pub operation: RepoOperation,
    pub conflicted_paths: Vec<String>,
    pub available: Vec<OperationControl>,   // Continue | Skip | Abort
    pub detected_externally: bool,          // state not created by this Fjord session
}
```

Detection reads the Git directory directly (`MERGE_HEAD`, `rebase-merge/`,
`rebase-apply/`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `BISECT_LOG`, `HEAD`), which
is exactly why it works for operations started in a terminal or another client.
Rebase progress comes from `rebase-merge/msgnum` and `end` (or the `apply`
equivalents).

Current Git writes `rebase-merge/interactive` for the merge backend itself, so
that marker alone does not prove the user requested `--interactive`. Fjord calls
the persisted sequence interactive only when `git-rebase-todo` or `done`
contains a non-`pick` instruction; an all-`pick` sequence is reported as the
merge backend because the original command-line intent is no longer present on
disk. This preserves a useful, reproducible distinction across Git versions.

`available` is computed, not assumed: Continue is offered only when no unresolved
conflicts remain (Git itself refuses otherwise, and offering a button that always
fails is worse than not offering it); Skip only for rebase and cherry-pick
sequences; Abort whenever an operation is in progress.

Transport: a new `get_repo_operation_state` command, plus `operationState`
included in the repository snapshot ([`performance.md`](performance.md) §6) so the
banner paints with the first frame. The state invalidates on the `refs` and
`working_tree` generations.

`detected_externally` exists because the UI wording differs: a state Fjord did not
create needs an explanatory sentence, not just controls.

### 2. Continue / Skip / Abort (implemented by P9-03)

The local port methods and IPC commands are:

```rust
async fn continue_operation(&self, repo: &RepoPath) -> Result<RepoOperationState, GitError>;
async fn skip_operation(&self, repo: &RepoPath)     -> Result<RepoOperationState, GitError>;
async fn abort_operation(&self, repo: &RepoPath)    -> Result<RepoOperationState, GitError>;
```

Each dispatches on the detected state to the corresponding Git invocation
(`rebase --continue|--skip|--abort`, `merge --continue|--abort`,
`cherry-pick --continue|--skip|--abort`, `revert --continue|--skip|--abort`,
`bisect reset`), through the shared resolved executable, with `GIT_EDITOR` set to
a non-interactive no-op so a continue can never block on an editor. The context
variants run through the existing operation registry and cancellable process-tree
runner. Each returns
the *new* state, so the UI updates from the operation's own result rather than a
follow-up poll.

Failure modes are typed: `operation_not_in_progress`, `operation_has_conflicts`
(continue attempted with unresolved paths), `operation_step_failed` with sanitized
diagnostics.

The repository write lock covers detection, subprocess execution, generation
invalidation, and final redetection. Once Git has been launched, Fjord advances
the `working_tree`, `refs`, and `history` generations even when Git exits with a
failure or is cancelled, because a sequencer can already have advanced to a new
conflicted step. Cancellation never erases Git's markers; the next state read is
therefore authoritative.

UI: a persistent **operation banner** above the repository content shows the
operation, its progress where known (`rebase 3/7`), the conflicted files, and the
available controls. Per [`ui-shell.md`](ui-shell.md) §2, the banner is the one
place allowed to promote actions out of the overflow menu. While an operation is
in progress, actions that Git would refuse anyway (checkout, pull, stash pop) are
disabled with the reason shown. States detected outside Fjord use explicit
wording, conflict paths are bounded in the banner, and detached/unborn states are
visible without being treated as active sequencer operations. A successful
control writes its returned `RepoOperationState` into the query cache before
scope invalidation; cancellation/failure still refreshes affected scopes because
Git may already have advanced its sequencer.

### 3. Destructive preflight (foundation starts at P8-00)

One contract for every destructive action, so the user learns to read one dialog
shape:

```rust
pub struct DestructivePreflight {
    pub action: DestructiveAction,
    pub consequences: Vec<Consequence>,   // computed, specific
    pub recoverable: Recoverability,      // Reflog | Stash | NotRecoverable
    pub blockers: Vec<String>,            // conditions that make the action refuse
    pub generations: GenerationSet,       // coherent stamp required at confirmation
    pub force_with_lease: Option<ForceWithLeaseDetails>, // backend facts for display only
    pub confirmation_token: Option<String>, // opaque, short-lived, one-use
}

pub enum Consequence {
    ModifiedFilesDiscarded { count: u32, sample: Vec<String> },
    ModifiedLinesDiscarded { path: String, count: u32 },
    UntrackedFilesDeleted  { count: u32, sample: Vec<String> },
    StagedChangesDiscarded { count: u32 },
    CommitsUnreachable     { count: u32, sample: Vec<CommitSummary> },
    BranchDeleted          { name: String, unmerged_into: Option<String> },
    TagDeleted             { name: String, target_commit_id: Option<CommitId> },
    StashEntryConsumed     { index: u32, message: String },
    RemoteRefUpdated       { remote: String, ref_name: String, dropped_commits: u32 },
}
```

Covered actions: `reset --hard`, `reset --mixed` with staged content, discard
(file / hunk / lines, from [`working-tree-and-diff.md`](working-tree-and-diff.md)),
delete branch, delete remote branch, delete tag, stash pop with a dirty tree,
force-with-lease push, checkout that would overwrite, abort of an operation.

Command: `preflight_destructive_action(repo_id, action, patch_selection?)` →
`DestructivePreflight`.
The dialog renders consequences as concrete sentences with counts and up to five
example paths or commit subjects, and states recoverability honestly:

- *Reflog* — "the commits remain reachable through the reflog; you can restore
  them from the Recovery Center."
- *Stash* — "your changes will be saved to the stash."
- *Not recoverable* — "these changes are not stored anywhere and cannot be
  restored." Used for discarded uncommitted work and deleted untracked files.

The backend applies the label to the complete consequence set, not merely to
the moved ref. Reset and Recovery Center restore are `Reflog` only when they do
not also discard uncommitted/index state. Local/remote branch deletion, tag
deletion, stash pop, checkout discard, operation abort, and force-push are
`NotRecoverable`: a branch/tag/remote server is not required to preserve a
usable reflog, and a successfully popped stash is no longer durable recovery
storage even though its content was applied to the worktree.

A preflight is computed immediately before the dialog opens and is re-validated
against the repository generation at confirmation time; a generation change
between showing and confirming re-runs the preflight and shows the difference
rather than acting on stale facts.

For discard, the backend also validates the supplied `PatchSelection` against
the action and current diff, then issues a short-lived opaque confirmation token.
The token is bound server-side to the repository, exact action, exact file/hunk/
line selection, patch digest, and complete `GenerationSet`. `discard_patch`
validates and consumes that token under the repository write lock before doing
any Git work. Tokens expire after two minutes, are one-use even after a failed
binding attempt, and cannot be substituted across scopes or repositories.
Generation equality by itself is never confirmation.

For force-with-lease, the caller supplies only `ForceWithLease` intent. The
backend resolves the configured upstream remote, actual remote ref, locally
known remote-tracking OID, and immutable local source commit. It computes dropped
commits from that plan and binds the complete plan to the same short-lived,
one-use confirmation model. Execution consumes the token and re-resolves the
plan; it never accepts remote/ref/OID facts from IPC.

For Phase 9 action-only confirmations, the token is bound to the repository,
complete `DestructiveAction`, and `GenerationSet`. Local execution rechecks and
consumes the token while holding the repository write lock, then runs the exact
bound command before releasing that lock. Remote branch deletion consumes the
same binding before entering `GitRemoteBackend`; remote and branch names come
from the bound action, never from a second untrusted parameter. Substitution,
expiry, generation drift, and replay all fail as `preflight_stale`.

Discard execution additionally holds Git's resolved per-worktree `index.lock`
from repository reconstruction through the final contextual worktree apply.
This is the lock standard index/worktree Git mutations honor, so an external
`git add`, commit, reset, checkout, or switch cannot change the confirmed index
base between validation and discard. The complete original index is
fingerprinted and rechecked; lock contention or a change completed before that
check fails as `patch_stale`, and no index content is published by discard.

This guarantee covers concurrent Fjord operations, standard Git commands, and
Git clients that respect Git's index/ref locking protocol. Direct raw index
modification or replacement by a process that intentionally ignores
`index.lock` is unsupported concurrent modification: the fingerprint is not a
portable compare-and-swap and cannot promise detection after its final check.
Editors and worktree-only Git commands are a separate limitation because they do
not necessarily honor this lock; both residual intervals are documented in
[`working-tree-and-diff.md`](working-tree-and-diff.md) §1.

`blockers` covers cases where Fjord refuses outright — for example, deleting the
current branch. A blocker disables confirmation and states the reason.

Ownership is intentionally split without splitting the contract: `P8-00`
implements the model, IPC command, shared dialog, and confirmation-time generation
revalidation for Phase 8 discard and force-with-lease. `P9-05` extends the same
exhaustive action enum and backend fact/token path to reset, deletion, stash pop,
checkout, operation abort, and recovery; `P9-06` extends the dialog and exact
confirmation-bound execution wiring. Therefore no Phase 8 destructive action
waits for a future phase, while Phase 9 does not create a competing preflight
abstraction.

### 4. Safe checkout

`checkout_branch` gains a preflight step:

1. Compute whether the checkout would overwrite local modifications (the files the
   target differs in, intersected with the dirty set).
2. If empty → proceed unchanged.
3. If non-empty → return `checkout_would_overwrite` with the file list instead of
   attempting the checkout.

The UI then offers, and only what Git semantics actually permit:

| Option | Condition |
|---|---|
| Cancel | always |
| Stash changes and check out | always available when the tree is dirty; stashes with an auto-generated message naming the source and target branch, then checks out; on checkout failure the stash is *not* auto-popped, and the UI says where the work is |
| Bring changes along | offered only when Git would succeed — i.e. the overwrite set is empty for those specific files |
| Discard changes and check out | requires the §3 preflight, marked *not recoverable* |

Auto-popping the stash after a successful checkout is deliberately **not** done:
it can conflict, and resolving a conflict the user did not ask for is worse than
one explicit "your changes are in stash@{0}" message with a Pop button.

### 5. Reflog and Recovery Center

Domain:

```rust
pub struct ReflogEntry {
    pub index: u32,               // HEAD@{n}
    pub old_id: CommitId,
    pub new_id: CommitId,
    pub committer_name: String,
    pub timestamp: OffsetDateTime,
    pub operation: String,        // "commit", "reset", "rebase (finish)", ...
    pub message: String,
    pub commit: Option<CommitSummary>,  // resolved summary of new_id, when it still exists
}
```

Commands: `get_reflog(repo_id, ref_name?, limit, cursor?)` — paginated exactly like
`get_commit_log`, defaulting to `HEAD`'s reflog; and
`get_reflog_refs(repo_id)` for per-branch reflogs.

Recovery Center (a screen reachable from the repository overflow menu and from any
"not what you wanted?" affordance after a destructive action):

- Lists reflog entries newest-first with operation, time, subject, and short SHA.
- Selecting an entry shows the commit it points at and the diff against the
  current `HEAD`.
- Actions per entry: **Create branch here** (safe, always offered),
  **Restore `HEAD` to this state** (a `reset --hard` behind the §3 preflight),
  **Copy SHA**.
- A permanent explanatory line: recovery is based on Git's reflog; it can restore
  committed states and commits made unreachable by reset/rebase/amend, and it
  cannot restore uncommitted changes that were never committed or stashed, nor
  entries older than the repository's reflog expiry.

"Create branch here" is listed first, deliberately: it is the non-destructive way
out of every situation the Recovery Center exists for.

## Alternatives considered

**State detection: parse `.git` directly vs. `git status --porcelain=v2` vs.
libgit2's `RepositoryState`.** `git2::Repository::state()` returns exactly this
enum and is the cheapest option — but it does not give rebase progress
(`3/7`), the rebase kind, or the `onto` target, and Fjord needs those for a
useful banner. `--porcelain=v2` requires a subprocess on a hot path. Reading the
specific marker files, with `git2` state as a cross-check, is chosen: it is cheap,
it yields the progress fields, and it works identically for externally-created
states.

**Continue/Skip/Abort: shell out to Git vs. reimplement with `git2`.** libgit2's
rebase API exists but does not cover interactive rebase state written by the Git
CLI, which is the state most often found in the wild. Since the whole point is to
finish operations *Fjord did not start*, the implementation must speak the same
on-disk protocol Git does — so use Git itself.

**Preflight: computed consequences vs. severity-graded generic warnings.** Generic
warnings are cheap and scale to any action. They also produce the click-through
behavior described in the problem statement. Computed consequences cost one
diff/rev-list per dialog (bounded, on an explicit user action, off the hot path)
and are the entire value of the feature.

**Safe checkout: auto-stash (Git's `--autostash`) vs. explicit options.**
`--autostash` is convenient and hides two failure modes: a pop conflict after
checkout, and a stash the user does not know exists. Explicit options with a clear
"your work is in stash@{0}" message are chosen; the user can pop when ready.

**Recovery: reflog-backed Recovery Center vs. an operation-journal "Undo".** An
app-level journal could describe intent better, but it would be wrong precisely
when it matters — after a crash, after an external Git command, after any state
Fjord did not observe. Reflog is the ground truth Git itself uses to recover, and
naming it teaches the user something transferable.

## Performance considerations

- Operation-state detection is a handful of `stat`/small-file reads; it runs on
  repository activation and on `refs`/`working_tree` generation bumps, and it is
  part of the snapshot so it never adds a round trip to a repository switch.
- Preflight computations run on explicit user action only. Each is bounded: file
  lists cap at a sampled five with a total count; `CommitsUnreachable` uses a
  bounded `rev-list --count` plus a bounded sample, never a full walk of history.
- Reflog reads are paginated with the same cursor contract as `log`; the Recovery
  Center never materializes an entire reflog.
- The operation banner subscribes to the repository's existing state query; it
  introduces no polling.
- Continue/Skip/Abort are long-running mutations and run through the operation
  pipeline with progress and cancellation
  ([`operation-events.md`](operation-events.md)); cancelling a continue must leave
  the repository in a state the next detection can describe.

## Security / safety

- Every mutating command in this spec takes the repository write lock; none takes
  a shell string; all use the shared resolved Git executable.
- `GIT_EDITOR`/`GIT_SEQUENCE_EDITOR` are set to a non-interactive no-op for
  continue/skip so no Git subprocess can block waiting for an editor.
- Preflight results are re-validated against the repository generation before the
  action runs; a changed generation cancels and re-computes.
- No destructive action may run against an unvalidated snapshot
  ([`performance.md`](performance.md) §6).
- Recoverability labels are contractual: an action labeled *Reflog* must leave a
  reflog entry, and this is asserted in tests. Mislabeling recoverability is
  treated as a correctness bug, not a copy issue.
- Diagnostics from failed operations pass through the existing sanitizer before
  reaching logs or the UI.

## Testing strategy

| Level | Coverage |
|---|---|
| Unit (Rust) | State detection from synthesized `.git` layouts for every variant, including partially-written rebase directories; `available` control computation; preflight consequence assembly and sampling caps. |
| Integration (Rust) | Real fixtures for each state, created by the Git CLI (proving external detection): conflicted merge, `rebase --continue`/`--skip`/`--abort` round trips, cherry-pick and revert sequences, bisect start/reset, detached HEAD, unborn branch. Checkout-would-overwrite detection and stash-and-checkout. Reflog paging and entries after reset/amend/rebase. Assertion that every *Reflog*-labeled action leaves a reflog entry. |
| Frontend/component | Operation banner per state, including `detected_externally` wording; disabled actions with reasons; preflight dialog renders counts, samples, and the correct recoverability label; blockers disable confirmation. |
| E2E | Start a rebase in a terminal, open Fjord, resolve and continue entirely in the UI. Reset to a wrong commit, recover via the Recovery Center, verify the working state matches the pre-reset state. |
| OS-specific / manual | Non-interactive editor behavior on Windows (`GIT_EDITOR` quoting), and a repository whose `.git` is a file (worktree/submodule) on all three OSes. |
| Benchmark | Preflight latency on the `wt-huge` fixture; state detection cost at `ws-100` activation. |

## Acceptance criteria

1. A repository left mid-rebase by the Git CLI is reported by Fjord as
   `Rebase { .. }` with a correct step count within one refresh, with
   `detected_externally = true`, without restarting Fjord.
2. Each of merge, rebase (apply, merge, interactive), cherry-pick, revert, bisect,
   detached HEAD, and unborn branch is detected as its own state, verified by an
   integration test per state.
3. Continue is offered only when no conflicted paths remain; attempting it with
   conflicts present fails with `operation_has_conflicts` and changes nothing.
4. Abort from each in-progress state returns the repository to the pre-operation
   `HEAD` and reports `Normal`.
5. Every destructive action listed in §3 shows a preflight naming concrete counts
   and up to five examples before anything is executed.
6. The preflight for `reset --hard` on a dirty tree lists both the modified files
   that will be discarded and the commits that will become unreachable, and labels
   the commits *Reflog*-recoverable and the working-tree changes *not
   recoverable*.
7. Confirming an action whose repository generation changed since the preflight
   re-runs the preflight instead of executing.
8. A checkout that would overwrite local modifications never executes; the user is
   offered cancel and stash-and-checkout, with discard available only through a
   preflight.
9. After stash-and-checkout, the stash entry exists, is named after the source and
   target branches, and the UI states where the work is; nothing is auto-popped.
10. `get_reflog` returns paginated entries for `HEAD` with operation labels, and
    an entry created by a `reset --hard` performed inside Fjord appears in it.
11. "Create branch here" from a Recovery Center entry creates a branch at that
    commit and performs no other change.
12. "Restore HEAD to this state" is only reachable through a preflight, and after
    it runs, the previous `HEAD` is itself present in the reflog.
13. The Recovery Center states, on screen, that recovery is reflog-based and lists
    what it cannot recover.
