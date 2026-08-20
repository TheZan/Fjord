# Spec: branch merge into the current branch

Referenced by: P10-MERGE-01, P10-MERGE-02, P10-MERGE-03, SDD §5.2, §15.
Related: [`repository-safety.md`](repository-safety.md),
[`workspace-workflows.md`](workspace-workflows.md),
[`working-tree-and-diff.md`](working-tree-and-diff.md),
[`git-backend.md`](git-backend.md), [`ipc-commands.md`](ipc-commands.md),
[`operation-events.md`](operation-events.md), [`ui-shell.md`](ui-shell.md).

This spec is the single normative owner of *starting* a merge. Conflict state,
Continue/Abort, and the operation banner are owned by
[`repository-safety.md`](repository-safety.md) and are referenced here, never
redefined. Rebase remains owned by
[`workspace-workflows.md`](workspace-workflows.md) §2; the two share the
integration preflight rules defined in §4 below, which that spec cross-references
rather than restates.

## Problem

Phase 9 made Fjord able to *finish* a merge: `RepoOperationState::Merge` is
detected (including for merges started outside Fjord), conflicted paths are
listed, the external merge tool is reachable, and Continue/Abort run through the
shared operation controls. Phase 8 and 9.5 made ordinary daily work — partial
staging, amend, publish, safe checkout, recovery — possible without a terminal.

Fjord still cannot **start** a merge.

`git merge <branch>` is the single most common branch-integration command a
developer runs, and today the only way to reach it from Fjord is a terminal.
Once the user is in that terminal they will also resolve the conflict there,
push there, and stop looking at Fjord. This is a larger daily-driver gap than
interactive rebase, which Fjord already schedules as a Phase 10 task: interactive
rebase is a specialist tool used occasionally; merging a feature branch into the
branch you are on is a routine several times a week.

The only merge Fjord performs today is the local integration phase of `pull`
(`integrate_upstream`, `crates/fjord-git/src/local/mutations.rs`). It is not
reachable as a product action, it can only ever target the configured upstream,
and it has no preflight, no mode selection, and no UI entry point.

## Goals

- Merge any suitable branch that is visible in Fjord into the **currently
  checked-out local branch**, without a terminal.
- Direction is unambiguous in every label: the user always reads the source and
  the destination, never a bare "Merge branch".
- One application action shared by every entry point (branch tree, commit-graph
  branch label, command palette). No entry point owns Git logic.
- Ordinary Git outcomes — already up to date, fast-forward, merge commit,
  conflict — are typed results, not error strings.
- A conflicted merge hands straight to the existing Phase 9 operation
  banner/state machinery and can be aborted through the existing safe abort path.
- The backend resolves and validates the source ref itself; the frontend never
  submits command text.
- Fjord never checks out another branch to perform a merge, and never
  autostashes.

## Non-goals

- **Merging into anything other than the checked-out branch.** Merging `A` into
  `B` while `C` is checked out requires a checkout or a worktree write and is a
  different, more dangerous product. Out of scope permanently for this spec.
- **Strategy and driver surface.** `--strategy`, `-X ours/theirs`, custom merge
  drivers, and `--no-ff` are not exposed. Fjord does not expose raw Git flags as
  its product model.
- **Octopus / multi-head merges.** One source ref per action.
- **Squash merge.** Deferred to P10-MERGE-03 (§9); it produces a non-merge commit
  and needs its own commit-message flow.
- **A custom merge-commit message editor.** v1 uses Git's own default message via
  `--no-edit`. A message editor is a possible follow-up, not a v1 requirement.
- **A built-in three-way conflict editor.** SDD §3 stands: conflict *content*
  belongs to the user's configured merge tool.
- **Forge merges.** GitHub/GitLab pull-request or merge-request merging is
  explicitly out of scope (SDD §15).
- **Arbitrary refs as sources.** Tags and raw commit ids are not offered as merge
  sources in v1; see §2.

## Current state

| Area | State |
|---|---|
| Merge state detection | ✅ `RepoOperationState::Merge { head, incoming }` with conflicted paths, computed controls, and `detected_externally` (`P9-01`, `P9-02`). |
| Conflict UI | ✅ Operation banner with bounded conflicted paths, merge-tool handoff, Continue/Abort (`P9-03`, `P9-04`). |
| Abort | ✅ `DestructiveAction::AbortOperation` through the shared preflight and token-bound executor (`P9-05`, `P9-06`). |
| Merge initiation | 🚧 Absent. No domain type, no port method, no IPC command, no UI entry point. |
| Local merge machinery | ⚠️ `integrate_upstream` performs a `git2` up-to-date / fast-forward / normal-merge analysis for `pull` only. Not a product action; not reused by this spec (§7). |
| Branch context menu | ⚠️ Checkout, create branch here, rename, set/unset upstream, publish, delete, copy (`RepoTree.tsx`, `GitContextMenu.tsx`). No merge entry. |
| Commit-graph branch labels | ⚠️ `RefBadge` / `RefBadgeGroup` / `RefBadgeFlyout` in `CommitGraph.tsx` render refs and support click-to-checkout. They have **no context menu at all**; only the commit row has one, and it is keyed by commit, not by ref. |
| Command palette | ✅ `Ctrl/Cmd+K` actions registry ([`ui-shell.md`](ui-shell.md) §6). No merge action. |

