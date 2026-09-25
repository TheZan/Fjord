# Spec: in-app conflict resolution

Referenced by: P12-MERGE-03, SDD §5.2, §15.
Related: [`repository-safety.md`](repository-safety.md),
[`branch-merge.md`](branch-merge.md),
[`working-tree-and-diff.md`](working-tree-and-diff.md),
[`workspace-workflows.md`](workspace-workflows.md),
[`git-backend.md`](git-backend.md), [`ipc-commands.md`](ipc-commands.md),
[`ui-shell.md`](ui-shell.md).

This spec is the single normative owner of *resolving* a conflicted path.
Operation state, the operation banner, and Continue/Skip/Abort are owned by
[`repository-safety.md`](repository-safety.md) and are referenced here, never
redefined. Starting a merge is owned by [`branch-merge.md`](branch-merge.md);
rebase by [`workspace-workflows.md`](workspace-workflows.md) §2. Neither of them
gains conflict-resolution surface: they produce a conflicted index, and this
spec owns everything that happens to it afterwards.

## Problem

Phase 9 made Fjord able to *detect* a conflict, list the conflicted paths, hand
off to the user's configured external merge tool, and Continue or Abort the
operation. Phase 10 made Fjord able to *start* every operation that produces
one: merge, squash merge, rebase, interactive rebase, cherry-pick, revert, stash
apply.

What Fjord cannot do is **resolve a single conflicted file**. The only
resolution path is `git mergetool`, which requires a configured external tool,
opens a separate application per file, and is the wrong instrument for the most
common case by far: *the whole file from one side wins*. A rename/delete
conflict, or an `added by them` conflict, has no text to merge at all — there is
nothing for a three-way editor to do, and yet today it also forces the user out
of Fjord.

Once the user has left for a terminal to run `git checkout --theirs -- path`,
they will finish the operation there too. This is the same failure mode
[`branch-merge.md`](branch-merge.md) identified for starting a merge, one step
later in the same workflow.

## Goals

- Resolve a conflicted path by **choosing a side**, or by **marking it
  resolved**, without leaving Fjord and without a configured external tool.
- Work identically for **every** producer of a conflicted index — merge, squash
  merge, rebase, interactive rebase, cherry-pick, revert, stash apply — because
  the model is the index, not the operation.
- Name the two sides by their **real refs**, never as "ours" and "theirs".
- Handle conflicts that have no content to merge (add/add, modify/delete,
  delete/modify, rename cases) as first-class outcomes rather than as errors.
- Refuse to stage a file that still contains conflict markers without saying so.
- Leave the existing merge-tool handoff, the operation banner, and
  Continue/Skip/Abort exactly as they are.

## Non-goals

- **A built-in three-way merge editor.** SDD §3 and §15 stand: conflict
  *content* belongs to the user's configured merge tool. This spec offers whole
  paths and sides, never an editing surface for hunks inside a conflicted file.
- **Hunk-level conflict resolution.** Deliberately excluded with the editor: a
  per-hunk side chooser is an editor with extra steps.
