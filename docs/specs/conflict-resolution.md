# Spec: in-app conflict resolution

Referenced by: P12-MERGE-03 (**shipped**), SDD §5.2, §15.
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
- **Automatic resolution.** Fjord never picks a side for the user. `-X ours` /
  `-X theirs` as a *merge strategy option* is a separate, explicitly-flagged
  decision owned by [`branch-merge.md`](branch-merge.md) §10, not by this spec.
- **Resolving conflicts in a worktree other than the active one.**
- **Changing what Continue/Skip/Abort do.** A fully resolved index is the
  precondition they already enforce.

## Current state

**Shipped by `P12-MERGE-03`.** The table below is the state after it; the
pre-Phase-12 state it replaced is kept in the right-hand column for context.

| Area | State (shipped) | Before `P12-MERGE-03` |
|---|---|---|
| Conflict read | `crates/fjord-git/src/local/conflicts.rs::raw_conflicts` — one pass over `git2::Index::conflicts()`, ordered by byte path, keeping every stage. `LocalGitBackend::conflict_paths` (the banner summary in `RepoOperationState.conflicted_paths`) is now a projection of the same pass | `conflict_paths` collapsed each conflict to one path, discarding the stages |
| Conflict model | `ConflictEntry` / `ConflictStage` / `ConflictKind` / `ConflictSides` / `ConflictSet` / `ConflictResolution` in `fjord-domain`; `ConflictKind::from_stages` is the pure derivation | `Vec<String>` |
| Detail read | `conflicts::read_set` behind `GitBackend::conflicts` and IPC `get_conflicts` | — |
| Resolution | `conflicts::resolve` behind `GitBackend::resolve_conflict` and IPC `resolve_conflict` (operation kind `resolve-conflict`), `MutationKind::ResolveConflict` → `working_tree` | `open_merge_tool` only, plus `stage_files`, which staged conflict markers silently |
| Working Changes | `ConflictsGroup.tsx` above Staged/Unstaged, fed by `useConflicts`; conflicted Staged/Unstaged rows keep their badge and diff, with Stage/Unstage/Discard disabled and the reason `workingFile.disabled.pathIsConflicted`; **Stage all** skips conflicted paths | A `conflicted` badge per row and an enabled Stage |
| Squash merge / stash apply | Resolved through the same group; the operation state stays `Normal` throughout | Merge tool only |

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
    BothModified,  // 1 + 2 + 3   (UU)
    BothAdded,     // 2 + 3       (AA)
    AddedByUs,     // 2 only      (AU)
    AddedByThem,   // 3 only      (UA)
    DeletedByUs,   // 1 + 3       (DU)
    DeletedByThem, // 1 + 2       (UD)
    BothDeleted,   // 1 only      (DD)
}
```

`ConflictKind` is **derived from which stages are present**, never parsed from
Git's porcelain output. The derivation is a pure function
(`ConflictKind::from_stages`) and is unit-tested per combination. The seven
non-empty stage subsets map one-to-one onto the seven kinds, named as
`git status` names them. (An earlier draft of this spec listed `AddedByUs` as
1 + 2 and `AddedByThem` as 1 + 3, which collides with the two delete kinds; the
shipped derivation follows Git.)

`ConflictStage.size` comes from the object database header, never from reading
the blob, and `ConflictStage.binary` from `.gitattributes` (`binary`, `-diff`,
`-merge`, `-text`) — again without reading content.

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
  As shipped (`conflicts::sides`):
  - A commit is named by a local branch at it (other than the checked-out
    one), then a remote-tracking branch, then a tag, then its short id.
  - `ours` is the checked-out branch, or `HEAD`'s short id when detached; during
    a rebase it is the `onto` commit's name and `theirs` is the branch being
    rebased (`head-name`), or `REBASE_HEAD`'s short id for a detached rebase.
  - `merge --squash` and `stash apply` write no marker. Fjord records the
    squash source label and the applied `StashId` when its own command leaves
    a conflict; the stash is re-resolved to its current `stash@{n}` at read
    time. Without a record, `SQUASH_MSG`'s newest `commit <oid>` names a squash
    source, and `stash@{0}` — what a plain `git stash apply` applies — names a
    stash. With neither, `theirs_label` is empty and the UI substitutes the
    localized `conflicts.unknownSide`.
- Every user-visible control interpolates a label:
  **Keep `{{ours}}` version** / **Keep `{{theirs}}` version**. No shipped string
  contains the words "ours" or "theirs" as a side name. `npm run check-i18n`
  enforces both halves: it fails on any catalog value containing "ours" or
  "theirs" as a word, and on any locale whose `conflicts.takeSide` does not
  interpolate `{{ref}}`. The `ConflictKind` labels interpolate the refs too
  ("changed on `{{ours}}`, deleted on `{{theirs}}`"), so a kind never names a
  side by a pronoun either.
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
silently staged. As shipped, a failed step returns `conflict_resolution_failed`
(bounded, sanitized Git stderr in `diagnostics`) instead of a set; `checkout
--ours|--theirs` only rewrites the worktree file, so the index still holds the
path's conflict stages and the next `get_conflicts` — which the UI's failure
path invalidates — reports it conflicted. `working_tree` still advances, because
the worktree file may have changed.

Every step runs with `GIT_LITERAL_PATHSPECS=1`: after `--` Git would still read
`*.txt` as a glob or `:(glob)x` as pathspec magic, and a resolution must touch
exactly the named path. The path is first checked lexically (relative, normal
components only, no `.git`) with the helper `delete_file::normal_relative_path`
shares with Delete file, then looked up among the live index's conflicts; a
path that is not a current conflict fails `preflight_stale`, like a stale
generation, because the view it came from no longer matches.

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

As shipped (`conflicts::first_marker_line`): the markers are the lines Git
itself writes — `<<<<<<<`, `>>>>>>>` and the diff3 `|||||||`, each alone or
followed by a space and a label, and a line that is exactly `=======` (a CRLF
ending is ignored). A Markdown setext underline of another length is not a
marker. "Binary" means a NUL byte in the first 8000 bytes, Git's own heuristic;
a missing file, a directory or a symlink has nothing to scan. The error carries
the path in `paths` and the line in the new `AppError.line` field.

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

As shipped:

- `useConflicts` reads `get_conflicts` whenever the status, the operation state
  or a Working Changes row reports a conflict, under the query key
  `[...workingChanges, "conflicts"]`, so every working-tree invalidation also
  refreshes the set.
- The group lists each entry once with its kind label. The same paths stay in
  Staged/Unstaged with their `conflict` badge, so their diff (with the markers)
  is still one click away; there, Stage/Unstage/Discard are rendered disabled
  with `workingFile.disabled.pathIsConflicted`, and **Stage all** skips them.
- The row menu offers exactly the kind's resolutions — an inapplicable one is
  absent, not disabled — then **Open merge tool**, open-in-editor, reveal,
  copy path, and disabled Stage/Discard naming the conflict. **Keep file** names
  the surviving side's ref.
- `conflict_markers_present` renders an inline `role="alert"` row inside the
  group with **Stage anyway** and **Dismiss**; it is not a dialog or a banner.
- During a rebase the group states `conflicts.rebaseSidesExplanation`; a
  truncated set states `conflicts.truncated` with the exact total.
- A successful resolution invalidates status, working changes and the operation
  state; Continue then appears through the unchanged
  `available_controls(.., conflict_free)`.

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

Shipped additionally (all five locales): `conflicts.keepFile` interpolates the
surviving side's `{{ref}}`; `conflicts.unknownSide` substitutes for an empty
side label; `conflicts.dismiss` closes the marker warning; `conflicts.resolved`
is the success notice; `errors.conflict_resolution_failed` covers a failed Git
step. `errors.*` live in the `common` namespace, the rest in `workspace`.

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

### Where the required coverage lives (shipped)

- Unit (Rust): `fjord-domain` — `conflict_kind_is_derived_from_every_stage_combination`,
  `conflict_kind_offers_exactly_the_spec_resolutions`, `keep_file_takes_the_surviving_side`;
  `crates/fjord-git/src/local/conflicts.rs` — marker detection, its 1 MiB bound,
  binary skip, look-alike rejection, and per-resolution argument vectors;
  `generation.rs` — the `ResolveConflict` mask; `fjord-app` `error.rs` — the
  three stable codes and the `line` field.
- Integration (Rust): `crates/fjord-git/src/local/tests/conflicts.rs` —
  `case_01` … `case_11` in the order listed above, plus literal pathspecs
  (`[ab].txt`, which as a glob would also match `a.txt`), the 1000-entry bound with an exact `total`, a clean index, and
  cherry-pick/revert side labels.
- Component: `src/presentation/ConflictsGroup.test.tsx` (cases 1–5, axe),
  `RepoDetailContainer.test.tsx` (case 4's re-dispatch from a real
  `conflict_markers_present`, case 6's index-driven read with the operation
  `Normal`), `WorkingFileContextMenu.test.tsx` and `WorkingChangesPanel.test.tsx`
  (case 5 on Staged/Unstaged rows, Stage all skipping conflicts).
- E2E: `e2e/merge-conflict-resolution.spec.ts` merges from the branch tree,
  resolves three paths (keep one side, keep the other, delete) inside Fjord,
  Continues, and asserts the merge commit's parents and tree against real Git.

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