## Proposed design

### 1. Product contract

```text
Current branch: develop
Right-click:    feature/payments

Merge feature/payments into develop…
```

Rules that make the direction unambiguous and are contractual:

1. The label always names **both** refs, interpolated:
   `t('context.mergeInto', { source, target })` → `Merge {{source}} into {{target}}`.
   A label reading only "Merge", "Merge branch", or "Merge into current" is a
   spec violation, not a copy preference.
2. **Source** is the exact ref the user clicked. **Destination** is always the
   currently checked-out local branch, read from backend state — never chosen in
   the dialog and never inferred from the clicked commit.
3. The trailing ellipsis is required: the action always opens the confirmation
   dialog (§5) before any Git mutation.
4. The action is **not offered for the current branch itself**. It is rendered
   disabled with the localized reason
   `merge.blocked.sourceIsCurrentBranch` rather than hidden, so the menu's shape
   stays stable between rows ([`ui-shell.md`](ui-shell.md) §2's rule for
   unavailable actions).
5. Fjord never checks out, creates, or moves any ref other than the destination
   branch as part of a merge.

### 2. Merge sources

A merge source is identified by a canonical ref name resolved backend-side, not
by a display label and not by a commit id:

```rust
pub enum MergeSourceKind {
    LocalBranch,      // refs/heads/<name>
    RemoteTracking,   // refs/remotes/<remote>/<name>
}

pub struct MergeSource {
    /// Canonical, fully-qualified: "refs/heads/feature/payments".
    pub ref_name: String,
    pub kind: MergeSourceKind,
}
```

| Source | v1 (P10-MERGE-01) | Notes |
|---|---|---|
| Another local branch | ✅ supported | The whole of P10-MERGE-01. |
| The current branch | ✅ refused | Disabled entry with a reason; the backend also refuses with `merge_source_is_current_branch`. |
| A remote-tracking ref (`origin/feature/payments`) | 🚧 **deliberately deferred to P10-MERGE-02** | See below. |
| A tag | ❌ not offered | Valid Git, but a tag is a release marker in Fjord's model; merging one is not a workflow the branch tree or graph label surfaces. |
| A raw commit id | ❌ not offered | No entry point; `merge <sha>` is a terminal operation, and Fjord would have nothing honest to put in the label's `{{source}}` slot. |

**Remote-tracking refs are explicitly deferred, not unspecified.** P10-MERGE-01
renders the merge entry for a remote-tracking branch row **disabled** with the
localized reason `merge.blocked.remoteSourceNotSupported`, and the backend
refuses `MergeSourceKind::RemoteTracking` with `merge_source_unsupported`. It is
never silently missing.

P10-MERGE-02 then adds remote-tracking sources under these rules, which are
already fixed here so the follow-up task has no product semantics left to invent:

- The merge operates on **the locally known remote-tracking ref**, exactly as it
  exists in `refs/remotes/` at the moment the backend resolves it. It is the same
  object `git merge origin/feature/payments` would use.
- **No implicit network access.** Merging a remote-tracking ref performs no
  fetch by default. Fjord does not silently make the ref fresher than the user's
  last fetch, because a merge whose input changed between the preview and the
  action is exactly the failure the preflight exists to prevent.
- Freshness is **named, not measured**. The dialog identifies exactly which
  object will be merged and says plainly what that object is:

  ```text
  origin/feature/payments
  Known commit: a18c34f

  This is the remote-tracking branch as Fjord last saw it.

  [ ] Fetch origin before merging
  ```

  The short id is the whole freshness signal, and it is authoritative because it
  is read from `refs/remotes/` at preflight time. **Fjord must not claim to know
  when the ref was last refreshed.** A user can fetch from a terminal, another
  GUI, or an IDE at any time, so any Fjord-owned "last fetched N minutes ago"
  would be wrong exactly when it mattered — and no task in this spec may
  introduce a persisted fetch timestamp to make such a claim possible. If a
  future feature needs fetch recency, it must derive it from a repository-owned
  source and justify that source on its own terms.
