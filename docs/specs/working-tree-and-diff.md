# Spec: working tree, partial staging, and diff experience

Referenced by: P8-00–P8-15, P10-WC-01–P10-WC-06, SDD §5.2, §15.
Related: [`git-backend.md`](git-backend.md), [`ipc-commands.md`](ipc-commands.md),
[`repository-safety.md`](repository-safety.md), [`performance.md`](performance.md),
[`branch-merge.md`](branch-merge.md), [`ui-shell.md`](ui-shell.md).

§1–§5 are implemented (Phase 8). §6 is designed and owned by `P10-WC-01`–
`P10-WC-06`; it is the single normative definition of the Working Changes file
context menu.

## Problem

Fjord can stage, unstage, commit, and push — but only at whole-file granularity
(`stage_files(paths)` / `unstage_files(paths)`, `crates/fjord-app/src/commands/repo.rs`).
That gap is the single most common reason a developer leaves a Git GUI mid-task:

1. **A file with two unrelated changes cannot be split into two commits.** The
   user must drop to a terminal for `git add -p`, and once they are in the
   terminal they will finish the whole task there.
2. **A mistake in the last commit requires a terminal.** There is no amend, so
   "forgot to stage a file" or "typo in the message" means `git commit --amend`
   elsewhere.
3. **Correcting a pushed branch requires an unsafe habit.** Fjord offers no force
   push at all, so the user runs `git push --force` by hand — the exact command
   that overwrites a colleague's work. Offering only `--force-with-lease` inside
   Fjord is strictly safer than offering nothing.
4. **The diff is readable but not comparable.** Unified-only, no syntax
   highlighting, no whitespace control, no word-level diff. Reviewing a
   reformatting commit or a renamed-variable commit is materially harder in Fjord
   than in any competitor, which pushes review work out of the app.
5. **Discarding is all-or-nothing and unguarded.** There is no partial discard,
   and no path that tells the user exactly what is about to be lost.
6. **A changed file has no actions beyond staging it.** Working Changes has no
   context menu at all (§6). Opening the file in an editor, revealing it in the
   file manager, copying its path, ignoring a generated artifact, exporting a
   patch, stashing it on its own, or deleting it all require another application.
   Individually small; together they are the reason a session keeps leaving the
   window.

## Goals

- Stage, unstage, and discard at hunk and selected-line granularity.
- Amend the last commit, including message-only amends, with an explicit warning
  when the commit is already published.
- Commit-and-push as one deliberate action.
- Force push available only as `--force-with-lease`, never bare `--force`.
- A diff view that supports unified and split modes, syntax highlighting,
  whitespace handling, and word-level highlighting, without regressing the diff
  performance budgets in [`performance.md`](performance.md).
- Upstream management and an explicit publish flow reachable from branch context.
- Every destructive action in this phase routed through the preflight contract in
  [`repository-safety.md`](repository-safety.md). `P8-00` implements that safety
  foundation before patch/discard or force-with-lease work begins; Phase 8 has no
  dependency on an unimplemented Phase 9 task.
- A right-click menu on a Working Changes file row that adapts to the exact row's
  staged/unstaged identity, reuses the shipped staging and discard paths rather
  than opening a second one, and introduces its context-menu seam as reusable
  shell infrastructure rather than panel-local logic (§6).

## Non-goals

- A built-in merge/conflict resolution editor. SDD §3 stands: conflicts hand off
  to the user's configured merge tool. Phase 9 improves the *state* handling
  around conflicts, not the editing of them.
- Interactive rebase and history rewriting beyond amend of `HEAD` — that is
  Phase 10.
- A code editor. Fjord never edits file contents; it edits the *index*.
- Committing from a stale snapshot. See [`performance.md`](performance.md) §6.
- Blame, file history, and per-line authorship. Valuable, but they answer a
  different question and are not what makes a user leave the app mid-commit.
- A file manager. §6's file actions open, reveal, ignore, export, and delete the
  files Git is already reporting as changed. Renaming, moving, creating files,
  browsing the tree outside the change set, and any recursive directory operation
  are out of scope — a file-row action never touches a directory.
- Generic shell command execution. Every §6 action is a typed command with a
  backend-validated repository-relative path; no user-supplied command line
  crosses IPC.
- Starting a branch merge. Merge initiation is
  [`branch-merge.md`](branch-merge.md); this spec's conflicted-file handling only
  refers to it.

## Current state

| Capability | State |
|---|---|
| Whole-file stage/unstage | ✅ `stage_files` / `unstage_files`, empty list = all. `git2`-backed. |
| Working changes listing | ✅ `WorkingChanges { staged, unstaged }`, `WorkingFile { path, changeType, conflicted }`; a partially-staged file legitimately appears in both lists. |
| Working file diff | ✅ `working_file_diff(path, staged, offset, limit)` — index-vs-HEAD when staged, worktree-vs-index otherwise. Returns a bounded `FileDiffWindow` with exact totals, continuation cursor, and `tooLarge` metadata. |
| Patch model/generation | ✅ `PatchSelection` uses hunk coordinates plus complete-hunk line indices and a SHA-256 `baseDigest`. Working diff windows expose a digest over path, source, modes, hunk headers, line content, and terminators; construction verifies it before emitting deterministic selected hunks. The read and existing `working_tree` generation are captured coherently. |
| Partial stage mutation | ✅ `stage_patch` reconstructs the current worktree diff under the repository write lock and Git's resolved per-worktree index lock, validates the caller's generation stamp and digest, applies through an alternate transactional index, revalidates the exact original-index SHA-256 fingerprint and current diff, then atomically publishes the index. The lock is the transaction boundary for standard Git writers; direct index writers that ignore it are outside the supported concurrency model. Every Phase 8 apply uses the deterministic `--whitespace=nowarn --no-ignore-whitespace` profile, so user `apply.whitespace` / `apply.ignoreWhitespace` settings cannot rewrite patch bytes or relax context matching. |
| Partial unstage mutation | ✅ `unstage_patch` uses the same index transaction and a prepared verify-only `git update-ref` transaction that holds HEAD and its symbolic target ref stable through index publication. It builds index-side context for selected changes and applies `--cached --reverse` without writing the worktree. |
| Commit | ✅ `commit_repo(message, amend)`; the panel composes `summary\n\ndescription`. |
| Amend | ✅ `get_amend_info` reports the `HEAD` message and published upstream; amend preserves the original author and parents, uses the current committer, and the panel restores its previous draft when the toggle is turned off. |
| Commit & push | ✅ `commit_and_push_repo` runs both phases under one operation id and returns both outcomes. A failed push leaves the new commit at `HEAD`; the panel clears the committed draft and reports the push failure explicitly. |
| Discard | ✅ File, hunk, and selected-line discard use the shared destructive preflight. The backend holds the resolved per-worktree index lock while it reconstructs the current index-to-worktree selection, runs `git apply --check --reverse`, revalidates the diff and exact index fingerprint, then contextually applies without writing HEAD or the index. |
| Push | ✅ System Git, target resolved from upstream, `no_upstream` → explicit publish (`publish_branch`). |
| Force push | ✅ `force_push_with_lease` resolves the upstream target, source OID, and expected remote OID authoritatively and binds those facts into the shared destructive preflight token before execution-time revalidation. |
| Diff rendering | ✅ Unified and split modes share the accumulated diff and virtualized renderer (`FileDiffView.tsx`). Split rows pair deletion/addition runs and pad the shorter side; the persisted header toggle remeasures the virtualizer and restores its logical scroll anchor. Syntax highlighting and thresholded word-level LCS run in a dedicated worker over visible rows only, after plain paint, and skip over-budget inputs. Word ranges are presentational and do not change patch coordinates. Show / ignore trailing / ignore all whitespace modes are backend diff options; ignored modes disable partial patch actions with a reason. Authoritative totals and loaded progress are visible; oversized files require an explicit load override, and binary/mode-only states retain whole-file actions. |
| Diff transport | ✅ 1,000-line incremental frontend windows, 2,000-line backend maximum, 2 MB response ceiling, and content-free metadata above 10 MB (`P6-16`). Every page is independently stamped with the complete `GenerationSet`; working pages also carry the complete rendered-diff digest. The frontend rejects the full accumulated result unless repository/path/source, digest, generations, file/change/mode metadata, totals, and the offset/continuation chain all agree, then clears selection and refetches from offset zero. |
| Upstream management | ✅ Local set/unset commands, branch-context selection, persistent publish affordance, and per-branch upstream/divergence display. |
| Branch context menu | ✅ checkout, create branch here, rename, delete, delete remote, copy (`GitContextMenu.tsx`, `RepoTree.tsx`). Merge is added by [`branch-merge.md`](branch-merge.md) §8. |
| Working Changes file actions | 🚧 A file row exposes only the hover Stage/Unstage control in `WorkingChangesPanel.tsx`. There is no context menu in Path or Tree view, and `FileEntryList.tsx` has no context-menu seam. Everything in §6 is unimplemented. |
| File open / reveal | ⚠️ `open_in_ide` and `open_terminal` operate on the **repository** path only; `IdeLauncher` has no file-or-line shape. `reveal_log_folder` establishes the per-platform folder-opener pattern for app-owned directories but is not reusable for repository files. |
| External diff tool | ⚠️ Only `open_merge_tool` (`git mergetool --no-prompt`, conflicts only). There is no diff-tool concept, setting, or command; the merge tool is not assumed to be the diff tool (§6.4). |
| `.gitignore` writing | 🚧 Absent. Fjord never writes `.gitignore`, global excludes, or `.git/info/exclude`. |
| File-scoped stash | 🚧 Absent. `stash_push` is whole-repository. |
| Patch export | 🚧 Absent. The `P8-01` patch constructor produces bytes for `git apply` but nothing exports them. |