- **Automatic resolution.** Fjord never picks a side for the user after a
  conflict. The one exception is chosen *before* a merge starts and has
  shipped separately: `-X ours` / `-X theirs` as the typed
  `MergeStrategyOption` ("when both sides change the same lines, prefer
  `{{ref}}`"), off by default behind the merge dialog's Advanced disclosure, with
  an explicit warning that the other side's conflicting lines are discarded
  without review. It is owned by [`branch-merge.md`](branch-merge.md) §10.4
  (`P12-MERGE-05`), not by this spec; a merge run without it produces conflicts
  exactly as before.
- **Resolving conflicts in a worktree other than the active one.**
- **Changing what Continue/Skip/Abort do.** A fully resolved index is the
  precondition they already enforce.

## Current state

| Area | State |
|---|---|
| Conflict detection | `LocalGitBackend::fresh_index(..).has_conflicts()`, and `conflict_paths` in `crates/fjord-git/src/local/status.rs` |
| Conflict shape | Collapsed to `Vec<String>`: `conflict.our.or(conflict.their).or(conflict.ancestor)` — the stage structure that distinguishes a modify/delete from a both-modified is discarded at the source |
| Operation state | `RepoOperationState.conflicted_paths`, surfaced by the Phase 9 banner |
| Working Changes | A `conflicted` badge per row (`WorkingChangesPanel.tsx`), no conflict-specific action |
| Resolution | `open_merge_tool` (`git mergetool --no-prompt`) for the whole repository, plus ordinary `stage_files`, which stages conflict markers silently |
| Squash merge | Already reads conflicts live from the index rather than from `RepoOperationState`, because `merge --squash` never writes `MERGE_HEAD` (`P10-MERGE-03`) |

## Proposed design

### 1. The model is the index

The source of truth is the **live index**, read through
`git2::Index::conflicts()`, not `RepoOperationState`.

This is not an implementation preference; it is required for correctness.
`git merge --squash` and `git stash apply` produce a conflicted index while
`operation_state::detect` correctly reports `Normal`, because neither writes
`MERGE_HEAD` or a sequencer directory. `P10-MERGE-03` already established this
shape and proved it with an integration test asserting `operation_state` stays
`Normal` through a real conflicted squash. A resolution model keyed on operation
state would be silently unavailable in exactly those cases.

`RepoOperationState.conflicted_paths` keeps its current meaning and its current
owner. It is a *summary for the banner*; this spec's read is the detail view.
Both derive from one index read per refresh.

### 2. Domain model

```rust
/// One conflicted path, with the index stages that actually exist for it.
pub struct ConflictEntry {
    pub path: String,
    pub kind: ConflictKind,
    pub base: Option<ConflictStage>,   // stage 1
    pub ours: Option<ConflictStage>,   // stage 2
    pub theirs: Option<ConflictStage>, // stage 3
}

pub struct ConflictStage {
    pub blob: CommitId,     // object id of that stage
    pub mode: u32,
    pub size: Option<u64>,
    pub binary: bool,
}

pub enum ConflictKind {
    BothModified,  // 1 + 2 + 3
    BothAdded,     // 2 + 3, no base
    AddedByUs,     // 1 + 2
    AddedByThem,   // 1 + 3
    DeletedByUs,   // 1 + 3, ours absent
    DeletedByThem, // 1 + 2, theirs absent
    BothDeleted,   // 1 only
}
```

`ConflictKind` is **derived from which stages are present**, never parsed from
Git's porcelain output. The derivation is a pure function and is unit-tested per
combination.

```rust
pub struct ConflictSet {
    pub entries: Vec<ConflictEntry>,
    pub truncated: bool,
    pub total: u32,
    pub sides: ConflictSides,
    pub generations: GenerationSet,
}
```

`entries` is bounded at **1000** paths, ordered by byte path, with `truncated`
and the exact `total` reported, per the bounded-transport rule in
[`performance.md`](performance.md). A repository with more than 1000 conflicted
paths is a repository whose conflict is not resolved file by file; the banner
and the merge-tool handoff remain available for it.

### 3. Sides are named by ref, never "ours"/"theirs"

```rust
pub struct ConflictSides {
    pub ours_label: String,   // e.g. "main", "HEAD (detached)"
    pub theirs_label: String, // e.g. "feature/payments", "stash@{0}"
    pub inverted: bool,       // true while a rebase is in progress
}
```

This is the single most dangerous detail in the whole feature. During a rebase,
Git's `--ours` is the branch being rebased **onto** and `--theirs` is the commit
being replayed — the exact opposite of the intuition a user carries over from a
merge. A UI that renders a raw "Take theirs" button is a way to silently discard
work.

Therefore:

- The backend derives both labels from the operation actually in progress, and
  sets `inverted` for the rebase family. Labels come from `MERGE_HEAD`,
  `REBASE_HEAD`/`rebase-merge/onto`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, or the
  applied stash, falling back to a short object id when no ref name exists.
- Every user-visible control interpolates a label:
  **Keep `{{ours}}` version** / **Keep `{{theirs}}` version**. No shipped string
  contains the words "ours" or "theirs" as a side name.
- `inverted` is not used to reorder anything. It exists so the UI can state
  plainly which side is the branch and which is the commit being replayed, and
  so tests can assert the labels are the way round Git actually means.

### 4. Resolution actions

One command, `resolve_conflict`, with a typed resolution rather than a Git flag:

```rust
pub enum ConflictResolution {
    TakeOurs,       // keep our stage's content, then stage it
    TakeTheirs,     // keep their stage's content, then stage it
    KeepFile,       // modify/delete: keep the surviving side's content
    DeleteFile,     // modify/delete: remove the path
    MarkResolved,   // stage the worktree file as it currently is
}
```

| `ConflictKind` | Offered resolutions |
|---|---|
| `BothModified` | Take ours, Take theirs, Mark resolved, Open merge tool |
| `BothAdded` | Take ours, Take theirs, Mark resolved, Open merge tool |
| `AddedByUs` / `DeletedByThem` | Keep file, Delete file |
| `AddedByThem` / `DeletedByUs` | Keep file, Delete file |
| `BothDeleted` | Delete file (the only coherent resolution) |

A resolution the kind does not offer is refused by the backend with
`conflict_resolution_not_applicable`, not merely hidden in the UI.

Implementation runs through the shared resolved system Git, under the repository
**write lock**, with the path passed after `--` as a single argument and never
as command text:

- `TakeOurs` / `TakeTheirs` / `KeepFile` → `checkout --ours|--theirs -- <path>`
  followed by `add -- <path>`.
- `DeleteFile` → `rm -f -- <path>`.
- `MarkResolved` → `add -- <path>` (see §5).

Both steps run as one logical action: if the second fails, the first is reported
and the path stays conflicted in the returned set rather than half-resolved and
silently staged.

`MutationKind::ResolveConflict` advances **`working_tree` only**. No ref moves,
no commit is created, no history changes — the same mask reasoning as
`P10-MERGE-03`'s squash. The command returns the refreshed `ConflictSet` so the
UI never has to guess whether the operation is now resolvable.

### 5. Mark resolved refuses invisible damage

`MarkResolved` is the one action whose Git equivalent (`git add`) will happily
stage a file containing `<<<<<<<`, `=======`, `>>>>>>>`. Committed conflict
markers are a routine, embarrassing, and entirely preventable way to break a
branch.

Before staging, the backend performs a **bounded scan** of the worktree file —
at most the first 1 MiB, line-oriented, no full read of a large file — for a
line starting with `<<<<<<< `, `=======` or `>>>>>>> `. If one is found, the
action fails with `conflict_markers_present` naming the first offending line
number. The UI states the reason and offers **Stage anyway**, which repeats the
call with an explicit `allow_markers` acknowledgement. Binary files skip the
scan.

The default is refusal. The override exists because a legitimate file (this
spec, for one) can contain those sequences, and Fjord does not get to be sure.

### 6. UI

Working Changes ([`working-tree-and-diff.md`](working-tree-and-diff.md)) grows a
**Conflicts** group above Staged and Unstaged, present only while the index has
conflicts. Each row shows the path, a localized `ConflictKind` label, and the
resolution actions from §4 in its context menu, alongside the existing
**Open in merge tool** entry.

- The group is driven by the same live index read as the rest of the panel, so
  it appears after a conflicted squash merge and a conflicted `stash apply`,
  where no operation banner exists at all.
- Resolving the last conflicted path removes the group, and the Phase 9 banner's
  Continue control becomes available through its existing derivation
  (`available_controls(.., conflict_free)`) — this spec adds no new enabling
  logic.
- Ordinary Stage / Unstage / Discard stay unavailable on a conflicted row: they
  are not meaningful against a multi-stage index entry, and their disabled
  reason names the conflict.
- Keyboard, ARIA, and focus-restore behavior follow
  [`ui-shell.md`](ui-shell.md) §7 exactly as the existing file context menu does.

No new dialog and no new panel. Resolution is a row action, because the user is
already looking at the row.

### 7. Backend contract

New commands in [`ipc-commands.md`](ipc-commands.md):

| Command | Payload | Returns |
|---|---|---|
| `get_conflicts` | `{ repo_id }` | `GenerationEnvelope<ConflictSet>` |
| `resolve_conflict` | `{ repo_id, path, resolution, allow_markers?, expected_generations, operation_id? }` | `ConflictSet` |

`get_conflicts` is read-only, runs under the repository **read** lock, and is
validated by the `working_tree` generation. `resolve_conflict` validates
`expected_generations` before it mutates, so a resolution computed against a
stale view fails `preflight_stale` rather than acting on a different file, the
same contract `stage_patch` already uses.

A batch form is deliberately **not** in v1. Resolving 30 paths to one side is
one keystroke away from discarding a day's work, and the multi-selection
contract in [`working-tree-and-diff.md`](working-tree-and-diff.md) §7 already
describes how a batch action would have to be built if it is ever wanted.

## i18n

All strings are added to `en` and mirrored across the five shipped locales, with
ref names interpolated rather than embedded, and with Git vocabulary checked
against `src/locales/en/glossary.md`:

`conflicts.group`, `conflicts.kind.*` (seven), `conflicts.takeSide`,
`conflicts.keepFile`, `conflicts.deleteFile`, `conflicts.markResolved`,
`conflicts.stageAnyway`, `conflicts.rebaseSidesExplanation`,
`conflicts.truncated`, `errors.conflict_markers_present`,
`errors.conflict_resolution_not_applicable`,
`workingFile.disabled.pathIsConflicted`.

`conflicts.takeSide` is one key interpolating `{{ref}}`, which is what makes the
§3 rule enforceable by `npm run check-i18n` rather than by review.

## Performance considerations

One `git2` index read per refresh serves both the banner summary and this
detail view; the conflict set is derived in the same pass, not by a second
scan. The entry list is bounded at 1000 and each stage carries an object id and
size rather than content — no blob is read to build the set. The marker scan in
§5 happens only on `MarkResolved`, only for the single path acted on, and is
bounded at 1 MiB.

Every resolution advances one generation (`working_tree`), so the existing
generation-scoped invalidation refreshes Working Changes and the operation state
and nothing else.

## Security / safety

- Paths cross IPC as data and reach Git after `--`, never interpolated into a
  command line. Path traversal outside the worktree is refused by the same
  validation the existing working-file commands use.
- No conflicted content is logged. Diagnostics carry path counts and stable
  codes, never file bodies.
- Every mutation holds the repository write lock, so a resolution cannot
  interleave with a merge, rebase step, or stash operation.
- Nothing in this spec can move a ref, create a commit, or drop a stash. The
  worst outcome of a wrong resolution is a staged file that Discard, Reset, or
  the operation's own Abort recovers — all of which already exist.
- `Abort` remains the single escape hatch and is unchanged.

## Testing strategy

| Level | Coverage |
|---|---|
| Unit (Rust) | `ConflictKind` derivation for all seven stage combinations; `ConflictSides` labeling per operation family including the rebase inversion; marker-scan detection, its 1 MiB bound, and its binary skip; argument construction per resolution with no shell string |
| Integration (Rust, real repositories) | The eleven cases below |
| Frontend/component | The six cases below |
| E2E | Merge a conflicting branch from the branch tree, resolve every path inside Fjord, Continue, and assert the resulting merge commit's tree matches the chosen sides — no external merge tool involved |
| Accessibility | Automated axe pass on the Conflicts group; context-menu keyboard flow per [`ui-shell.md`](ui-shell.md) §7 |
| i18n | `npm run check-i18n` green for all five locales |

**Backend / integration coverage (required):**

1. A both-modified conflict from a real merge yields `BothModified` with all
   three stages populated and the correct object ids.
2. `TakeOurs` and `TakeTheirs` each produce exactly the corresponding stage's
   content in the worktree and in the index, asserted by object id.
3. A modify/delete conflict yields `DeletedByThem` (and its mirror
   `DeletedByUs`), offers only Keep/Delete, and refuses `TakeTheirs` with
   `conflict_resolution_not_applicable` without touching the index.
4. `DeleteFile` removes the path from the index and the worktree, and the
   operation can then Continue.
5. An add/add conflict yields `BothAdded` with no base stage.
6. `MarkResolved` on a file still containing markers fails
   `conflict_markers_present` naming the line, changes nothing, and succeeds
   with `allow_markers`.
7. The same resolution flow works against a conflicted **`merge --squash`**,
   where `operation_state` is `Normal` throughout — the case that justifies §1.
8. The same flow works against a conflicted **rebase**, and `ConflictSides`
   reports the onto-branch as `ours` with `inverted = true`.
9. The same flow works against a conflicted **`stash apply`**.
10. Resolving the final conflicted path makes the operation's Continue control
    available through the existing Phase 9 derivation, with no new code path.
11. Generations: every successful resolution advances `working_tree` and nothing
    else; a refused resolution advances nothing; a stale
    `expected_generations` fails `preflight_stale` before any mutation.

**Frontend / component coverage (required):**

1. The Conflicts group renders one row per entry with its localized kind, and is
   absent when the index is clean.
2. Take-side entries render real ref names; a rebase renders the onto-branch as
   the `ours` side and states the inversion.
3. A kind's inapplicable resolutions are absent from its menu.
4. `conflict_markers_present` renders its reason and the **Stage anyway**
   affordance, which re-dispatches with the acknowledgement.
5. Stage/Unstage/Discard are disabled on a conflicted row with a stated reason.
6. The group appears after a conflicted squash merge, where no operation banner
   is shown — proving the UI is index-driven, not banner-driven.

## Acceptance criteria

1. A conflicted file can be resolved to either side, or marked resolved, from
   its row in Working Changes, with no external tool configured.
2. Every side control names the actual ref it refers to; no shipped string
   presents a side as "ours" or "theirs".
3. During a rebase, the side labels are the way round Git actually means, and
   the UI says so.
4. Conflicts with nothing to merge — add/add, modify/delete, delete/modify,
   both-deleted — are offered coherent resolutions rather than a merge-tool
   handoff that cannot help.
5. Staging a file that still contains conflict markers is refused by default,
   names the first offending line, and is possible only through an explicit
   acknowledgement.
6. Resolution works identically for merge, squash merge, rebase, interactive
   rebase, cherry-pick, revert, and stash apply, proven by test for at least
   merge, squash merge, rebase, and stash apply.
7. Resolving the last conflict enables Continue through the existing Phase 9
   control derivation, with no second enabling path.
8. No resolution moves a ref, creates a commit, or changes history; every one
   advances `working_tree` alone.
9. The existing merge-tool handoff, operation banner, and Continue/Skip/Abort
   are unchanged.
10. Every user-visible string exists in all five shipped locales.