- The explicit **Fetch {{remote}} before merging** checkbox is the only way a merge
  touches the network. When selected, the merge runs the existing cancellable
  `fetch_repo` operation for that one remote through the existing
  `GitRemoteBackend`, authentication, progress, and cancellation infrastructure,
  then **re-resolves the source ref and re-runs the preflight** before merging;
  the dialog shows the re-resolved short id, so a ref that moved is visible
  before the merge. A cancelled or failed fetch cancels the merge and leaves the
  repository untouched. A targeted fetch is never implied by the merge action
  alone.
- **A local branch is never created.** Choosing Merge on `origin/feature/payments`
  merges that remote-tracking ref and leaves `refs/heads/` untouched. Creating a
  local tracking branch remains the separate, existing Checkout action.
- Every other rule in this spec (direction, dirty policy, modes, conflict
  handoff, locking, generations) applies unchanged.

### 3. Merge modes

Two modes only, expressed as product outcomes rather than Git flags:

```rust
pub enum MergeMode {
    /// Git's ordinary behavior: fast-forward when possible, otherwise a merge commit.
    Default,
    /// Refuse rather than create a merge commit.
    FastForwardOnly,
}
```

| UI label | Mode | Git invocation |
|---|---|---|
| **Default merge** | `Default` | `merge --no-edit <ref>` |
| **Fast-forward only** | `FastForwardOnly` | `merge --ff-only --no-edit <ref>` |

`Default` is preselected. `FastForwardOnly` exists because "integrate this
without inventing a merge commit" is a real, common intent and is otherwise
unreachable; when it cannot be satisfied the merge fails cleanly with
`merge_not_fast_forward` and changes nothing.

No other mode is offered in v1. `--no-ff`, `--squash`, `--strategy`, `-X`,
`--allow-unrelated-histories`, and octopus merges are outside the initial scope
(§Non-goals; squash is P10-MERGE-03).

### 4. Integration preflight (shared with rebase)

`get_merge_preflight` is a read-only command that runs under the repository read
lock and returns bounded, concrete facts:

```rust
pub enum MergePrediction {
    AlreadyUpToDate,
    FastForward { commits: u32 },
    MergeCommit { ahead: u32, behind: u32 },
}

pub struct MergeDirtyState {
    pub staged: u32,
    pub modified: u32,
    pub untracked: u32,
    /// Files the merge would change that currently carry local work.
    /// Bounded at 100 entries, like `checkout_would_overwrite`.
    pub would_overwrite: Vec<String>,
}

pub struct MergePreflight {
    pub source: MergeSource,
    pub source_label: String,        // "feature/payments" — display only
    pub source_commit: CommitId,
    pub target_branch: String,       // "develop"
    pub target_commit: CommitId,
    pub prediction: MergePrediction,
    pub dirty: MergeDirtyState,
    pub blockers: Vec<String>,       // stable codes, empty when the merge may start
    pub generations: GenerationSet,
}
```

**Blockers** (stable codes; each disables the confirm button and states its
reason):

| Code | Condition |
|---|---|
| `merge_source_is_current_branch` | The clicked ref is the checked-out branch. |
| `merge_source_not_found` | The ref no longer exists (stale menu, deleted branch). |
| `merge_source_unsupported` | Source kind is not supported by the current task scope (remote-tracking before P10-MERGE-02; tags; raw ids). |
| `operation_already_in_progress` | A merge, rebase, cherry-pick, revert, or bisect is already in progress (`RepoOperationState != Normal` for the sequencer states). |
| `merge_detached_head` | `HEAD` is detached — there is no destination branch to name. |
| `merge_unborn_head` | The branch has no commits yet. |
| `merge_index_has_staged_changes` | The index differs from `HEAD` (see below). |
| `merge_would_overwrite` | `dirty.would_overwrite` is non-empty. |

**Dirty working tree policy.** Fjord never autostashes and never silently
proceeds. The two blockers above are Fjord's own conservative rule and are
deliberately at least as strict as Git:

- A merge commit is written from the index. Starting a merge with staged content
  that is not in `HEAD` would either fold that content into a merge commit the
  user did not review, or leave Git refusing halfway. Fjord refuses first.
- Local modifications to files the merge would change are computed with the same
  bounded target-tree-delta ∩ dirty-set intersection `checkout_would_overwrite`
  already uses ([`repository-safety.md`](repository-safety.md) §4), reusing that
  implementation rather than adding a second one.
- Local modifications to files the merge does **not** touch, with a clean index,
  are **not** a blocker. Refusing every dirty repository would make the feature
  unusable for the developer it is written for.

When either blocker is present the dialog offers exactly two choices:

```text
Merge feature/payments into develop

You have local changes.

  [ Cancel ]     [ Stash changes and merge ]
```

**Stash and merge** reuses the shipped P9-07 stash infrastructure without
introducing new behavior:

- one explicit, Fjord-named stash including tracked and untracked work, with the
  message `Fjord merge: feature/payments -> develop`;