The implemented Phase 8 partial-patch safety scope has passed independent final
verification: **SAFE TO PROCEED WITH DOCUMENTED LIMITATIONS**. That verdict
covers partial stage, unstage, discard, coherent diff snapshots, and rejected
snapshot recovery; it does not represent an absolute guarantee against
non-cooperating writers.

## Proposed design

### 1. Partial staging model

The unit of work is a **patch selection**, not a hunk id. A hunk id would be
invalidated by any concurrent edit; a patch selection is verified against the
current file state before it is applied.

```rust
pub struct PatchSelection {
    /// Path as reported by `working_changes`.
    pub path: String,
    /// Which side the selection was made against.
    pub source: PatchSource,          // Worktree | Index
    /// Line selections within hunks, addressed by original line numbers.
    pub hunks: Vec<HunkSelection>,
    /// Digest of the diff the selection was computed from.
    pub base_digest: String,
}

pub struct HunkSelection {
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    /// Empty means "the whole hunk"; otherwise the selected line indices
    /// within the hunk, 0-based over the hunk's `lines` array.
    pub lines: Vec<u32>,
}
```

`base_digest` is a hash of the diff the UI rendered (path, source, hunk headers,
line contents). Applying a selection recomputes the diff and compares digests:

- digests match → build the patch and apply it;
- digests differ → fail with `patch_stale`, the frontend refreshes the diff and
  tells the user the file changed. Fjord never applies a patch to a file it has
  not just verified.

P8-01 uses SHA-256 and also covers file modes and exact line terminators. Those
bytes are necessary to distinguish LF from CRLF and a missing final newline;
they do not change the line-coordinate addressing visible to the frontend.
Working-file diff transport returns the same digest on every bounded window and
associates it with a coherently captured existing repository generation.
The frontend treats the complete generation envelope, digest, requested
repository/path/source, file identity and modes, structural totals, and exact
`requested offset -> returned line count -> next offset` chain as one snapshot
identity. A mismatch invalidates every accumulated page; no partial result,
selection, or whole-file eligibility survives while the existing infinite query
is reset and refetched from offset zero. Commit-diff pages use the immutable
commit source plus their generation envelope and the same structural continuity
checks.
Binary, rename, mode-only, oversized/content-free, non-UTF-8 text, and empty-file
changes with no line hunk fail with `patch_unsupported` rather than being guessed
by the line-patch constructor. P8-15 owns the specified binary and mode-only UI.

### Added/deleted-file selection matrix

Whole-file selections retain canonical new-file/deleted-file patches. Partial
selections must use a representation proven against Git rather than reusing
whole-file headers:

| File state | Operation | Whole file | Hunk / selected lines |
|---|---|---|---|
| Added | Stage | supported | supported: new-file patch stages exactly the selected content |
| Added | Unstage | supported | supported: modified-file reverse patch removes only selected index lines |
| Added | Discard | supported | supported: modified-file reverse patch removes only selected worktree lines |
| Deleted | Stage | supported | supported: modified-file patch removes only selected index lines |
| Deleted | Unstage | supported | `patch_unsupported`: reverse application cannot restore only the requested deletion without changing unselected content under the current selection model |
| Deleted | Discard | supported | supported: deleted-file reverse patch restores exactly the selected worktree content |

The backend enforces this before its mutating `git apply` invocation and before
any index publication.
The frontend disables the known unsupported deleted-file unstage hunk and line
controls, but that is only UX alignment; backend rejection remains the boundary.

Application mechanism: build a minimal unified patch from the selection and apply
it with `git apply --cached` (stage), `git apply --cached --reverse` (unstage), or
`git apply --reverse` against the worktree (discard), through the shared
`GitCommandFactory` executable ([`system-git-transport.md`](system-git-transport.md)
§"Executable discovery" — one Git for everything). `git apply` is chosen over a
hand-written index writer because patch application is exactly where subtle
correctness bugs destroy user work, and Git's own implementation handles CRLF,
trailing-newline, mode, and binary edge cases that a reimplementation would get
wrong.

The mutation boundary uses Git's own cross-process synchronization. This is the
supported concurrency contract: patch mutations are safe against concurrent
Fjord operations, standard Git commands, and other Git clients that respect
Git's index/ref locking protocol.