- it is **never** auto-popped, before or after the merge, on success or failure;
- the result states where the work went: `Your work is in stash@{0}.`;
- if the stash succeeds and the merge then fails to start or conflicts, the
  stash is retained and the message still names it.

If P10-MERGE-01's implementation cannot reuse that path unchanged, the correct
v1 behavior is to ship **Cancel only** and file stash-and-merge as a follow-up —
never to add a second, hidden stash mechanism.

Rebase (P10-05, [`workspace-workflows.md`](workspace-workflows.md) §2) reuses
this section's blocker set and dirty policy; it adds its own published-commit
consequence on top and does not restate these rules.

### 5. Merge dialog

The dialog is a shell overlay following the existing contract (first-action
focus, trapped Tab order, Escape dismissal, invoker focus restoration).

```text
┌──────────────────────────────────────────────────────────┐
│ Merge feature/payments into develop                      │
│                                                          │
│ feature/payments is 7 commits ahead of develop.          │
│ This will create a merge commit.                         │
│                                                          │
│ Mode  (•) Default merge   ( ) Fast-forward only          │
│                                                          │
│                          [ Cancel ]  [ Merge ]           │
└──────────────────────────────────────────────────────────┘
```

- The title names both refs. It is the same interpolated string as the menu item
  minus the ellipsis.
- The body renders `prediction` as a concrete sentence — already up to date, a
  fast-forward of *n* commits, or a merge commit with the ahead/behind counts.
  It is not a generic warning.
- `AlreadyUpToDate` replaces the confirm button with a dismiss button; nothing is
  executed.
- Blockers render as the §4 choice set instead of the Merge button.
- The dialog re-runs `get_merge_preflight` when the repository generations change
  while it is open, and shows the difference rather than acting on stale facts —
  the same rule the destructive preflight already follows
  ([`repository-safety.md`](repository-safety.md) §3). Merge is not a
  `DestructiveAction` and therefore carries **no** confirmation token: it creates
  refs and commits rather than destroying them, and the token model exists for
  irreversible loss. The stash-and-merge variant is likewise additive.

### 6. Backend contract

Port addition on `GitBackend` (local, no network in v1):

```rust
async fn merge_preflight(
    &self,
    repo: &RepoPath,
    source: &MergeSource,
) -> Result<MergePreflight, GitError>;

async fn merge_branch(
    &self,
    repo: &RepoPath,
    source: &MergeSource,
    mode: MergeMode,
    dirty_policy: MergeDirtyPolicy,   // Refuse | StashFirst
) -> Result<MergeResult, GitError>;
```

```rust
pub enum MergeOutcome {
    AlreadyUpToDate,
    FastForwarded { head: CommitId },
    Merged { commit: CommitId },
    Conflicted { state: RepoOperationState },
}

pub struct MergeResult {
    pub outcome: MergeOutcome,
    pub source: MergeSource,
    pub source_label: String,
    pub target_branch: String,
    /// Set only when `dirty_policy = StashFirst` actually saved work.
    pub stash_ref: Option<String>,
    pub generations: GenerationSet,
}
```

IPC ([`ipc-commands.md`](ipc-commands.md)):

| Command | Input | Output |
|---|---|---|
| `get_merge_preflight` | `{ repo_id, source }` | `GenerationEnvelope<MergePreflight>` |
| `merge_branch` | `{ repo_id, source, mode, dirty_policy, operation_id? }` | `MergeResult` |

Contract rules:

- **The frontend submits a typed `MergeSource`, never command text, flags, or a
  shell string.** The backend re-resolves `ref_name` against the repository,
  re-classifies its kind, re-reads `HEAD`, and re-evaluates every §4 blocker
  under the write lock. A preflight result is a display artifact; it is never
  authority for execution.
- **Conflict is a result, not an error.** `Conflicted { state }` carries the
  freshly detected `RepoOperationState` so the caller updates the operation
  banner from the merge's own return value, exactly as `continue_operation`
  already does — no follow-up poll.
- Genuine failures use stable codes: `merge_source_not_found`,
  `merge_source_is_current_branch`, `merge_source_unsupported`,
  `merge_not_fast_forward`, `merge_would_overwrite` (bounded paths in
  `diagnostics`), `merge_index_has_staged_changes`, `merge_detached_head`,
  `merge_unborn_head`, `operation_already_in_progress`, `merge_failed`
  (sanitized diagnostics), plus `operation_cancelled`. No normal Git outcome is
  encoded as a free-form error string.

**Engine and locking.** Merge runs through **system Git** with the shared
resolved executable and the cancellable process-tree runner, arguments passed
individually, `GIT_EDITOR`/`GIT_SEQUENCE_EDITOR` set to the existing
non-interactive no-op. Rationale in §7.

- The repository write lock covers: blocker re-evaluation, the optional stash,
  ref resolution, the subprocess, generation invalidation, and the final
  operation-state redetection.
- Once Git has been launched, `working_tree`, `refs`, and `history` generations
  advance **even on failure or cancellation** — the same rule `P9-03` already
  applies, because a partially-completed merge has changed the repository. A
  `StashFirst` merge also advances `stash`. Blockers rejected *before* Git is
  launched advance nothing.
- Cancellation terminates the Git process tree. A cancelled merge may leave a
  detectable in-progress merge state; the banner then offers Abort. Cancellation
  is never silently equivalent to abort.
- Concurrency: `merge_branch` takes the same per-repository write lock every
  other mutation takes, so it serializes with staging, discard, checkout, and
  the operation controls. It does not take Git's `index.lock` directly — the
  `git merge` subprocess acquires and releases Git's own locks, which is
  precisely the cross-process boundary Fjord relies on elsewhere
  ([`git-backend.md`](git-backend.md)).

**Operation pipeline.** `merge_branch` is registered as a cancellable operation
with kind `merge` ([`operation-events.md`](operation-events.md)); it emits
message-only progress (`total = 0`) because `git merge` reports no countable
units, and a terminal `succeeded` / `failed` / `cancelled` event. A conflicted
merge is a **`succeeded`** operation event carrying the `Conflicted` result —
Git did what it was asked; the repository is now in a state the banner owns.

**Query invalidation.** On any outcome that launched Git, the caller invalidates
through the existing `invalidateRepoData` generation paths: status, working
changes, refs/branches, history, and the shared `operation` scope
(`refs` + `workingTree`). `AlreadyUpToDate` invalidates nothing.

### 7. Alternatives considered

**System Git vs. reusing the `git2` merge in `integrate_upstream`.** The `git2`
path already exists and would avoid a subprocess. It is not chosen, for the same
reason `workspace-workflows.md` §2 chose system Git for rebase: Phase 9's
Continue/Abort deliberately speak Git's on-disk protocol so externally-created
states work. Starting a merge with a different mechanism than the one that
finishes it creates states only half the system fully understands, and it would
also bypass the user's `merge.*` configuration, hooks, and commit signing.
`integrate_upstream` is deliberately **left unchanged** — `pull`'s integration
semantics are shipped and independently verified, and changing them is not in
this spec's scope. Unifying the two paths later is a possible cleanup, recorded
here so the divergence is intentional rather than accidental.