- Stage and unstage acquire the index path resolved by libgit2 (including a
  linked worktree's private index), copy that exact index into the standard
  `index.lock`, and point `GIT_INDEX_FILE` at the lock while Git validates and
  applies the patch. A SHA-256 fingerprint of the complete original index is
  checked before the lock is atomically published over the index. Unrelated
  staged entries and index extensions therefore survive when writers follow
  Git's protocol.
- Unstage also starts a verify-only `git update-ref --stdin` transaction for the
  current HEAD OID or unborn state and leaves it prepared until index
  publication. Git resolves the active ref backend and locks HEAD plus its
  symbolic target, so commit/update-ref cannot turn a confirmed `HEAD=A,
  INDEX=B` reversal into `HEAD=B, INDEX=A`.
- Discard holds the same standard index lock without publishing it, from final
  reconstruction through `git apply --reverse`. Standard `git add`, commit,
  reset, checkout, and switch operations therefore cannot replace its index
  base after validation.
- Fjord's per-repository write lock serializes Fjord operations in-process. The
  Git-native index/ref locks are still acquired because they are the shared
  transaction boundary with other Fjord instances, the Git CLI, and conforming
  Git clients.

Lock contention or a changed backend-derived diff/index/HEAD state fails as
`patch_stale`; no generation advances. Ordinary success and error paths remove
the index/ref locks. A process crash can leave the same stale `.lock` files any
Git writer can leave and is handled by Git's standard lock diagnostics.

Direct raw modification or atomic replacement of the real index by a process
that intentionally ignores `index.lock` is unsupported concurrent modification.
The complete-index fingerprint is a defensive stale check: it detects a raw
replacement completed before that check, but it cannot guarantee detection of a
replacement between the check and publication. Filesystem rename/replace APIs do
not offer one portable compare-and-swap operation that both verifies the old
index identity or contents and publishes the new file, and advisory Git locks
cannot constrain a process that chooses to ignore them. Fjord therefore does not
claim corruption protection against malicious or nonconforming direct index
writers, and it does not substitute a non-portable filesystem CAS scheme for
Git's protocol.

Worktree/editor concurrency is a separate limitation. There is no portable
transaction joining arbitrary worktree-only writes to a file with Git's
index/ref locks. Editors and Git commands such as `git apply` without `--index`
deliberately do not acquire the index lock. Fjord narrows that limitation by
reconstructing the exact diff immediately before stage publication or discard
apply. For discard, Git then performs its own contextual validation while
updating the file. A write before this final reconstruction causes
`patch_stale`; a write in the remaining interval may race stage's atomic index
publication or discard's internal file replacement. Unstage is unaffected
because its confirmed `HEAD -> INDEX` diff does not depend on worktree bytes.

New port methods on `GitBackend` (local, no network):

```rust
async fn stage_patch(
    &self,
    repo: &RepoPath,
    selection: &PatchSelection,
    expected_generations: GenerationSet,
) -> Result<GenerationSet, GitError>;
async fn unstage_patch(
    &self,
    repo: &RepoPath,
    selection: &PatchSelection,
    expected_generations: GenerationSet,
) -> Result<GenerationSet, GitError>;
async fn discard_patch(
    &self,
    repo: &RepoPath,
    action: &DestructiveAction,
    selection: &PatchSelection,
    expected_generations: GenerationSet,
    confirmation_token: &str,
) -> Result<GenerationSet, GitError>;
```

Each validates the caller's complete generation stamp while holding the
repository write lock, bumps only the `working_tree` generation
([`performance.md`](performance.md) §5) on success, and returns the resulting
generation set.

New IPC commands: `stage_patch`, `unstage_patch`, `discard_patch`. The first two
take `{ repo_id, selection, expected_generations }`; discard additionally takes
the exact confirmed `action` and backend-issued `confirmation_token`. Each
returns the resulting `GenerationSet`. New stable error codes: `patch_stale`,
`patch_apply_failed`, `patch_unsupported` (binary or mode-only change that has no
line representation).

### 2. Partial staging UI

Selection lives in the diff view, which becomes interactive:

- Every hunk header gets **Stage hunk** / **Unstage hunk** / **Discard hunk**,
  depending on which side is displayed.
- Lines are selectable by click and shift-click (range) and by keyboard
  (`Shift+↑/↓`); with a selection active, the same three actions apply to the
  selected lines.
- The action buttons are disabled while the repository has an unvalidated
  snapshot or an operation in progress.
- After a successful apply, the diff refetches and the selection clears; the
  scroll position is preserved.
- A `patch_stale`, `patch_apply_failed`, or `preflight_stale` rejection latches
  the rendered diff non-actionable and clears selections/preflight. Completion
  or failure of invalidation is not validation: only a successful authoritative
  working-diff response may release the latch; mutation is never retried
  automatically. The latch and a monotonic fetch-sequence boundary live in the
  QueryClient under the exact repository/path/source identity. Every working-diff
  request receives a deterministic sequence when it starts, and all accepted
  windows must have sequences strictly beyond the rejection boundary before the
  latch clears. Cached success state, historical `dataUpdatedAt`, remount, and a
  successful response for another file or source cannot establish freshness.
- Discard always routes through the preflight dialog
  ([`repository-safety.md`](repository-safety.md) §3) showing line counts and the
  file path — never a bare "are you sure".

### 3. Amend, commit & push, force-with-lease

**Amend.** `commit_repo` gains `amend: bool`. When `amend` is true, the backend
commits with `HEAD`'s parent(s) and the current index, taking the author from the
original commit and the committer from the current identity — matching
`git commit --amend` semantics.

Before amending, the backend reports whether `HEAD` is published: `HEAD` is
contained in its branch's upstream ref. The UI shows an explicit warning in that
case ("this commit is already on `origin/main`; amending will require a force
push"). Amending is never blocked, only labeled — Fjord's job is to make the
consequence visible, not to override the user.

The commit panel gains an "Amend last commit" toggle that pre-fills the message
from `HEAD` and switches the button label. Toggling off restores the draft.

**Commit & push.** A split-button next to Commit. It runs commit, then push,
through the existing operation pipeline (one operation id, progress events per
[`operation-events.md`](operation-events.md)). A failed push after a successful
commit reports both outcomes distinctly: the commit is not rolled back, and the
UI says so.

**Force push.** `push_repo` gains `force_with_lease: bool`. **MUST FIX BEFORE
P8-09:** before any force-with-lease execution or preflight is offered, the
backend must authoritatively resolve the configured remote/upstream, actual
remote ref, and expected OID from backend Git state (including remote-tracking
state), compute consequences from those facts, bind all three to the destructive
confirmation, and execute only that bound lease. Caller-supplied remote, ref,
or expected-OID facts are never authority for the operation. The transport appends
`--force-with-lease=<remote_ref>:<expected_oid>` where `expected_oid` is the
locally known value of the remote-tracking ref — the explicit form, not the bare
flag, because bare `--force-with-lease` is defeated by a background fetch having
updated the tracking ref. Bare `--force` is not implemented anywhere in the code
path, and there is no setting that enables it.

Force push is offered only when a normal push failed with `git_non_fast_forward`,
inside a preflight dialog naming the remote ref, the commits that would be
dropped from the remote, and the expected OID. A stale-lease rejection maps to a
distinct code (`git_force_lease_failed`) with a "someone else pushed; fetch and
review" message.

### 4. Upstream management and publish

- Branch context gains **Set upstream…** (choose remote + remote branch) and
  **Unset upstream**, backed by new local commands `set_branch_upstream` /
  `unset_branch_upstream` — configuration writes, no network.
- The existing `publish_branch` flow is exposed explicitly as **Push & Set
  Upstream** from branch context and from a persistent affordance when the
  current branch has no upstream, instead of only as recovery from a failed
  push. Success refreshes refs/status so the row immediately names its new
  upstream; cancellation or remote rejection leaves local work and upstream
  configuration unchanged.
- The branch row shows its upstream and divergence, so "which remote does this go
  to" is answerable without opening a dialog.
- The Remotes section may explicitly push the current branch to several selected
  configured remotes. This uses ordinary non-force pushes, reports each result,
  and does not set or replace the branch upstream; ordinary **Push** continues to
  target exactly the one configured upstream.

Remote CRUD (add/edit/remove remotes) belongs to
[`workspace-workflows.md`](workspace-workflows.md) §3; this spec only selects
among existing remotes.

### 5. Diff experience

| Feature | Design |
|---|---|
| Unified / split | One renderer, two row-builders over merged `FileDiffWindow` data. Split mode pairs deletion/addition rows and pads the shorter side. Mode is persisted (`repo.diffMode`, [`ui-shell.md`](ui-shell.md) §5) and toggled from the diff header. |
| Syntax highlighting | Tokenization runs in a Web Worker (the pattern `graphLayout.worker.ts` already establishes), per visible window only, keyed by file extension. A file whose language is unknown or whose window exceeds the token budget renders unhighlighted rather than late. Highlighting never delays first paint of the diff: rows render plain and upgrade in place. |
| Whitespace | Header toggle: *show* (default), *ignore trailing*, *ignore all*. Implemented backend-side as `git diff` whitespace flags on the diff computation, so the hunk structure the user stages matches what they see. A whitespace-ignoring mode disables hunk staging for the affected hunks (`patch_unsupported`), because the displayed hunk is not the real patch. |
| Word diff | Intra-line diff computed frontend-side over paired add/delete lines within a hunk, in the worker, above a similarity threshold; below it, the pair renders as a plain replace. Purely presentational — it never changes what a patch selection stages. |
| Huge diffs | Implemented over the windowed transport from [`performance.md`](performance.md) §9: the view requests windows near the loaded end, shows authoritative total hunk/line counts from the first response plus loaded/total progress, and renders a `too_large` state with an explicit "load anyway". The override bypasses only the 10 MB source ceiling; per-request line and serialized-response ceilings remain enforced. |
| Binary / mode-only | Rendered as explicit states; mode-only changes name the old/new octal mode. Hunk actions are unavailable and whole-file stage/unstage remains. |

### 6. Working Changes file context actions

Owner of this contract. Every action below is reachable by right-clicking a file
row in **Working Changes**, in both the *Unstaged* and *Staged* sections and in
both **Path** and **Tree** view modes (`FileViewMode`, [`ui-shell.md`](ui-shell.md) §5).
Delivered by `P10-WC-01`–`P10-WC-06`; §6.9 fixes the dependency order.

Today a file row exposes exactly one action — the hover Stage/Unstage control in
`WorkingChangesPanel.tsx`'s `renderTrailing` — and no context menu exists
anywhere in the working-changes surface. Everything else a developer does with a
changed file (open it, reveal it, ignore it, export it as a patch, delete it)
requires leaving the app.

#### 6.1 Row identity is the contract

A partially staged file legitimately appears in **both** lists. Every context
action is therefore bound to the exact row the user opened the menu on, never to
a path alone:

```rust
pub struct WorkingFileTarget {
    pub path: String,
    /// Which row was clicked. Determines the diff side every action operates on.
    pub source: PatchSource,   // Worktree (unstaged row) | Index (staged row)
}
```

| Row | Diff side | Discard | Delete | Patch export |
|---|---|---|---|---|
| Unstaged | `INDEX -> WORKTREE` | ✅ worktree changes only | ✅ | from working changes |
| Staged | `HEAD -> INDEX` | ❌ not offered | ❌ not offered | from staged changes |

**Discard is never offered from a staged row**, and discarding from an unstaged
row never touches the index — that is already the `PatchSource::Worktree`
guarantee `discard_patch` enforces (§1). This removes, by construction, the
"Discard ambiguously destroyed my staged work" failure mode. A user who wants to
drop staged content unstages first, which is one visible step.

`Delete file…` is likewise offered only from the unstaged row (§6.5): deleting a
file that also carries staged content is exactly the ambiguous case this spec
refuses rather than guesses.

#### 6.2 Menu composition

**Unstaged file:**

```text
Stage
Discard working changes…
──────────────────────────
Ignore ▸                       (untracked files only)
Stash file…                    (P10-WC-05)
──────────────────────────
Open in <configured editor>
Open with default application
Show in folder
Open in external diff tool     (P10-WC-06)
──────────────────────────
Copy path ▸  Relative path
             Absolute path
Create patch from changes…
Copy patch to clipboard        (P10-WC-03 follow-up)
──────────────────────────
Delete file…
```

**Staged file:**

```text
Unstage
──────────────────────────
Open in <configured editor>
Open with default application
Show in folder
Open in external diff tool
──────────────────────────
Copy path ▸  Relative path
             Absolute path
Create patch from staged changes…
```

**Conflicted file** (`WorkingFile.conflicted`), either section:

```text
Open in <configured editor>
Open with default application
Show in folder
──────────────────────────
Open merge tool
──────────────────────────
Copy path ▸  Relative path
             Absolute path
```

Stage, Unstage, Discard, Ignore, Stash, patch export, and Delete are **all
withheld while a file is conflicted** — every one of them has ambiguous or
destructive semantics against an unmerged index entry, and refusing is the
documented behavior rather than guessing. `Open merge tool` reuses the shipped
`open_merge_tool` command.

Adaptivity rules:

- An action that does not apply to the row is **disabled with a stated reason**,
  not silently missing, wherever the user could reasonably expect it (Ignore on a
  tracked file, merge/diff-tool entries with nothing configured). Actions that
  belong to the other section entirely (Discard on a staged row) are absent — a
  disabled "Discard" on a staged row would teach the wrong model.
- Deleted files (`changeType = deleted`) hide Open / Show in folder / Delete;
  Copy path and patch export remain.
- Binary and mode-only changes hide patch export (`patch_unsupported`, §1) and
  keep everything else.
- While `whitespace != show`, patch export is disabled with the same reason
  P8-13 already uses: the displayed diff is not the patch Git would apply.

#### 6.3 Actions that reuse shipped backend behavior

| Action | Reuses |
|---|---|
| Stage / Unstage | `stage_files` / `unstage_files` with the single path — **the same call the inline row control makes**. No parallel Git path, no new command. |
| Discard working changes… | The complete shipped chain: whole-file `PatchSelection` over `PatchSource::Worktree` → `preflight_destructive_action` → shared `DestructivePreflightDialog` → one-use token → `discard_patch` ([`repository-safety.md`](repository-safety.md) §3). |
| Open merge tool | `open_merge_tool`. |
| Patch bytes for export | The `P8-01` deterministic patch constructor and digest verification — not a second diff implementation (§6.5). |

Contractual consequences:

- Context-menu Stage/Unstage behaves **exactly** like the inline control:
  identical payload, identical pending/disabled rules, identical
  generation-scoped invalidation. After the action the selection is preserved
  where the row still exists in either list, and falls back to no selection
  otherwise.
- The right-click path **must not** introduce any shortcut around the safety
  model. There is no `git checkout -- <path>` anywhere in the frontend or in an
  unchecked service method; discard remains bound to repository, file, source,
  digest, `GenerationSet`, and confirmation token.

#### 6.4 Actions that need new backend behavior

All new commands take a repository id plus a **repository-relative path**. The
backend canonicalizes the repository root, resolves the target's parent
directory, and asserts containment before doing anything. Rejected without
exception: absolute paths, `..` traversal, paths whose resolved parent escapes
the repository, and any path inside `.git`. The frontend never sends an
executable name, an argument list, or a shell string.

| Command | Purpose |
|---|---|
| `resolve_repository_file_path` | `{ repo_id, path }` → `{ relative, absolute }`, both backend-canonicalized. The only source of the absolute path used by Copy path. |
| `open_repository_path` | Opens a file in the configured editor/IDE, or with the OS default application, per an explicit `OpenTarget` mode. |
| `reveal_repository_path` | Shows the file in the platform file manager. |
| `open_external_diff` | Launches the configured external diff tool for one file and one side (`P10-WC-06`). |
| `add_ignore_rule` | Appends one rule to the repository-root `.gitignore` (`P10-WC-02`). |
| `preview_ignore_rule` | Read-only: the exact rule text and whether it is already present. |
| `export_patch` | Writes the patch for one file/side to a user-chosen destination (`P10-WC-03`). |
| `stash_file` | File-scoped stash (`P10-WC-05`). |
| `DestructiveAction::DeleteFile` | Delete through the existing preflight/token executor (`P10-WC-04`). |

**Opening files.** `IdeLauncher` gains an explicit file-and-position shape rather
than hard-coded OS strings in React:

```rust
pub enum OpenTarget {
    /// The configured IDE, or the auto-detected fallback — the existing allowlist.
    ConfiguredEditor { line: Option<u32> },
    /// The OS default application registered for the file type.
    DefaultApplication,
}

async fn open_path(&self, path: &Path, target: OpenTarget, ide: Option<&str>) -> Result<(), LaunchError>;
async fn reveal_path(&self, path: &Path) -> Result<(), LaunchError>;
```

- The IDE allowlist and the deliberate `custom:<command>` escape hatch are
  unchanged (SDD §9). `open_in_ide` keeps working; opening a *file* is the same
  port with a file path and an optional line.
- `line` is part of the shape from the start so a later
  **Open in Rider at line 147** from the diff view is a use of this contract, not
  a redesign of it. Line navigation itself is not required by `P10-WC-01`; when a
  configured editor cannot express a line, the file is opened without one.
- Menu label: `Open in {{ide}}` when a concrete editor is configured or detected
  (`Open in Rider`), otherwise `Open in configured editor`, disabled with a
  reason when nothing is available.
- Platform behavior for `DefaultApplication` and `reveal_path`, following the
  existing `reveal_log_folder` pattern (`crates/fjord-app/src/commands/settings.rs`)
  — one spawned process per platform, arguments passed individually, **no shell
  string concatenation and no `sh -c`**:

  | Platform | Default application | Show in folder |
  |---|---|---|
  | Windows | `explorer.exe <file>` | `explorer.exe /select,<file>` |
  | macOS | `open <file>` | `open -R <file>` |
  | Linux | `xdg-open <file>` | the file manager's reveal call where available, otherwise `xdg-open <parent-directory>` |

- Symlinks: the containment check resolves the **parent** directory, so a
  symlinked file is not followed to validate its target; the launcher receives the
  path inside the repository.

**External diff tool.** The merge tool and the diff tool are **not** assumed to be
the same application. `open_merge_tool` shells out to `git mergetool`, which is
conflict-only and drives `merge.tool`; a diff tool is `diff.tool` /
`difftool.<name>.cmd` and applies to any changed file. `P10-WC-06` therefore adds:

- a `Settings.diff_tool: Option<String>` preference
  ([`data-model.md`](data-model.md) planned additions), empty by default;
- `open_external_diff { repo_id, path, source }`, which runs the user's system
  Git `difftool --no-prompt -- <path>` (with `--cached` for a staged row) through
  the shared resolved executable, so the user's existing `diff.tool`
  configuration is honored and Fjord stores no tool command line of its own;
- when neither `Settings.diff_tool` nor Git's `diff.tool` resolves, the entry is
  disabled with a reason rather than failing at launch.

**Copy path.** *Relative path* is the repository-relative path as Git reports it
(forward slashes, the form that is portable and pasteable into a Git command).
*Absolute path* is `resolve_repository_file_path`'s backend-canonicalized value in
the OS's native form. The frontend never joins a root of its own onto a path.
Clipboard contents are never logged (SDD §10).

#### 6.5 Ignore, patch export, stash, delete

**Ignore (`P10-WC-02`).** Offered **only for untracked files**. `.gitignore` does
not untrack a tracked file, so an "Ignore" entry that appears to work on a tracked
file is a lie; on a tracked row the submenu is **disabled with the reason**
`workingFile.ignore.trackedFile`. A separate explicit "Stop tracking" workflow is
a possible future feature and is not created here.

For `src/generated/debug.log` the submenu offers three rules, each showing the
**exact text that will be written** before it is written:

| Menu item | Rule appended |
|---|---|
| Ignore this file | `/src/generated/debug.log` |
| Ignore all `.log` files | `*.log` |
| Ignore this folder | `/src/generated/` |

- Writes go to the **repository-root `.gitignore` only**. Fjord never modifies
  the global excludes file, `.git/info/exclude`, `core.excludesFile`, or any
  system/global Git configuration. A future feature may add those explicitly;
  this one must not.
- Missing `.gitignore` → created with UTF-8 content, no BOM, and LF terminators.
- Existing `.gitignore` → the file's dominant line terminator and encoding are
  preserved, a missing final terminator is added first, and the rule is appended
  as one new line. **No existing line is reordered, reformatted, or removed.**
- Duplicates: if the exact rule already exists as a non-comment, non-negated
  line (after trimming), nothing is written and the result is
  `IgnoreRuleOutcome::AlreadyPresent`, reported to the user. Fjord never appends
  a duplicate rule.
- The extension rule is offered only when the file has an extension; the folder
  rule only when the file is not at the repository root.
- The write advances the `working_tree` generation. `.gitignore` itself then
  legitimately appears as a modified or untracked file — that is Git's behavior
  and is not hidden.

**Create patch (`P10-WC-03`).** Exporting a patch is **non-destructive** — it
reads repository state and writes a file outside it, mutating nothing.

- Unstaged row → the `INDEX -> WORKTREE` selection; staged row → `HEAD -> INDEX`.
- Both reuse the shipped `PatchSelection` + `P8-01` deterministic patch
  constructor and its digest verification. **No second diff or patch
  implementation is created.**
- Destination comes from the native save dialog (the existing `dialog` plugin
  capability). Suggested default filename `<file-name>.patch`.
- The backend writes the bytes; the frontend never handles patch content for the
  file-export path. Patch bytes are never logged (§Security).
- `Copy patch to clipboard` is an optional follow-up within `P10-WC-03` and is
  the same bytes through the clipboard instead of a file.
- Verification requires that an exported patch **applies**: `git apply --check`
  (and `--cached --check` for the staged variant) succeeds against the matching
  fixture state.

**Stash file (`P10-WC-05`).** The invariant is absolute:

> Stashing one selected file preserves the Git state of every unrelated file
> byte-for-byte — index entries, worktree contents, and untracked files alike.

Fjord therefore does **not** implement it by hiding other changes, stashing, and
restoring them. That sequence has no atomic boundary and fails destructively on
interruption. The mechanism is Git's own pathspec-scoped stash:

```text
git stash push [-u] -m "Fjord: stash <path>" -- <path>
```

- Requires Git ≥ 2.13 for pathspec-limited `stash push`. The version is read
  through the existing `GitEnvironmentProvider`; an older Git disables the entry
  with the reason `workingFile.stashFile.unsupportedGit`.
- Runs under the repository write lock through the shared resolved executable
  with arguments passed individually.
- Behavior per file state, stated so the implementer invents nothing:

  | File state | Behavior |
  |---|---|
  | Unstaged tracked | Stashed and reverted to its index state. |
  | Staged tracked | Stashed; the path is reset to `HEAD`. |
  | Both staged and unstaged | Both sides are captured in the one stash entry for that path. |
  | Untracked | Requires `-u`; the file is removed from the worktree into the stash. |
  | Conflicted | **Refused** (`stash_file_conflicted`). |

- **Staged state is not preserved across a later pop.** Git restores a popped
  stash's content as unstaged unless the index is explicitly restored, and Fjord
  does not do that in v1. The dialog says so in one sentence rather than leaving
  the user to discover it.
- Dialog: title `Stash changes in {{path}}`, one message field prefilled with
  `Fjord: stash <path>`, plus the staged-state sentence above.
- If P10-WC-05's implementation cannot demonstrate the unrelated-file invariant
  with the tests in §Testing strategy, the correct outcome is to **not ship the
  action** and keep the task open. An approximate file stash is worse than no
  file stash.

**Delete file (`P10-WC-04`).** Destructive, never immediate, always through the
existing preflight contract:

```rust
DestructiveAction::DeleteFile { path: String }
```

- Rendered last in the menu, `danger`-styled, with an ellipsis, and routed
  through `preflight_destructive_action` → shared dialog → one-use token →
  `execute_destructive_action` ([`repository-safety.md`](repository-safety.md) §3).
  It reuses the shipped executor; it does not get a private command.
- Consequences and recoverability are exact and distinct:

  | File state | Consequence stated | Recoverability |
  |---|---|---|
  | Untracked | The file is not tracked by Git. Nothing — not the reflog, not a stash — holds a copy. | `NotRecoverable` |
  | Tracked, unmodified | Removed from the working tree; it appears as a Git deletion. The committed version stays in `HEAD`. | `Committed` |
  | Tracked, with uncommitted or staged changes | Both the file and those uncommitted changes are lost; the committed version stays in `HEAD`. | `NotRecoverable` |
  | Conflicted | Refused (`delete_file_conflicted`). | — |

  `Recoverability::Committed` is a new variant of the existing enum, meaning "the
  content is still in `HEAD` and can be restored from there". It is contractual
  in the same way the existing labels are: an action labeled `Committed` must
  leave the content retrievable from `HEAD`, asserted in tests. The existing rule
  that the label applies to the **complete** consequence set governs — this is
  exactly why a modified tracked file degrades to `NotRecoverable`.
- **Never recursive.** The action exists only on file rows. The backend refuses a
  path that resolves to a directory (`delete_target_not_a_file`); no directory is
  ever removed by a file-row action.
- **Symlinks: the link is deleted, never the target.** The parent directory is
  canonicalized for the containment check and the link itself is unlinked.
- The delete takes the repository write lock and advances the `working_tree`
  generation.

#### 6.6 Context-menu architecture

`WorkingChangesPanel.tsx` and `FileEntryList.tsx` must **not** accumulate this
logic. `FileEntryList` is a reusable presentation primitive shared with the
commit inspector; it stays that way.

```text
FileEntryList          presentation only; adds one prop:
                       onFileContextMenu?(file, anchor)  — position + identity, no Git

WorkingChangesPanel    passes each section's PatchSource and forwards the event

WorkingFileContextMenu builds the adaptive item list for one WorkingFileTarget
                       and renders it through the existing shared `ContextMenu`

useWorkingFileActions  owns dispatch: staging calls, preflight routing, dialogs,
                       IPC, invalidation — the only place Git semantics live
```

Names may follow whatever the implementing task finds idiomatic; the seam is what
is contractual:

- `FileEntryList` gains **one** callback and no Git-aware props. It never imports
  a mutation hook, a query key, or a domain action.
- The item list and the dispatcher are separately testable without rendering the
  panel.
- The menu reuses the shipped `ContextMenu` primitive from `GitContextMenu.tsx`
  (positioning, arrow navigation, Escape, `separatorBefore`, `disabledReason`,
  `danger`) rather than introducing a second popover implementation. Submenus
  (`Ignore`, `Copy path`) are a small addition to that shared primitive, not a new
  one.
- The seam is designed to be reused later by the Commit Inspector, File History,
  the Recovery Center, and the Conflict Resolver. Nothing in it may assume
  "working changes".

#### 6.7 Right-click, keyboard, and virtualization

The menu is not mouse-only. See [`ui-shell.md`](ui-shell.md) §7 for the shell-wide
rule; the file-row specifics are:

- Opening: right-click, `Shift+F10`, and the dedicated **Context Menu** key, all
  on the focused row. All three produce the identical payload.
- Opening focuses/selects the target row first, so the menu and the visible
  selection can never disagree about which file is acted on.
- The menu owns the **logical file identity** (`{ repoId, path, source }`), never
  a DOM node or a virtual-row index. `FileEntryList` is virtualized: a row that
  scrolls out is recycled, and a menu anchored to a recycled node would silently
  retarget. Menu state therefore lives above the virtualizer.
- If the identified file disappears from its section while the menu is open (an
  external edit, a concurrent stage), the menu closes rather than acting on a
  stale target.
- Keyboard navigation, focus trapping, and Escape follow the existing
  `ContextMenu` behavior; Escape closes and restores focus to the originating row.

#### 6.8 Tree view and directory rows

- Right-click on a **file** row in Tree view: the identical menu as Path view,
  with the identical payload. View mode is presentation and never changes
  semantics.
- Right-click on a **directory** row: no destructive action is exposed in this
  scope. `Delete` on a directory is explicitly out of scope and must not appear.
- Safe recursive directory actions (**Stage all in directory** /
  **Unstage all in directory**) are a possible follow-up, not part of
  `P10-WC-01`–`P10-WC-06`. Until then a directory row has no context menu.

#### 6.9 Dependency order

`P10-WC-01` establishes the seam and everything that reuses shipped backend
behavior; each later task adds one backend capability on top of it and can be
scheduled or dropped independently:

```text
P10-WC-01  seam + Stage/Unstage/Discard/Copy path/Open/Reveal   (foundation)
   ├── P10-WC-02  Ignore submenu + .gitignore writer
   ├── P10-WC-03  Create patch (+ optional clipboard)
   ├── P10-WC-04  Delete file… through the destructive preflight
   ├── P10-WC-05  File-scoped stash              (highest risk; may not ship)
   └── P10-WC-06  External diff tool + diff-tool setting
```

#### 6.10 i18n

All strings ship in all five locales; `npm run check-i18n` is the parity gate.
Paths, filenames, extensions, and rule text are interpolation variables, never
embedded in translated strings ([`i18n.md`](i18n.md)).

| Key (namespace `workspace`) | English |
|---|---|
| `workingFile.stage` / `workingFile.unstage` | `Stage` / `Unstage` |
| `workingFile.discard` | `Discard working changes…` |
| `workingFile.openInEditor` | `Open in {{ide}}` |
| `workingFile.openInConfiguredEditor` | `Open in configured editor` |
| `workingFile.openWithDefault` | `Open with default application` |
| `workingFile.showInFolder` | `Show in folder` |
| `workingFile.openExternalDiff` | `Open in external diff tool` |
| `workingFile.openMergeTool` | `Open merge tool` |
| `workingFile.copyPath` | `Copy path` |
| `workingFile.copyPath.relative` | `Relative path` |
| `workingFile.copyPath.absolute` | `Absolute path` |
| `workingFile.createPatch` | `Create patch from changes…` |
| `workingFile.createPatchStaged` | `Create patch from staged changes…` |
| `workingFile.copyPatch` | `Copy patch to clipboard` |
| `workingFile.patchSaved` | `Patch saved to {{path}}.` |
| `workingFile.delete` | `Delete file…` |
| `workingFile.ignore` | `Ignore` |
| `workingFile.ignore.file` | `Ignore this file` |
| `workingFile.ignore.extension` | `Ignore all {{extension}} files` |
| `workingFile.ignore.directory` | `Ignore this folder` |
| `workingFile.ignore.rulePreview` | `Adds {{rule}} to .gitignore` |
| `workingFile.ignore.alreadyPresent` | `.gitignore already contains {{rule}}.` |
| `workingFile.ignore.trackedFile` | `{{path}} is tracked by Git. Adding it to .gitignore would not stop tracking it.` |
| `workingFile.stashFile` | `Stash file…` |
| `workingFile.stashFile.title` | `Stash changes in {{path}}` |
| `workingFile.stashFile.message` | `Message` |
| `workingFile.stashFile.defaultMessage` | `Fjord: stash {{path}}` |
| `workingFile.stashFile.stagedNotPreserved` | `Staged state is not preserved: restoring this stash brings the changes back as unstaged.` |
| `workingFile.stashFile.unsupportedGit` | `Stashing a single file needs Git 2.13 or newer.` |
| `workingFile.disabled.conflicted` | `{{path}} has unresolved conflicts. Resolve them first.` |
| `workingFile.disabled.noEditor` | `No editor is configured. Choose one in Settings → Tools.` |
| `workingFile.disabled.noDiffTool` | `No external diff tool is configured.` |
| `workingFile.disabled.whitespaceMode` | `The displayed diff is not the patch Git would apply.` |
| `preflight.deleteFile.title` | `Delete this file?` |
| `preflight.deleteFile.confirm` | `Delete file` |
| `preflight.recoverability.committed` | `The committed version stays in HEAD and can be restored from there.` |
| `preflight.consequences.fileRemovedTracked` | `Remove {{path}} from the working tree; it will appear as a Git deletion.` |
| `preflight.consequences.fileRemovedUntracked` | `Delete {{path}}. Git has no copy of this file.` |
| `preflight.blockers.delete_target_not_a_file` | `Only files can be deleted from this menu.` |


## Alternatives considered

**Patch application: `git apply` vs. writing the index with `git2`.** A `git2`
implementation avoids a subprocess and is faster per call. It also requires
reimplementing patch semantics — line endings, missing trailing newlines, mode
changes, intent-to-add entries — in the one place where a bug silently destroys
uncommitted work. The subprocess cost (single-digit milliseconds) is irrelevant
next to that risk, and the executable is already unified. `git apply` is chosen.

**Selection addressing: hunk index vs. line coordinates + digest.** Hunk indices
are simpler but are invalidated by any change to an earlier hunk, and a
mis-resolved index stages the *wrong* change without any error. Coordinates plus
a verified digest can only fail loudly (`patch_stale`). Chosen for that failure
mode.

**Force push: not offered vs. `--force-with-lease` only vs. both.** Not offering
it does not prevent force pushes; it moves them to a terminal where no preflight
exists. Offering both makes the unsafe one available under a familiar name. Only
`--force-with-lease`, with an explicit expected OID and a preflight, is chosen as
the option that measurably reduces the chance of destroying someone's work.

**Syntax highlighting: backend vs. worker vs. main thread.** Backend highlighting
would add a language stack to Rust and put presentation logic behind IPC. Main
thread violates SLO-12. A worker is chosen, consistent with the existing graph
layout worker.

**Whitespace handling: frontend filtering vs. backend diff flags.** Filtering
whitespace rows in the frontend is trivial but makes the displayed hunks diverge
from the real patch, which is unacceptable once hunks are stageable. Backend
flags keep display and patch identical, at the cost of a recomputation on toggle.

**File context menu: one menu keyed by path vs. keyed by row identity (§6.1).**
Keying by path is simpler and is wrong for exactly the file that matters — a
partially staged file appears in both sections, and a path-keyed Discard would
have to guess which side it means. Carrying `PatchSource` with every target
costs one field and makes the ambiguous case unrepresentable.

**File context actions: in `WorkingChangesPanel` vs. a dispatch seam (§6.6).**
Putting the menu inline is fewer files today. It also turns a shared
presentation primitive into a Git-aware component, and it means the Commit
Inspector, File History, the Recovery Center, and the Conflict Resolver each grow
their own copy. The seam is chosen so the fifth consumer is configuration, not a
rewrite.

**File stash: hide-others / stash / restore vs. Git's pathspec stash (§6.5).**
The hide-and-restore sequence works on a whiteboard and has no atomic boundary:
an interruption between the stash and the restore leaves unrelated work in a
state neither Git nor the user asked for. `git stash push -- <path>` is Git's own
implementation of exactly this operation and preserves unrelated changes by
construction. The cost is a minimum Git version, which is checkable and stated.

**Delete file: a dedicated command vs. a `DestructiveAction`.** A dedicated
command would be three lines. It would also be the first destructive path in
Fjord that is not reachable through `execute_destructive_action`, undoing the
`P9-10` property that preflight enforcement is part of the service API shape
rather than a UI convention.

**Ignore: root `.gitignore` vs. `.git/info/exclude` vs. nearest `.gitignore`.**
`.git/info/exclude` is invisible to teammates and to the repository itself, which
makes "why is this ignored" unanswerable later. A nearest-directory `.gitignore`
is what some clients do and produces scattered files nobody reviews. The
repository-root file is the one a reviewer will actually see in the diff.

## Performance considerations

- Patch application is bounded by the selection, not the file: the generated patch
  contains only selected hunks. Applying a selection on the `diff-giant` fixture
  must stay within SLO-9's budget class, not scale with file size.
- The verification diff before apply is the same computation the view already
  performed; it reuses the `RepositoryRuntime` cache when the generation is
  unchanged, so the common case adds no Git work.
- Highlighting and word diff run per visible window only, in a worker, and are
  cancelled when the window scrolls away. Neither may delay the diff's first
  paint (SLO-9 / SLO-10).
- Split mode roughly doubles the rendered cells for the same content; the
  virtualizer is remeasured on mode change and restores the first visible
  logical diff row to avoid a scroll jump.
- Amend and commit-and-push run through the existing operation pipeline and
  therefore inherit progress and cancellation without new machinery.
- The §6 context menu adds **no** per-row subscription, query, or listener.
  `FileEntryList` rows stay presentational and virtualized; the menu's item list
  is computed once, on open, from data the panel already holds. A menu that cost
  work per rendered row would regress the working-changes list on `wt-huge`.
- Menu state lives above the virtualizer (§6.7), so opening a menu neither
  remeasures nor re-renders the list.
- Every §6 backend action is an explicit user action off the hot path: path
  resolution and process launches are one call each, the ignore write is one
  bounded read-modify-append, and patch export reuses a diff the view has
  usually already computed for the current generation.
- `stash_file` and `DeleteFile` are ordinary write-lock mutations that advance
  only `working_tree` (and `stash` for the former); neither forces a full
  repository refetch.

## Security / safety

- Every mutating command in this phase takes the repository write lock and runs
  through the shared resolved Git executable; no shell strings.
- `discard_patch` is irreversible for the discarded lines. It is gated by the
  preflight contract, it reports exact line counts, and it refuses to run against
  an unvalidated snapshot. Its short-lived, one-use confirmation is bound to the
  repository, action, complete patch selection and digest, and generation set;
  validation and consumption happen under the repository write lock.
- Amend of a published commit is permitted but always labeled with its
  consequence.
- Force push is `--force-with-lease` with an explicit expected OID; a stale lease
  fails closed.
- Patch content passes through the process runner's bounded buffers and is never
  logged; log lines carry path and counts only (SDD §10).
- `patch_stale` must be surfaced to the user, never retried automatically —
  an automatic retry against a changed file is exactly the failure mode the digest
  exists to prevent.
- The standard per-worktree index lock spans final validation and mutation for
  stage, unstage, and discard. Unstage also holds a prepared verify-only HEAD ref
  transaction. These locks guarantee serialization with standard Git commands
  and clients that honor Git's locking protocol. Exact index fingerprints add a
  stale check before publication but are not a CAS guarantee against
  lock-ignoring direct index replacement.
- Worktree-only writers that do not take Git's index lock (editors and commands
  such as `git apply` without `--index`) remain advisory-unaware. The final diff
  reconstruction and Git's contextual discard apply reduce but cannot portably
  eliminate the residual interval described in §1; no stronger guarantee is
  claimed.

Additional rules for the §6 file actions:

- Every path crossing IPC is **repository-relative**. The backend canonicalizes
  the repository root, resolves the target's parent, and asserts containment.
  Absolute paths, `..` traversal, a resolved parent outside the repository, and
  anything under `.git` are rejected before any process is spawned or any byte
  written. A symlinked file is not followed to validate its target.
- No §6 action accepts a command line, an executable name, or an argument list
  from the frontend. Editor launches keep the existing `IdeLauncher` allowlist
  and the deliberate `custom:<command>` escape hatch; default-application and
  reveal launches pass arguments individually with **no shell string
  concatenation and no `sh -c`**; the external diff tool is invoked through the
  user's own Git `difftool` configuration rather than a Fjord-stored command.
- `Delete file…` is destructive and runs only through the shared preflight,
  confirmation token, and `execute_destructive_action` executor. It is never
  recursive, never follows a symlink to its target, and refuses a directory or a
  conflicted file rather than guessing.
- Discard from a file row remains the shipped `PatchSource::Worktree`
  whole-file selection. There is no `git checkout -- <path>` and no unchecked
  service method anywhere in the context-menu path.
- The `.gitignore` writer touches exactly one file in the repository working
  tree. It never writes global excludes, `.git/info/exclude`, `core.excludesFile`,
  or any global/system Git configuration, and it never rewrites, reorders, or
  removes an existing line.
- Patch bytes are written by the backend and never logged, and clipboard
  contents (paths or patches) are never logged (SDD §10).
- Recoverability labels stay contractual: `Committed` must leave the content
  retrievable from `HEAD`, asserted in tests, exactly as `Reflog` and `Stash`
  already are ([`repository-safety.md`](repository-safety.md) §3).

## Testing strategy

| Level | Coverage |
|---|---|
| Unit (Rust) | Patch generation from a selection: whole hunk, single line, first/last line of a file, file without trailing newline, CRLF file, added file, deleted file. Digest stability and mismatch detection. Force-with-lease argument construction. |
| Integration (Rust) | Against real fixtures: stage one hunk of a two-hunk file and assert `working_changes` shows the file in both lists; unstage a single line; discard a hunk and assert the worktree content; deterministic barriers prove standard external add/checkout/commit operations fail or serialize on Git's locks, and separately exercise the bounded stale checks for an editor write and a raw index replacement completed before final verification; compare HEAD, raw index, cached/unstaged diffs, worktree bytes, generations, and lock cleanup; linked-worktree index-path coverage; amend with and without a message change; amend preserves the original author; push with a stale lease is rejected with `git_force_lease_failed`. |
| Frontend/component | Hunk and line selection interactions; disabled states while pending or unvalidated; `patch_stale` refreshes and informs; split/unified row building; whitespace toggle disables hunk staging where the patch is not representable; `too_large` state. |
| E2E | Split a two-change file into two commits entirely through the UI; amend the message of the last commit; commit-and-push in one action with the push failing and the commit surviving. |
| Benchmark | Diff rendering and highlighting against `diff-giant`; patch apply latency on a large file; split-mode render cost vs. unified. |
| OS-specific / manual | CRLF repository on Windows; a file with mixed line endings; a repository with `core.autocrlf` enabled. |

### §6 file context actions — required coverage

**Component tests** (`P10-WC-01` unless noted):

1. Right-clicking an **unstaged** row renders the §6.2 unstaged menu.
2. Right-clicking a **staged** row renders the §6.2 staged menu — with no
   Discard and no Delete entry.
3. Both of the above in **Path** view and in **Tree** view, with identical
   payloads.
4. Adaptive states: a conflicted row renders only the conflicted menu; a deleted
   file hides Open/Show/Delete; a binary file hides patch export; a
   whitespace-ignoring mode disables patch export with its reason; Ignore is
   disabled with `workingFile.ignore.trackedFile` on a tracked row.
5. Stage and Unstage from the menu dispatch the **same** call with the same
   payload as the inline row control, asserted against one spy.
6. Every destructive entry (Discard, Delete) opens the shared preflight dialog
   and executes nothing before confirmation.
7. Escape closes the menu and restores focus to the originating row; the menu
   also closes when its target file leaves its section.
8. `Shift+F10` and the Context Menu key open the menu on the focused row with the
   identical payload as right-click.
9. Virtualized row identity: scrolling the list while a menu is open must not
   retarget it — the menu keeps `{ path, source }` and does not follow the
   recycled DOM node.
10. Tree view: a **directory** row exposes no destructive action, and no `Delete`
    entry exists on it in any state.

**Backend / integration tests:**

1. Ignore writes the exact-filename rule to the repository-root `.gitignore` and
   the file leaves the untracked list (`P10-WC-02`).
2. Ignore writes the extension rule (`*.log`) — same assertions.
3. Ignore writes the directory rule (`/src/generated/`) — same assertions.
4. A duplicate rule is a no-op returning `AlreadyPresent`; the file is unchanged
   byte-for-byte, including its terminators.
5. `.gitignore` creation, terminator preservation on an existing CRLF file, and
   preservation of every unrelated line.
6. Ignore for a **tracked** file is unavailable and, if requested directly, is
   refused by the backend — it never writes.
7. `stash_file` on one file leaves every unrelated staged entry, worktree byte,
   and untracked file identical — the §6.5 invariant, asserted for each of the
   five file states (`P10-WC-05`).
8. `stash_file` on a conflicted file is refused; an unsupported Git version is
   refused before any mutation.
9. Configured-editor open validates the path: traversal, absolute paths, `.git`
   paths, and a symlink whose target lies outside the repository are all
   rejected without spawning a process.
10. Default-application open and reveal perform the same validation and
    construct the documented per-platform argument vector with no shell string.
11. `open_external_diff` operates on exactly the selected file and side, and is
    refused when no diff tool resolves (`P10-WC-06`).
12. An exported **unstaged** patch passes `git apply --check` against the fixture
    and reproduces the change when applied (`P10-WC-03`).
13. An exported **staged** patch passes `git apply --cached --check` and
    reproduces the index state.
14. Deleting an **untracked** file is labeled `NotRecoverable` in its preflight,
    and the deletion is atomic against a forged/unissued token (`P10-WC-04`).
15. Deleting a **tracked, unmodified** file is labeled `Committed`, produces the
    expected Git deletion in `working_changes`, and the content is retrievable
    from `HEAD`; a tracked file with uncommitted changes degrades to
    `NotRecoverable`.
16. Delete refuses a directory (`delete_target_not_a_file`) and a conflicted
    file, and deletes a symlink without touching its target.
17. `resolve_repository_file_path` returns the canonical relative and absolute
    forms and rejects every escape attempt in test 9's set.

Existing preflight, token, staging, and patch-construction tests are **reused**;
none of the above re-tests `discard_patch`, `stage_files`, or the patch
constructor themselves.

## Acceptance criteria

1. Staging one hunk of a file with two hunks results in `working_changes`
   reporting that file in both `staged` and `unstaged`, and a commit records only
   the staged hunk's content.
2. Staging a selected subset of lines within a hunk stages exactly those lines,
   verified by comparing the resulting index blob against the expected content.
3. Unstaging and discarding at hunk and line granularity produce the inverse
   results, verified against index and worktree content respectively.
4. Applying a selection whose file changed on disk since the diff was rendered
   fails with `patch_stale`, changes nothing, and the UI shows the refreshed diff.
5. Discarding any amount of work presents a preflight that names the file and the
   exact number of lines to be discarded before anything is applied.
6. Amending the last commit with an unchanged tree and a new message produces a
   commit with the new message, the original author, and the original parents.
7. Amending a commit contained in its branch's upstream shows a published-commit
   warning before the action is available.
8. "Commit & push" with a failing push leaves the commit in place and reports the
   commit as succeeded and the push as failed, distinctly.
9. No code path constructs a `git push --force` invocation. Before P8-09 can
   execute force push, the backend authoritatively resolves and binds the
   configured remote/upstream, remote ref, and expected OID to its destructive
   confirmation; force push then emits only
   `--force-with-lease=<ref>:<oid>` from those bound facts.
10. A force push whose lease is stale fails with `git_force_lease_failed` and does
    not modify the remote.
11. The diff view toggles between unified and split, and the choice survives a
    restart.
12. Syntax highlighting never delays the diff's first painted row; rows appear
    unhighlighted and upgrade in place, verified by a trace showing first paint
    before the first highlight commit.
13. With a whitespace-ignoring mode active, hunk-level staging is unavailable and
    the reason is shown, rather than staging a patch that differs from the display.
14. Setting a branch's upstream through the UI changes only configuration, is
    reflected in the branch row, and a subsequent push targets the new upstream.
15. Concurrent Fjord operations, standard Git commands, and Git clients that
    honor Git's index/ref locking protocol serialize at the final patch mutation
    boundary, without partial mutation or generation advancement on failure.
    Direct raw index replacement that ignores those locks is explicitly outside
    this guarantee; the fingerprint may detect it before publication but is not
    an arbitrary-writer CAS.
16. Index locks use the linked worktree's resolved private index path, and all
    ordinary success/failure paths remove index, HEAD, and target-ref locks.
17. Right-clicking a file row in Working Changes opens a menu whose entries match
    the row's section and state, in both Path and Tree view, and the same menu is
    reachable with `Shift+F10` and the Context Menu key.
18. Context-menu Stage and Unstage are indistinguishable from the inline controls
    in payload, pending behavior, and invalidation.
19. Discard from a context menu opens the same shared preflight as every other
    discard and executes only through a fresh confirmation token; no context-menu
    path reaches an unchecked Git call.
20. A file present in both the staged and unstaged sections offers Discard only
    from the unstaged row, and that discard leaves the staged content untouched.
21. `Ignore` is offered only for untracked files, shows the exact rule before
    writing it, appends it to the repository-root `.gitignore` without altering
    any other line, and never appends a duplicate.
22. Stashing one file leaves every unrelated staged, unstaged, and untracked
    change identical, and the dialog states whether staged state is preserved.
23. An exported patch applies cleanly with `git apply` against the state it was
    exported from, for both the unstaged and the staged side.
24. `Delete file…` never executes immediately, states its consequence and
    recoverability per §6.5, is never available on a directory row, and deletes a
    symlink rather than its target.
25. `FileEntryList` exposes only a context-menu callback and remains free of Git
    semantics; the menu's item list and its dispatcher are testable without
    rendering the working-changes panel.