**Merge into an arbitrary branch vs. only the checked-out branch.** Merging into
a branch that is not checked out requires either a temporary checkout (which
would silently move the user's working tree — the thing this spec forbids) or a
worktree/index write outside Git's normal path. Only the checked-out destination
is offered; a user who wants another destination checks it out first, which is
one visible action rather than one hidden one.

**A merge dialog that also selects the destination vs. a fixed destination.** A
destination picker looks more capable and is the exact affordance that makes
users merge into the wrong branch. The destination is state, not input.

**Confirmation token vs. plain confirm.** Every destructive action in Fjord is
bound to a one-use backend token. Merge is additive: it creates a commit or moves
a branch forward, and it is abortable and reflog-visible. Adding a token would
imply a loss guarantee that does not apply and would dilute the meaning of the
token model. Generation revalidation — which is what actually prevents acting on
stale facts — is kept.

**Blocking every dirty repository vs. the computed overwrite set.** Blocking
everything is simpler and would be refused by the target user, who always has
work in progress. The bounded intersection already exists for checkout and is
reused.

### 8. Entry points

All three dispatch **one** application action. The action lives in the repository
container alongside the existing branch-context handlers; no menu component
contains merge logic.

```text
RepoTree branch context ─┐
CommitGraph ref context ─┼─► onMergeBranch(source: MergeSource) ─► useMergeBranch()
Command palette ─────────┘                                            └─ merge dialog ─ merge_branch
```

**1. Left branch tree (`RepoTree.tsx`).** `branchMenuItems` gains one entry,
placed directly under Checkout and above the upstream group:

```text
Checkout
──────────────────────────
Merge feature/payments into develop…
Rebase develop onto feature/payments…      ← P10-05 fills this slot
──────────────────────────
Create branch here
Rename branch
Set upstream…
Unset upstream
Push & Set Upstream
Delete branch
──────────────────────────
Copy branch name
```

`BranchContextAction` gains `"merge"`. The existing
`onBranchContextAction(action, branch, upstreamChoices)` callback already carries
the exact `BranchInfo`, which is the exact clicked row — the handler builds the
`MergeSource` from `branch.name` and `branch.isRemote`, never from a commit.

The rebase line is shown here for placement only; it is delivered by P10-05 and
is disabled until then.

**2. Commit-graph branch label (`CommitGraph.tsx`).** Branch labels currently
have no context menu. This task adds one to `RefBadge`, reachable from both the
inline badge and the `RefBadgeFlyout` list, offering Checkout, the same merge
entry, and Copy branch name.

The critical correctness rule: **a commit can carry many refs**, and the menu
must act on the exact ref the user opened it on. `CommitRef` therefore carries
the canonical fully-qualified ref name (`refs/heads/…` / `refs/remotes/…`)
alongside its display label, and the menu payload is that ref — never the
commit's SHA and never "the first branch on this commit". Tag refs render the
merge entry disabled with `merge.blocked.sourceKindUnsupported`.

Both entry points call the same `onMergeBranch`. Two independently implemented
merge flows are a spec violation.

**3. Command palette (`Ctrl/Cmd+K` → "Merge branch…").** Included, because Fjord
is keyboard-first ([`ui-shell.md`](ui-shell.md) §6) and merge is exactly the kind
of frequent action the actions palette exists for. It is registered in the
repository scope, lists the local branches of the active repository excluding the
current one, and resolves to the same `onMergeBranch` with the same
`MergeSource`. It adds no branch-selection logic of its own beyond ranking.

### 9. Follow-up tasks

- **P10-MERGE-02 — remote-tracking sources.** Semantics fixed in §2; the task
  implements them and removes the `merge_source_unsupported` refusal for
  `RemoteTracking`.
- **P10-MERGE-03 — squash merge.** `merge --squash` leaves staged content and no
  merge commit, so its product model is "stage the result of a merge, then
  commit" and it needs its own message flow and its own conflict semantics. It is
  deliberately not folded into v1.

## i18n

All strings are added to `en` and mirrored across the five shipped locales
(`en`, `ru`, `de`, `es`, `fr`); `npm run check-i18n` is the parity gate. Ref
names are interpolation variables only — never inside a translated string
([`i18n.md`](i18n.md)).

| Key (namespace `workspace`) | English |
|---|---|
| `context.mergeInto` | `Merge {{source}} into {{target}}…` |
| `merge.title` | `Merge {{source}} into {{target}}` |
| `merge.mode.label` | `Mode` |
| `merge.mode.default` | `Default merge` |
| `merge.mode.fastForwardOnly` | `Fast-forward only` |
| `merge.confirm` | `Merge` |
| `merge.cancel` | `Cancel` |
| `merge.prediction.alreadyUpToDate` | `{{target}} already contains {{source}}. Nothing to merge.` |
| `merge.prediction.fastForward_one` | `{{source}} is {{count}} commit ahead of {{target}}. This will fast-forward.` |
| `merge.prediction.fastForward_other` | `{{source}} is {{count}} commits ahead of {{target}}. This will fast-forward.` |
| `merge.prediction.mergeCommit` | `{{source}} is {{ahead}} commits ahead and {{behind}} behind {{target}}. This will create a merge commit.` |
| `merge.dirty.title` | `You have local changes.` |
| `merge.dirty.stashAndMerge` | `Stash changes and merge` |
| `merge.dirty.stashRetained` | `Your work is in {{stash}}.` |
| `merge.remote.knownCommit` | `Known commit: {{sha}}` |
| `merge.remote.explanation` | `This is the remote-tracking branch as Fjord last saw it.` |
| `merge.remote.fetchFirst` | `Fetch {{remote}} before merging` |
| `merge.outcome.alreadyUpToDate` | `{{target}} was already up to date.` |
| `merge.outcome.fastForwarded` | `{{target}} was fast-forwarded to {{source}}.` |
| `merge.outcome.merged` | `Merged {{source}} into {{target}}.` |
| `merge.outcome.conflicted` | `{{source}} conflicts with {{target}}. Resolve the conflicts, then continue or abort the merge.` |
| `merge.blocked.sourceIsCurrentBranch` | `{{target}} is already the current branch.` |
| `merge.blocked.sourceNotFound` | `{{source}} no longer exists.` |
| `merge.blocked.remoteSourceNotSupported` | `Merging a remote branch is not available yet. Check it out, or fetch and merge the local branch.` |
| `merge.blocked.sourceKindUnsupported` | `Only branches can be merged.` |
| `merge.blocked.operationInProgress` | `Another Git operation is already in progress.` |
| `merge.blocked.detachedHead` | `HEAD is detached. Check out a branch before merging.` |
| `merge.blocked.unbornHead` | `{{target}} has no commits yet.` |
| `merge.blocked.stagedChanges_one` | `{{count}} staged change must be committed or stashed before merging.` |
| `merge.blocked.stagedChanges_other` | `{{count}} staged changes must be committed or stashed before merging.` |
| `merge.blocked.wouldOverwrite_one` | `{{count}} file with local changes would be overwritten by this merge.` |
| `merge.blocked.wouldOverwrite_other` | `{{count}} files with local changes would be overwritten by this merge.` |
| `merge.error.notFastForward` | `{{source}} cannot be fast-forwarded into {{target}}. Use a default merge, or rebase first.` |
| `merge.error.failed` | `The merge could not be completed. The repository was not changed beyond what Git reported.` |
| `commandPalette.mergeBranch` | `Merge branch…` |

`merge.remote.*` ship with `P10-MERGE-02`; every other key ships with
`P10-MERGE-01`. Note that no key states a fetch time — `merge.remote.knownCommit`
names the object Fjord will merge, which is a fact it can prove, unlike a
recency claim (§2).

Russian renders `merge` as «слияние» per `src/locales/en/glossary.md`; branch
names stay verbatim through interpolation.

## Performance considerations

- `get_merge_preflight` is an explicit-user-action read: one merge-base plus two
  bounded `rev-list --count` walks and the already-implemented bounded overwrite
  intersection. It never walks full history and never materializes a diff.
- The preflight runs under the read lock and reuses the `RepositoryRuntime`
  caches when the relevant generations are unchanged, so opening the dialog on a
  warm repository adds no Git work beyond the counts.
- `merge_branch` is a long-running mutation on the operation pipeline; it never
  blocks the UI thread and never runs on the render path.
- The graph ref context menu must not add a per-row subscription: it reads the
  already-loaded branch/ref data, and its state lives in the graph container, not
  in a virtualized row (§8, and the same recycled-row rule
  [`working-tree-and-diff.md`](working-tree-and-diff.md) §6 states for file rows).
- Invalidation is generation-scoped; a merge does not force a full repository
  refetch beyond the domains it actually advanced.

## Security / safety

- The merge takes the repository write lock, uses the shared resolved Git
  executable, and passes every argument individually. No shell string is
  constructed anywhere in the path.
- The source ref crosses IPC as a ref name and is validated backend-side against
  the repository's actual refs. A ref that does not resolve is
  `merge_source_not_found`; nothing is executed on a caller-supplied assumption.
- Fjord never checks out a different ref, creates a local branch, or moves any
  ref other than the destination branch.
- No autostash, ever. The only stash Fjord creates is the explicit, named,
  never-auto-popped stash of §4, and its location is always reported.
- A conflicted merge leaves the repository in Git's normal merge state. Recovery
  is the existing Phase 9 Abort through the shared destructive preflight —
  this spec adds no second abort path.
- Failed-merge diagnostics pass through the existing sanitizer before reaching
  logs or the UI; log lines carry ref names and counts, never file contents.
- v1 performs no network access. P10-MERGE-02's optional targeted fetch reuses
  the existing `GitRemoteBackend`, askpass, and cancellation infrastructure and
  introduces no new transport path; it is reachable only through the explicit
  checkbox, never as a side effect of opening the dialog or confirming a merge.
- Fjord states only facts it can prove about a remote-tracking source: the
  commit id read from `refs/remotes/` at preflight time. It makes no claim about
  when that ref was last refreshed, because fetches performed outside Fjord are
  invisible to it, and no persisted fetch timestamp is introduced to manufacture
  one (§2).

## Testing strategy

| Level | Coverage |
|---|---|
| Unit (Rust) | `MergeSource` canonicalization and kind classification; blocker derivation from status/operation state/index; `MergePrediction` derivation from ahead/behind and merge-base; argument construction per mode (`--no-edit`, `--ff-only`) with no shell string. |
| Integration (Rust, real repositories) | The thirteen backend cases enumerated below. |
| Frontend/component | The seven UI cases enumerated below. |
| E2E | Merge a conflicting branch from the branch tree, resolve through the existing conflict flow, continue, and confirm the resulting merge commit; abort a second conflicted merge and confirm the pre-merge `HEAD`. |
| Accessibility | Automated axe pass on the merge dialog; context-menu keyboard flow per [`ui-shell.md`](ui-shell.md) §7. |
| i18n | `npm run check-i18n` green for all five locales. |
| OS-specific / manual | Merge in a repository with `core.autocrlf` enabled on Windows; merge with `commit.gpgsign = true` configured, confirming the signature is produced by system Git and Fjord adds nothing. |

**Backend / integration coverage (required):**

1. Merging another local branch with no conflicts succeeds and produces the
   expected `HEAD`.
2. Merging a branch already contained in the destination returns
   `AlreadyUpToDate` and advances no generation.
3. A strictly-ahead source returns `FastForwarded` and creates no merge commit.
4. A diverged source returns `Merged` with a two-parent commit.
5. A conflicting source returns `Conflicted { state }` whose state is
   `RepoOperation::Merge` with the expected conflicted paths, and the repository
   is left in Git's normal merge state on disk.
6. Aborting that conflicted merge through the existing `AbortOperation` path
   restores the pre-merge `HEAD`, index, and working tree and reports `Normal`.
7. Merging the current branch into itself is refused with
   `merge_source_is_current_branch` and changes nothing.
8. A missing or stale source ref fails with `merge_source_not_found` and changes
   nothing.
9. Starting a merge while a rebase (and separately a cherry-pick) is in progress
   is refused with `operation_already_in_progress` before Git is launched.
10. Dirty-tree behavior matches §4 exactly: staged changes are refused with
    `merge_index_has_staged_changes`; local modifications to a file the merge
    would change are refused with bounded `merge_would_overwrite` paths; local
    modifications to untouched files with a clean index **succeed**;
    `StashFirst` produces the named stash, merges, and never pops it.
11. No merge path performs a checkout or moves any ref other than the destination
    branch — asserted by comparing the complete ref set and `HEAD` symbolic
    target before and after every case above.
12. Generation and query invalidation are correct: `working_tree`, `refs`, and
    `history` advance on every outcome that launched Git (including conflict and
    cancellation), `stash` advances only for `StashFirst`, and `AlreadyUpToDate`
    advances nothing.
13. A source ref selected from a commit carrying several branch refs merges
    exactly that ref — asserted with a fixture commit carrying three branches
    where merging the second produces a different result from the first.

`FastForwardOnly` against a diverged source failing with `merge_not_fast_forward`
and changing nothing is covered as part of case 4's fixture.

`P10-MERGE-02` adds three cases to this list: merging a stale remote-tracking ref
merges exactly the object in `refs/remotes/` and performs **no** network call;
selecting **Fetch {{remote}} before merging** runs the existing fetch, re-resolves
the ref, and merges
the updated object, with the dialog showing the re-resolved commit id; and a
cancelled or failed fetch cancels the merge, leaving `HEAD`, the ref set, and the
working tree unchanged. No case asserts or requires a fetch timestamp.

**Frontend / component coverage (required):**

1. The left branch-tree context menu renders `Merge {{source}} into {{target}}…`
   with both names resolved from real data.
2. The commit-graph branch-label context menu renders the same action, and
   opening it on the second of three refs on one commit dispatches that ref.
3. The action is absent-or-disabled with a stated reason for the current branch,
   and disabled with `merge.blocked.remoteSourceNotSupported` for a
   remote-tracking row until P10-MERGE-02.
4. The merge dialog names both source and destination in its title and renders
   each `MergePrediction` variant as its own sentence.
5. A `Conflicted` result hands directly to the existing operation banner: the
   returned state is published to the query cache and the banner shows the merge
   with its conflicted paths, with no additional conflict UI introduced.
6. Context-menu keyboard accessibility: the menu opens from the keyboard, traps
   arrow navigation, closes on Escape, and restores focus to the originating row.
7. All three entry points dispatch the identical application action with an
   identical `MergeSource` payload — asserted against one spy, which is what
   makes "one merge flow" testable rather than aspirational.

The command-palette entry is covered by case 7 plus a palette test asserting it
lists local branches excluding the current one.

## Acceptance criteria

1. Right-clicking a local branch in the left tree offers
   `Merge <source> into <current>…`, naming both refs, and the same action is
   offered from that branch's label in the commit graph.
2. The action is never offered as an enabled control on the current branch, and
   its disabled state states why.
3. Choosing it opens a dialog naming the source and the destination and
   describing the concrete predicted outcome before anything runs.
4. A clean merge produces exactly one of `AlreadyUpToDate`, `FastForwarded`, or
   `Merged`, reported as a typed outcome rather than parsed text.
5. A conflicting merge returns `Conflicted` and the existing Phase 9 banner
   immediately shows the merge, its conflicted files, the merge-tool handoff, and
   Continue/Abort — with no conflict UI added by this spec.
6. Aborting a conflicted merge through the existing operation-abort path restores
   the pre-merge state.
7. No merge path ever checks out another branch, creates a local branch, or
   autostashes.
8. A merge is refused, with a stated reason and without launching Git, when
   another Git operation is in progress, when `HEAD` is detached or unborn, when
   the index holds staged changes, or when the merge would overwrite local work.
9. **Stash changes and merge** creates one Fjord-named stash containing tracked
   and untracked work, never pops it, and reports where the work is.
10. Merging a remote-tracking branch is either implemented per §2
    (P10-MERGE-02) or refused with a stated reason — never silently absent and
    never a hidden local-branch creation. When implemented, the dialog names the
    exact commit it will merge, states no fetch time, performs no network access
    unless **Fetch {{remote}} before merging** is selected, and re-resolves the ref and
    re-runs the preflight after that fetch. No task introduces a persisted
    fetch timestamp.
11. `Fast-forward only` against a diverged branch fails cleanly and changes
    nothing.
12. The branch tree, the graph branch label, and the command palette dispatch one
    shared application action, proven by test.
13. Every user-visible string in this spec exists in all five shipped locales and
    interpolates ref names rather than embedding them.
