# Spec: stash management

Referenced by: `P10-STASH-01`–`P10-STASH-06`. Extends, and does not replace, the
stash facts already owned by [`repository-safety.md`](repository-safety.md) §3–§4
(destructive preflight, safe checkout) and
[`working-tree-and-diff.md`](working-tree-and-diff.md) §6.5 (the Working Changes
entry points).

## Purpose

Fjord already *touches* the stash from four unrelated places — a toolbar button,
a toolbar pop, stash-and-checkout, stash-and-merge, and the `P10-WC-05`
file-scoped stash — but it has no stash **feature**. There is no way to see what
a stash contains, to act on anything other than `stash@{0}`, to name a stash the
way you name a commit, or to get a stash back onto a branch of its own.

This spec is the single owner of the stash product, domain, and action semantics.
Its goal is one coherent daily-driver workflow built on the machinery that
already exists, not a second stash subsystem beside it.

The one sentence the rest of the document exists to make true:

> A stash is a first-class object in Fjord — it has a name, a place in the tree,
> a place in the graph, an inspector, a diff, and a menu — and every action on it
> targets the exact entry the user selected, no matter how the stack has moved
> since.

## Goals

- Stash **all** changes, **one** file, or **several selected** files through one
  contract.
- Give every interactively created stash a user-authored name.
- Browse stashes in the repository tree, ordered exactly as Git's stack is.
- Inspect a stash: its base commit, its branch, its files, its diff — with the
  staged / working / untracked structure Git actually recorded, not a flattened
  approximation.
- See a stash in the commit graph, attached to the commit it was created from.
- Apply, Pop, Drop, Create branch from, and Copy — from one shared menu with one
  shared application action, reachable from the tree, the graph, and the
  inspector.
- Act safely on **any** entry, never only the top of the stack.

## Non-goals

- Cloud, shared, team, or forge-hosted stashes. A stash is local by definition.
- A Fjord-owned stash database. Git owns stash state; §1 is emphatic about this.
- Editing a stash's contents, re-ordering the stack by drag and drop, or
  rewriting stash commits.
- A generic reflog browser. `refs/stash`'s reflog is read as the stash stack, not
  exposed as history. Reflog browsing is the Recovery Center
  ([`repository-safety.md`](repository-safety.md) §5).
- Exposing Git's internal stash parent commits as ordinary commit-graph history.
  §5 is explicit: the graph shows a **marker**, never the stash's own commits as
  a lane.
- Auto-stashing. [`branch-merge.md`](branch-merge.md) §4 and
  [`repository-safety.md`](repository-safety.md) §4 stand unchanged: Fjord never
  stashes work the user did not ask it to stash.
- The Working Changes selection model. Multi-selection serves five batch actions,
  only one of which is stash, so it is owned by
  [`working-tree-and-diff.md`](working-tree-and-diff.md) §7; §7 below records the
  split.

## Current state

| Capability | State |
|---|---|
| Stash list | ✅ `get_stashes` returns the rich repository-derived `StashEntry` of §1, in exact Git stack order and cached against the `stash` generation. |
| Stash identity | ✅ `StashId` is the stash commit OID. The backend resolver maps it to the current position and fails closed when it is missing or ambiguous; mutation adoption remains owned by `P10-STASH-06`. |
| Create stash (all) | ✅ `create_stash { scope: All }` runs ordinary system Git `stash push [-u] -m …`; the toolbar uses the shared required-name dialog. |
| Create stash (one path) | ✅ `Stash file…` is `create_stash { scope: Paths { paths: [p] } }`, using the same exact object construction as any larger set. Both §2.3 invariants are covered by real-Git creation and apply/pop fixtures. |
| Create stash (many paths) | ✅ The backend/IPC accepts `Paths { paths }` for N paths and constructs a normal exact-scope stash. The Working Changes multi-selection entry point remains `P10-WC-MULTI-02`. |
| Apply | 🚧 Absent. There is no apply-without-consuming anywhere in the product. |
| Pop | ⚠️ Already on the confirmed destructive path — there is no `stash_pop` IPC command, and `execute_destructive_action`'s `StashPop { index }` arm already builds `stash pop stash@{index}` for an **arbitrary** index. The limitation is entirely in the frontend, which hard-codes `index: 0` at both dispatch sites in `RepoDetailContainer.tsx`, and in the action's index-keyed identity. Separately, `GitBackend::stash_pop` / `mutations::stash_pop` (`git2`, always index 0) is **dead production code** reached only by tests. |
| Drop | 🚧 Absent. |
| Create branch from stash | 🚧 Absent. |
| Stash in the repository tree | 🚧 Absent. `RepoTree.tsx` has exactly three sections: Local, Remote, Tags. |
| Stash in the commit graph | 🚧 Absent. |
| Stash inspector / diff | 🚧 Absent. The only stash text in the UI is `stash@{0}` in a completion notice and a count badge on the toolbar overflow's Pop entry. |
| Destructive coverage | ⚠️ `DestructiveAction::StashPop { index }` exists with `StashEntryConsumed { index, message }` facts and `NotRecoverable`, keyed on the unstable index. There is no `StashDrop`. |
| Generations | ✅ `MutationKind::StashPush` / `StashPop` both map to `WORKING_STASH`, and the watcher's `stashes` change set maps to `stash` ([`performance.md`](performance.md) §5). |

### Contradictions this spec resolves

These are pre-existing disagreements between the shipped code and the documents,
found while writing this spec. Each is corrected in place by the task that owns
the surrounding text; none of them is a behavior change on its own.

1. [`repository-safety.md`](repository-safety.md)'s Current-state row states
   "`stash_pop` (pops `stash@{0}` only)" as a property of the *feature*. Two
   things are wrong with that. First, `stash_pop` is not an IPC command at all —
   it is not in `invoke_handler`, and production pop runs through
   `execute_destructive_action`, which already accepts an arbitrary index.
   Second, the `GitBackend::stash_pop` method whose doc comment says
   "Applies and drops `stash@{0}`, the most recent entry" has **no production
   caller**: only tests reach it. The spec therefore documents the limitation of
   a code path the app never executes, while the real limitation — the frontend
   passing a literal `index: 0` — is undocumented. `P10-STASH-06` fixes the
   frontend, retypes the action on `StashId`, and deletes the dead port method;
   the row is corrected to say so.
2. [`git-backend.md`](git-backend.md) says `stash_file`'s Git-version check runs
   "through `GitEnvironmentProvider`". It does not: `stash_file.rs` parses
   `git --version` directly through the resolved `GitCommandFactory`. That was a
   deliberate simplification recorded in `P10-WC-05`'s task entry but never
   carried back into the spec. Corrected to describe what exists.
3. [`ipc-commands.md`](ipc-commands.md) lists the planned error code
   `stash_file_unsupported`; the shipped code and all five locales use
   `stash_file_unsupported_git`. Corrected to the shipped spelling.
4. [`ipc-commands.md`](ipc-commands.md)'s "Planned additions" table still lists
   `export_patch`, `stash_file`, and `open_external_diff`, which shipped with
   `P10-WC-03`/`05`/`06` and already appear in the shipped tables above it.
   Removed from Planned.
5. [`working-tree-and-diff.md`](working-tree-and-diff.md)'s Current-state table
   still says "File-scoped stash 🚧 Absent" and "Working Changes file actions 🚧
   … Everything in §6 is unimplemented", both of which `P10-WC-01`–`P10-WC-06`
   made false. Corrected.

None of these is a stash *behavior* bug. The one behavioral gap they collectively
point at is the real subject of this spec: **`stash@{n}` is used as identity in
places where it is not identity.**

## Proposed design

### 1. Rich stash model and stable identity (`P10-STASH-01`)

#### 1.1 The identity rule

> `stash@{n}` is a **position**, not a name. The stash commit OID is the identity.

Positions move. Pushing a stash renumbers every existing entry; dropping
`stash@{1}` renumbers everything below it. A UI that holds `index: 2` across a
watcher event and then pops it is not popping what the user selected — it is
popping whatever moved into slot 2. Fjord therefore carries the **stash commit
OID** as the logical identity of every stash in every layer: query cache, tree
row, graph marker, inspector, context menu, preflight, and executor.

```rust
/// The stash commit's object id. Immutable, repository-authoritative, and the
/// only value any stash action is allowed to be keyed on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct StashId(pub String);
```

`StashId` is a distinct newtype rather than a reused `CommitId` on purpose: a
stash commit is not a commit the user may check out, revert, cherry-pick, or see
in history, and the type system should not offer it where a `CommitId` is
expected.

#### 1.2 The entry

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct StashEntry {
    /// Stable identity. Never rendered as-is except through Copy actions.
    pub id: StashId,
    /// Current position in the stack. Display and re-resolution only.
    pub index: u32,
    /// Current display reference, `stash@{2}`. Recomputed on every read,
    /// never stored, never accepted as an action input.
    pub ref_name: String,
    /// Git's own entry text, verbatim: `On develop: Payment validation WIP`.
    pub message: String,
    /// Display title: `message` with a recognized `On <branch>: ` /
    /// `WIP on <branch>: ` prefix removed; equals `message` when no prefix
    /// matched. Derived, display-only.
    pub title: String,
    /// First parent of the stash commit — the commit the work was stashed
    /// from. This is what the graph marker attaches to and what
    /// "Create branch from stash" branches at.
    pub base: CommitId,
    /// Short branch name parsed from `message`'s prefix. `None` for a stash
    /// created on a detached HEAD (`WIP on (no branch)`) or any message whose
    /// prefix does not parse. Display-only; never an action input.
    pub branch: Option<String>,
    /// Committer time of the stash commit.
    #[serde(with = "time::serde::rfc3339")]
    #[ts(type = "string")]
    pub created_at: OffsetDateTime,
    /// Exact number of paths `Apply` would touch — the size of the
    /// base-tree-to-stash-tree diff, plus the untracked entries.
    pub files_changed: u32,
    /// The index commit's tree differs from the base tree: this stash carries
    /// staged state that `Apply` can restore with `--index`.
    pub has_index_state: bool,
    /// A third parent exists **and its tree is non-empty**. Presence alone is
    /// not enough — see §1.4.
    pub has_untracked: bool,
}
```

The existing two-field `StashEntry` is replaced, not shadowed by a second type.
Its only consumers are `get_stashes`, `useStashes`, and the toolbar's count
badge; all three are updated with it.

#### 1.3 Where the data comes from

Git owns stash state. Fjord derives every field above from the repository, on
every read:

| Field | Source |
|---|---|
| `id` | The stash commit OID from `refs/stash`'s reflog entry. |
| `index`, `ref_name` | The entry's current position in that reflog, newest first. |
| `message` | The reflog entry's message — the same text `git stash list` prints. |
| `title`, `branch` | Parsed from `message` (§1.5). |
| `base` | The stash commit's **first** parent. |
| `created_at` | The stash commit's committer time. |
| `files_changed`, `has_index_state`, `has_untracked` | Tree comparisons among the stash commit's parents (§1.4). |

**Nothing is persisted.** No SQLite table, no settings key, no cache file, no
Fjord-authored stash name store. A stash created by `git stash` in a terminal is
indistinguishable from one Fjord created, because there is nothing extra for
Fjord to have written. This is the same rule the rest of the app follows for Git
data ([`data-model.md`](data-model.md) §"What's deliberately *not* here").

#### 1.4 Stash commit structure

A stash commit's parents are the whole model:

```text
stash commit  ── tree: the WORKING TREE at stash time
  │
  ├─ parent 0: base        ── the commit HEAD pointed at
  ├─ parent 1: index       ── tree: the INDEX at stash time
  └─ parent 2: untracked   ── tree: the untracked files (present only with -u)
```

From which:

- `has_index_state` = `index.tree != base.tree`
- `has_untracked` = parent 2 exists **and** `untracked.tree` is non-empty
- `files_changed` = `|diff(base.tree, stash.tree)| + |entries(untracked.tree)|`

The non-empty requirement on `has_untracked` is not pedantry. Verified against
real Git: `git stash push -u -m … -- a.txt` in a tree that also holds an
unrelated untracked `u.txt` creates a **third parent with an empty tree** — `-u`
was requested, the pathspec excluded every untracked file, and Git records the
parent anyway. Treating parent-presence as "has untracked files" would put an
empty Untracked group in the inspector.

#### 1.5 Parsing `title` and `branch`

Git composes stash entry messages in exactly two shapes, in English, in
`builtin/stash.c`, independent of the user's locale:

```text
WIP on <branch>: <short-sha> <subject>     # git stash, no -m
On <branch>: <user message>                # git stash -m "<user message>"
```

Fjord matches those two prefixes literally and conservatively:

- `On <name>: ` → `branch = Some(name)`, `title` = the remainder.
- `WIP on <name>: ` → `branch = Some(name)`, `title` = the remainder.
- `<name>` equal to `(no branch)` → `branch = None`, prefix still stripped.
- Anything else → `branch = None`, `title = message`.

This is the **only** place in the feature where a Git string is parsed, it is
display-only, and no action consumes its result. `Create branch from stash` uses
`base` — an OID — precisely so that a wrong parse can never place a branch on the
wrong commit. A stash whose branch does not parse renders with the base commit's
short id in the secondary line instead of a branch name.

#### 1.6 Resolving an identity back to a position

Every mutation needs a `stash@{n}` at the moment it runs, and the only correct
`n` is the one that is true *then*.

```rust
/// Under the repository write lock, immediately before mutating: re-enumerate
/// `refs/stash` and find the entry whose commit OID is `id`.
fn resolve_stash(git: &git2::Repository, id: &StashId)
    -> Result<ResolvedStash, GitError>;

pub struct ResolvedStash {
    pub id: StashId,
    pub index: u32,       // fresh
    pub ref_name: String, // fresh, `stash@{index}`
}
```

Outcomes, all typed, all fail-closed:

| Situation | Result |
|---|---|
| Exactly one entry matches | Proceed with the freshly resolved `index`. |
| No entry matches | `GitError::StashNotFound` → `stash_not_found`. The entry was popped or dropped by someone else — Fjord refuses rather than acting on the index it was handed. |
| More than one entry matches | `GitError::StashAmbiguous` → `stash_ambiguous`. Possible only when the same commit was stored twice (`git stash store`); rare, and refusing is the only honest option. |

The re-resolution happens **inside** the write-locked section, not before it. A
resolution done outside the lock is a stale index with extra steps.

`stash@{n}` therefore appears in exactly three roles, and no others:

1. a value rendered in the UI;
2. a value the user can copy;
3. a value the backend constructs from a fresh resolution, microseconds before
   handing it to Git.

#### 1.7 Reads

Three read commands, all read-locked, all generation-enveloped against `stash`
(plus `history` where a commit is resolved):

| Command | Output |
|---|---|
| `get_stashes` | `StashEntry[]`, newest first, exactly Git's stack order. |
| `get_stash_files` | `StashFiles` — the three groups of §4.2. |
| `get_stash_file_diff` | `FileDiffWindow` for one file in one group (§4.4). |

`get_stashes` replaces the current two-field response. Order is Git's, never
re-sorted by Fjord: the stack order *is* information, and `stash@{0}` must be the
first row for the reference the user copies to mean anything.

### 2. Unified stash creation (`P10-STASH-02`)

#### 2.1 One contract

"Stash everything" and "stash this file" stop being two features:

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum StashScope {
    /// Every change in the repository.
    All,
    /// Exactly these repository-relative paths. One path is not a special
    /// case; it is a `Paths` of length one.
    Paths { paths: Vec<String> },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct CreateStashRequest {
    pub scope: StashScope,
    pub message: String,
    pub include_untracked: bool,
}
```

The scope is an explicit tagged enum. An empty `paths` vector is **not** a
spelling of `All` — it is rejected with `stash_scope_empty`. Fjord has no
"empty means everything" convention anywhere else, and inventing one here would
make an off-by-one in a selection handler silently stash the whole repository.

> `stage_files` / `unstage_files` do use "empty means all", which is exactly why
> this is stated rather than assumed. That convention exists on two commands that
> cannot lose work; stash creation removes changes from the working tree, so it
> gets the explicit enum instead.

`message` is required and non-empty. Every creation path already has one: the
dialog prefills it, and the automation callers pass their generated text.

##### The two scopes are two different contracts

This distinction is **normative**, and it is the reason `StashScope` is an enum
rather than an optional path list:

| Scope | Contract |
|---|---|
| `All` | *Snapshot everything applicable.* Conventional whole-repository stash semantics — Git's own — are correct and are what the user asked for. `include_untracked` has its ordinary repository-wide meaning. |
| `Paths { paths }` | *An exact semantic subset.* The entry the user creates represents **those paths and nothing else**, both in what leaves the working tree and in what a later Apply / Pop brings back. |

`Paths` is **not** merely "which files are removed from the current working
tree". It defines the **reusable contents** of the stash. The user-visible
promise made by the labels `Stash file…` and `Stash N files…` is:

> **"Stash N files" means those N files** — when this entry is applied or
> popped, later, possibly onto a different branch, exactly those paths are
> touched and no others.

Git's whole-tree stash storage format is an implementation detail of one possible
mechanism (§2.2). It is not the product contract, and §2.3 states the two
invariants that make the promise true.

#### 2.2 The engine

One implementation, one module: `crates/fjord-git/src/local/stash.rs` owns reads
and both creation scopes. The former `stash_file.rs` module and the production
`stash_push`/`stash_file` paths are gone; `Stash file…` is the N=1 case (§2.9).

`All` is settled, and is not the hard part:

```text
git stash push [-u] -m <message>
```

- Arguments are passed individually through the resolved `GitCommandFactory`.
  No shell string is ever constructed. Paths are repository-relative,
  canonicalized and containment-checked backend-side by the same
  `resolve_repository_file_path` authority `P10-WC-01` established, before any
  of them reaches Git's argument parser.
- Runs under the repository write lock.
- `git2`'s `stash_save2` is no longer used. `stash_push` was its only caller and
  the only place in the stash feature not already on system Git —
  `stash_and_checkout` and merge's `StashFirst` both run `git stash push` today.
  Consolidating on system Git gives one engine, and honors the user's `stash.*`
  configuration and hooks.

##### `Paths` is a construction problem, not a flag

The obvious mechanism —

```text
git stash push [-u] -m <message> -- <path>...
```

— is **not** adopted here as the final mechanism. It was the historical
`P10-WC-05` mechanism and satisfied exactly one of the
two invariants in §2.3. A pathspec-scoped `git stash push` bounds *what leaves
the working tree*; it does **not** bound *what the entry records*. Verified
against real Git, the resulting stash commit's index and worktree trees are whole
trees, so unrelated staged content is stored in the entry and is reapplied by a
later `git stash apply` (§4.3). That breaks the `Paths` contract of §2.1, which
is about the entry's reusable contents and not only about the current worktree.

The implemented construction uses private temporary indexes. Starting from
`HEAD`, it overlays only selected real-index entries to write the index tree,
then stages only selected tracked worktree state to write the stash tree. A
separate empty private index writes only selected eligible untracked paths.
`commit-tree` creates Git's ordinary base → index → worktree topology (plus the
optional third untracked parent). Every unrelated path equals `HEAD` in all
constructed trees, so it is absent from the stash's semantic diff.

The objects are complete before selected-path cleanup begins. At the mutation
boundary Fjord acquires the resolved real `index.lock` as an alternate index
transaction and prepares a verify-only `update-ref` transaction for the exact
captured `HEAD`. The complete raw index fingerprint, `HEAD`, selected tracked
worktree tree, and selected untracked tree are revalidated under those locks.
Cleanup writes the alternate index and only the selected worktree paths; standard
Git index/HEAD writers therefore serialize or fail on Git's own locks. A failure
before publication restores the selected index/worktree split directly from the
already-built stash parents while the same boundary is still held. Recovery
treats selected tracked worktree restoration, selected untracked restoration,
and original-index restoration/removal as independent steps: every safe step is
attempted even when an earlier one fails.

While `index.lock` remains present, Fjord atomically replaces the real index from
the cleaned alternate index and then publishes with one `git update-ref
--create-reflog -m … refs/stash <new> <expected-old>` compare-and-swap. The CAS
either changes `refs/stash` and appends its ordinary Git reflog entry together,
or changes neither; there is no `stash store` followed by a racy readback and no
compensating ref rewind that leaves a hidden reflog entry. If the CAS loses, the
captured raw index bytes and selected worktree state are restored while
`index.lock` still excludes conforming Git writers. If every recovery step
succeeds, Fjord returns the original publication error
(`stash_concurrent_update`). If any recovery step fails, structured diagnostics
retain both the primary operation failure and every recovery failure, while the
public result becomes `stash_recovery_failed`; the UI then tells the user to
review staged and working changes rather than claiming nothing was stashed. The
same recovery accounting applies to cleanup and real-index replacement failures.
After CAS success there is
no fallible operation left: dropping the transaction only releases the lock.
Generations advance only after the complete operation succeeds. RAII cleanup
removes the real index/HEAD locks, private index files, and sibling `.lock` files
on every exit path.

Whatever is chosen, the result must be an **ordinary Git stash**:

```text
git stash list
git stash show
git stash apply
git stash pop
```

must all work on a Fjord-created entry, from a terminal, with no Fjord present.
A Fjord-created stash stays indistinguishable from a hand-made one (§1.3).

Explicitly **not** acceptable, for the same reasons the rest of this document
gives:

- a proprietary Fjord stash database or side-car metadata file (§1.3);
- a patch file dressed up as a stash — `git stash list` would not show it;
- temporarily mutating unrelated working files, at any point, for any duration;
- "hide unrelated changes → stash → restore them" with no atomic boundary. That
  sequence fails destructively on interruption and is rejected here exactly as it
  was in `P10-WC-05`.

Removal of the selected paths from the working tree remains Git's own operation
under the repository write lock — the creation step must leave unrelated work
untouched at every intermediate point, not merely at the end.

##### Capability gate

Scoped creation is gated on Git ≥ 2.23 because selected-path cleanup uses
`git restore --source=HEAD --staged --worktree`. `All` is not gated. The global
`stash_paths_supported` query and the mutation itself both parse `git --version`
through the resolved `GitCommandFactory`.

#### 2.3 The two invariants

`Paths` creation must uphold **both** of the following. They are separate
properties, they fail separately, and satisfying one says nothing about the
other.

> **A — Worktree-removal invariant.** Creating the stash preserves the Git state
> of every unrelated file — staged entries, worktree contents, and untracked
> files alike — byte for byte.

This is `P10-WC-05`'s invariant, unchanged, now stated for *n* paths. It is about
what the user is looking at right now.

> **B — Stash-content invariant.** What a later `Apply` or `Pop` of that entry
> restores is confined to the selected paths. No unrelated path is present in the
> entry's semantic content, whether it was staged, unstaged, partially staged, or
> untracked at creation time.

This is about the entry as a **reusable object**, days later, possibly on another
branch. Stated as an assertion an implementation must be able to make:

```text
set(paths a Fjord-created `Paths` stash touches on apply)
    == set(paths the request semantically asked for)
```

The historical `P10-WC-05` implementation demonstrated **A** only. Its five
fixtures asserted unrelated files immediately after creation; none applied the
entry afterwards. Pathspec `git stash push` does not satisfy **B** (§4.3).

**Completed proof gate.** `P10-STASH-02` was allowed to ship only after the
fixtures in §Testing strategy proved both invariants, including the apply-side
regression, against real Git while preserving ordinary Git compatibility. That
gate passed. The historical failure rule was to leave `P10-STASH-02` open and
withhold `Stash N files…` rather than ship a scope that restored extra paths.

**Fail closed, never approximate.** If a selected state cannot be represented
exactly by the chosen construction, the request is refused with
`stash_scope_unrepresentable` naming the path, and nothing is created. An
approximate scoped stash is worse than none.

#### 2.4 Behavior per file state

For every selected path:

| State of the selected path | Behavior |
|---|---|
| Tracked, unstaged changes | Stashed; the path is reverted to its index state. |
| Tracked, staged changes | Stashed; the path is reset to `HEAD`. |
| Tracked, staged **and** unstaged | Both sides are captured in the one entry for that path; §4.2 keeps them distinguishable. |
| Untracked | Requires `include_untracked`; the file is moved out of the worktree into the entry. Without it the path is **excluded before the request is built** — see §2.4.1, which is the single owner of that rule. |
| Ignored | Never included. Fjord does not pass `--all`; there is no UI for it, and silently stashing ignored build output is not a behavior a user asks for. |
| Deleted (tracked, removed from the worktree) | Stashed as a deletion; the file is restored to its index/`HEAD` state. |
| Renamed | Git records a rename as a delete plus an add. Selecting only one of the two halves stashes only that half. The dialog does not attempt to pair them; the file list the user confirms is exactly the set of paths acted on. |
| Conflicted | **Refused** — see below. |
| Mixed set (several paths in different states above) | Each path behaves as its own row; there is no interaction between them. |

Conflicts fail closed, for both scopes, checked before the mutation through a
live `git2` status read (a stash-apply or squash conflict has no `MERGE_HEAD` to
key on — §6.5):

- `Paths` — if **any** selected path is conflicted, the whole request is refused
  with the existing `stash_file_conflicted { path }`, naming the first such path.
  Nothing partial is stashed. The shipped code and its five localized strings are
  reused rather than renamed; "This file has unresolved conflicts" is still the
  correct sentence for a multi-path refusal that names the offending path.
- `All` — refused with the same code and the first conflicted path when the index
  holds unmerged entries. Git would refuse anyway; refusing first gives a
  localized reason instead of a raw Git stderr string.

##### 2.4.1 What `include_untracked` means, per scope

The flag has a different meaning in each scope, and this is the single place that
says so:

| Scope | `include_untracked = true` | `include_untracked = false` |
|---|---|---|
| `All` | Conventional whole-repository meaning: every untracked, non-ignored file in the repository is included (`-u`). | Conventional: no untracked file is included. |
| `Paths` | **Selected** untracked paths may be included — and only those. It is never a licence to sweep in unrelated untracked files elsewhere in the repository; invariant **B** forbids that as firmly as it forbids unrelated staged content. | Selected untracked paths are **excluded from the operation** (below). |

For `Paths` with the flag off, the chosen behavior — one behavior, not a menu of
them — is **exclude, and say so before confirming**:

- The dialog computes the **effective** set: the selection minus its untracked
  members. That effective set is what the confirm button counts
  (`Stash 3 files…`, not `Stash 5 files…`), what the bounded file list shows, and
  what is sent as `StashScope::Paths { paths }`. The promise of §2.1 stays
  literally true, because *N* is what will actually be stashed.
- Excluded untracked paths are named in the dialog in one sentence
  (`stash.create.untrackedExcluded`), so nothing disappears from the count
  silently. Ticking **Include untracked files** moves them back into the
  effective set and the count updates in place.
- If the effective set is **empty** — every selected path was untracked — Confirm
  is disabled with that stated reason, exactly as it is for an empty selection or
  an unsupported Git. The backend does not rely on this: a request that reaches it
  with an empty `paths` is `stash_scope_empty`, and one whose paths all turn out to
  be untracked-and-excluded is `nothing_to_stash` (§2.5).

The effective-set rule is the dialog's, and the dialog is shared, so
`Stash file…`, `Stash N files…`, and the toolbar entry cannot drift apart on it.

#### 2.5 Nothing to stash

A scoped creation that matches no change must never be reported as success — a
"Stashed" notice with nothing stashed is worse than an error. Whatever mechanism
§2.2 settles on, success is confirmed the same way: after the mutation the
backend re-reads `refs/stash`, and if no new entry was created the result is the
existing `GitError::NothingToStash` → `nothing_to_stash`. (With the shipped
pathspec mechanism this is not hypothetical: `git stash push -- <paths>` that
matches nothing prints "No local changes to save" and exits **0**.)

#### 2.6 Result

```rust
/// The entry that was created, fully populated per §1.2, so the caller can
/// name it in a notice ("Stashed as \"Payment validation WIP\"") without a
/// second round trip and without assuming it is now `stash@{0}`.
pub struct CreateStashResult {
    pub entry: StashEntry,
    pub generations: GenerationSet,
}
```

#### 2.7 Names, and what a name is not

Every interactive creation collects a name. It is Git's stash message — nothing
more. There is no Fjord-side name store, no rename action, and no metadata file.

- The dialog prefills a sensible default and the user edits it freely.
- The default for `All` is the localized `stash.defaultMessage.all`; for `Paths`
  it names the path (one file) or the count (several), reusing today's
  `Fjord: stash <path>` shape.
- Automation stashes — `stash_and_checkout`, merge's and squash-merge's
  `StashFirst` — keep their existing generated source→target messages unchanged.
  They are distinguished from user stashes only by that message text. Fjord adds
  no hidden marker, no flag field, and no classification the user cannot read.
  A machine-readable "this stash is Fjord's" bit would be exactly the proprietary
  metadata §1.3 refuses.

#### 2.8 The dialog

One reusable dialog for all three scopes, built on the shared `TextActionDialog`
primitive in `CreateStashDialog.tsx`:

```text
┌─ Stash changes ─────────────────────────────────┐
│                                                 │
│  Name                                           │
│  [ Payment validation WIP                     ] │
│                                                 │
│  Scope                                          │
│   ( ) All changed files            (12)         │
│   (•) Selected files                (3)         │
│       PaymentService.cs                         │
│       PaymentValidator.cs                       │
│       notes.txt                                 │
│                                                 │
│  [x] Include untracked files                    │
│                                                 │
│                        [ Cancel ]  [ Stash ]    │
└─────────────────────────────────────────────────┘
```

- The scope radio is present only when the dialog was opened with paths. Opened
  from the toolbar it is a fixed `All`, and the group is omitted rather than
  shown with one disabled option.
- The selected-file list is bounded to five rows plus "and N more", matching the
  bounded-sample convention destructive preflights already use.
- `Stash file…` (one row) and `Stash N files…` (a multi-selection) open this same
  dialog preconfigured — they are not separate flows.
- The dialog states in one sentence that staged state is not preserved across a
  later plain Apply, and points at the "Restore staged state" option (§6.2).
  That sentence is `P10-WC-05`'s `stagedNotPreserved`, reused.
- The **Selected files** count and list are the *effective* set of §2.4.1: with
  **Include untracked files** unticked, selected untracked paths are removed from
  both, and one sentence names them. The count on the radio row and the count in
  the `Stash N files…` label that opened the dialog are therefore allowed to
  differ, and the dialog's is the one that is acted on.
- Confirm is disabled while the name is empty, while `Paths` is selected with an
  empty effective list, and while a `Paths` scope is unavailable on the resolved
  Git — with the stated reason, never a silently dead button.

#### 2.9 One implementation of interactive scoped stash

`P10-WC-05` shipped **file-scoped worktree removal** via Git's pathspec stash,
preserving unrelated current changes — invariant **A** of §2.3, proven by five
fixtures. It made no claim about invariant **B**, and none should be read into it.

`P10-STASH-02` upgraded and generalized that into a **first-class reusable scoped
stash whose stored and apply semantics are exact** — A *and* B, for *n* paths.

The consequence is stated plainly rather than left implied:

> `Stash file…` is now the one-path case of the exact engine:
> `StashScope::Paths { paths: [p] }`. The former `stash_file` command and its
> single-path module no longer exist.

There is **one** implementation of interactive scoped stash. Fjord does not have
an old one-file behavior and a new multi-file behavior whose entries apply
differently — two stashes created from the same menu, one file and four files,
obey the same exact contract. The historical `P10-WC-05` pathspec implementation
is still credited only with invariant A; invariant B belongs to the completed
`P10-STASH-02` engine.

### 3. Stashes in the repository tree (`P10-STASH-03`)

`RepoTree.tsx` gains a fourth section. Its `SectionKey` becomes
`"local" | "remote" | "tags" | "stashes"`, and it consumes `useStashes` beside
`useBranches` / `useTags`.

```text
  Branches
    Local                    4
    Remote                   7
  Tags                       2
  Stashes                    3
    ◈ Payment validation WIP
      develop · stash@{0}
    ◈ Refactor API before experiment
      develop · stash@{1}
    ◈ Fix tests
      a84c120 · stash@{2}
```

- **Stashes are their own section**, after Tags, never merged into branches or
  tags. A stash is not a ref of the same semantic kind: it cannot be checked out,
  pushed, or merged, and putting it in a ref list would invite exactly those
  gestures. Its rows carry a distinct leading glyph, and the section is collapsed
  by default, like Remote and Tags.
- The section header shows the exact count. Zero stashes renders the section
  header with an empty state, not a hidden section — "you have no stashes" is
  information.
- **Order is Git's stack order**, top first. Never re-sorted.
- Primary line: `title` (§1.5). Secondary line: `branch` when it parsed, else the
  short `base` id — then a separator and `ref_name`.
- Relative time is shown only where the row is wide enough, rendered through the
  existing locale-aware formatter and never as a hand-rolled string. `created_at`
  is always available (§1.3), so the display is a layout decision, not a data
  one; where the row is too narrow for branch, reference, and time, time is the
  first thing dropped.
- The existing section filter box applies to stash `title` and `message` exactly
  as it applies to branch and tag names, and the section's matched/total counts
  join the existing header counts.
- Selecting a row opens the Stash Inspector (§4).
- Right-click, `Shift+F10`, and the Context Menu key open the shared stash menu
  (§6) — the same keyboard parity branch and tag rows already have, with the same
  focus restoration on close.
- Arrow-key navigation, roving tabindex, and the fixed row height / virtualized
  body are the section component's existing behavior, inherited unchanged.

### 4. Stash Inspector (`P10-STASH-04`)

#### 4.1 Shape

The inspector occupies the same slot and follows the same composition as
`CommitInspector.tsx` — metadata header, then a file list that scrolls
internally, then the shared diff view — and reuses `FileEntryList`,
`FileViewTabs`, `FileTreeControls`, and `useFileTreeCollapse` rather than
introducing a second file list.

```text
┌─────────────────────────────────────────────┐
│ Payment validation WIP                      │
│ stash@{2} · created from develop            │
│ Base a84c120 · 12 Aug 2026, 14:05           │
│ 4 files · +128 −37                          │
│                                             │
│ [ Apply ]  [ Pop… ]              [ ⋯ ]      │
├─────────────────────────────────────────────┤
│ Staged changes                              │
│   M  PaymentValidator.cs                    │
│ Working changes                             │
│   M  PaymentService.cs                      │
│ Untracked                                   │
│   A  notes.txt                              │
└─────────────────────────────────────────────┘
```

- The `⋯` menu is the same shared menu as the tree row's and the graph marker's
  (§6). `Apply` and `Pop…` are promoted out of it because they are the two
  actions the inspector exists for.
- The header states in one sentence what a plain Apply does: it reapplies
  everything as **unstaged** changes unless "Restore staged state" is used. This
  is the one place a user is most likely to be surprised, so it is written where
  they are looking.

#### 4.2 File groups

Groups are derived from the parent trees of §1.4 — not from one flattened
`git stash show`:

| Group | Diff |
|---|---|
| **Staged changes** | `base.tree` → `index.tree` |
| **Working changes** | `index.tree` → `stash.tree` |
| **Untracked** | empty tree → `untracked.tree` (all additions) |

This is exactly Git's own model, so a path that was both staged and further
modified appears in both groups — the same way a partially staged file appears in
both lists in Working Changes
([`working-tree-and-diff.md`](working-tree-and-diff.md) §"Current state").
Consistency here is deliberate: the stash inspector shows the same three-way
state the Working Changes panel shows, frozen.

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum StashFileGroup { Index, Worktree, Untracked }

pub struct StashFiles {
    pub staged: Vec<FileDiff>,
    pub worktree: Vec<FileDiff>,
    pub untracked: Vec<FileDiff>,
    pub truncated: bool,
}
```

An empty group is omitted from the UI entirely; it is not rendered as an empty
heading.

The split is reconstructible from the repository with certainty, so **v1 ships
it**. There is no honest-but-smaller fallback worth designing: if a future Git
version changed the parent structure, the correct response would be to fail the
read, not to flatten the groups and hope.

#### 4.3 The inspector is authoritative, and what that means for each origin

**The one rule.** The inspector's file list, and `files_changed` with it, is
always the **true** content of the entry as recorded — the base-to-stash tree
diff plus the untracked tree, derived per §4.2. It is never a remembered
selection, never a filter applied for presentation, and never narrower than what
Apply will do. What the user reads before applying is what gets applied.

That rule is constant. What differs is what the entry *contains* in the first
place, and there are exactly two origins:

**Fjord-created `Paths` stash.** Invariant **B** of §2.3 makes the entry's
content the selected paths and nothing else. The inspector therefore shows
exactly the semantic contents of the selected scope; no unrelated,
selection-external path appears in it — not because the list was filtered, but
because the entry does not contain one. The list and the promise agree because
creation made them agree, which is the whole point of §2.2 being a construction
problem.

**Externally-created stash.** Fjord stays honest. A stash made by `git stash` in
a terminal — including a pathspec-scoped one — may hold any valid stash
structure, and the inspector displays the authoritative contents derived from the
stash commit's trees, whatever they are. In particular, verified against real
Git: with `a.txt` both staged and further modified and an unrelated `b.txt`
staged, `git stash push -u -m "only a" -- a.txt` leaves `b.txt` staged in the
working tree (invariant **A** holds) but records `b.txt`'s staged content **in
the entry**; `git stash show` lists it, and applying that entry onto a clean tree
brings `b.txt`'s change back. Fjord shows `b.txt` in the inspector for such an
entry, because Apply will touch it.

**Fjord does not try to know an external stash's original pathspec.** Git does
not persist it — there is nothing to read — so any attempt to reconstruct "what
the user originally meant" would be a guess rendered as fact. The distinction
Fjord draws is therefore never "who made this stash"; it is simply that a
correctly created Fjord scoped stash has nothing unrelated in it to show. No flag
or marker distinguishes the two origins (§1.3, §2.7), and none is needed.

#### 4.4 Diff

Selecting a file opens the existing `FileDiffView` through the existing bounded
diff pipeline. A new backend read supplies the window:

```text
get_stash_file_diff { repo_id, stash_id, group, path, offset, limit,
                      whitespace, load_anyway } -> FileDiffWindow
```

- Same `FileDiffWindow` shape, same 2,000-line and 2 MB response ceilings, same
  10 MB source-file display ceiling with explicit override, same generation
  envelope, same whitespace modes, same syntax highlighting and split/unified
  toggle. No second diff renderer, no unbounded path.
- The diff is computed between the two trees the group names, so no working-tree
  state is read and nothing is written. Every stash read is non-destructive and
  takes the repository **read** lock.
- Partial staging actions are **not** offered on a stash diff. There is no
  `PatchSource` for "inside a stash", the patch model is defined against the
  index and the worktree, and inventing a fourth source to support partial stash
  application is out of scope. The diff is read-only.
- Query keys are `stashes`-scoped so a pop or drop invalidates the open diff
  along with the list (§8).

### 5. Stashes in the commit graph (`P10-STASH-05`)

#### 5.1 A marker, not a lane

Git implements a stash with commits, and those commits have parents. Rendering
them as history would put a two- or three-parent merge-shaped commit into the
graph for every stash, with edges to a tree snapshot the user never made and
cannot check out. That is Git's storage format leaking into a product surface.

Fjord renders a **marker attached to the stash's base commit**, and never the
stash's own commits:

```text
   ● develop  HEAD
   │
   ● commit C
   │
   ● commit B    ◈ Payment validation WIP   ◈ Fix tests
   │
   ● commit A
```

The marker sits in the ref-badge row of the base commit, alongside branch and tag
badges, but is visually distinct from them: a different glyph, a different badge
treatment, and — per [`ui-shell.md`](ui-shell.md) §7 — a text label, never colour
alone. It is not a lane, has no edges, and never changes the graph's topology,
column assignment, or row heights.

#### 5.2 Derivation and virtualization

- The overlay is a join between the already-loaded `useStashes` result and the
  already-loaded commit pages. It **never** forces the graph to load more
  history: a stash whose base is not in a loaded page contributes no marker yet.
- Markers are keyed by `StashId`, not by row index, list position, or DOM node,
  so virtualized recycling cannot hand a menu the wrong entry. This is the same
  identity discipline `P10-WC-01` established for virtualized file rows.
- When a stash's base commit is not currently loaded, the graph does **not**
  distort its layout, insert a placeholder row, or silently drop the stash. The
  stash stays fully usable from the tree and the inspector, and the tree row
  gains a **Reveal in graph** action that reuses the shipped
  `useCommitLog.loadUntilCommit` seek — the same mechanism the branch-seek
  affordance already uses — then selects the marker once its page arrives. If the
  seek exhausts history without finding the base commit (it was pruned, or lives
  on an unreferenced line), the action reports that plainly and changes nothing.

#### 5.3 Several stashes on one base

Each stash renders its **own** selectable marker. Identity is never collapsed:

- Up to the badge row's existing overflow threshold, markers render inline.
- Beyond it, they collapse into the existing ref-badge flyout — which lists each
  stash individually, each one selectable and right-clickable with its own exact
  `StashId`. There is never a generic "3 stashes" entry whose menu acts on an
  unspecified one.

#### 5.4 Interaction

Selecting a marker opens the Stash Inspector for that exact entry. Right-click,
`Shift+F10`, and the Context Menu key open the shared stash menu (§6) — matching
the keyboard behavior `RefBadge` already implements for branch and tag badges.

### 6. Stash actions (`P10-STASH-06`)

#### 6.1 One menu, three entry points

```text
Apply stash
Pop stash…
──────────────────────────────
Create branch from stash…
──────────────────────────────
Copy stash reference          stash@{2}
Copy stash SHA                1306d0b…
Copy base commit SHA          a84c120…
──────────────────────────────
Reveal in graph               (tree and inspector only)
──────────────────────────────
Drop stash…
```

The RepoTree section, the CommitGraph marker, and the Stash Inspector build this
list from **one** shared item builder and dispatch through **one** shared
application hook — the way `P10-WC-01` did for working files and `P10-MERGE-01`
did for merge entry points. Three menus that drift apart is exactly the failure
this structure prevents.

Every entry carries the `StashId`. None carries an index.

#### 6.2 Apply

```text
apply_stash { repo_id, stash_id, restore_index } -> StashApplyResult
```

- Applies the selected stash to the **currently checked-out** branch and
  worktree. It does not check out the stash's original branch, and it does not
  ask Git to; the user applies where they are.
- Works for **any** entry, not only the top of the stack.
- Keeps the entry. Apply is the non-consuming action, which is why it is not
  destructive and does not open a preflight.
- Re-resolves `stash_id` → current `stash@{n}` under the write lock (§1.6)
  immediately before running `git stash apply [--index] stash@{n}`.
- `restore_index` maps to Git's `--index`. It is offered as a **Restore staged
  state** checkbox where the entry has index state to restore (`has_index_state`)
  and disabled with a stated reason where it does not. Git refuses `--index` when
  it cannot reinstate the index; that refusal surfaces as
  `stash_apply_index_refused` and is never silently retried without the flag —
  quietly downgrading to an unstaged apply would be Fjord deciding for the user
  that the staged/unstaged split did not matter.

Behavior against the current working tree, stated exactly:

| Current state | Behavior |
|---|---|
| Clean tree | Applies. |
| Dirty, no overlap with the stash's paths | Applies. Unrelated local work is untouched. |
| Dirty, overlapping paths that Git can merge | Applies, merging. |
| Dirty, overlapping paths Git would overwrite | Git refuses before writing anything (`error: Your local changes … would be overwritten`). Fjord surfaces it as `stash_apply_would_overwrite` with the bounded path list and offers **Cancel** only. It does **not** offer to stash the current work first, does not autostash, and does not discard. |
| Applies with conflicts | A typed conflict outcome — see §6.5. |
| Another Git operation in progress | Blocked with the existing reason, like every other action Git would refuse anyway ([`repository-safety.md`](repository-safety.md) §2). |

Under no circumstance does Apply discard, stash, or overwrite current local work
implicitly.

#### 6.3 Pop

```text
Pop = Apply, and remove the entry only if the apply succeeded.
```

Pop is routed through the shared destructive contract, because it can consume the
entry:

```rust
DestructiveAction::StashPop { id: StashId, restore_index: bool }
```

- The existing `StashPop { index: u32 }` variant is **replaced** by this one, not
  duplicated. The index-keyed variant is the identity bug of §1.1 encoded in the
  action enum; leaving both would leave a way to reintroduce it.
- `Consequence::StashEntryConsumed` changes from `{ index, message }` to
  `{ id, ref_name, title, files_changed, base }`, so the dialog can name the
  entry rather than a slot number.
- Works for any entry.
- The executor's existing `stash pop stash@{index}` command construction is kept;
  the index it interpolates now comes from a §1.6 re-resolution performed under
  the write lock after the confirmation token is consumed, not from the frontend.
- Recoverability: `NotRecoverable` (§6.4's reasoning applies equally — a popped
  entry is gone from the stack).

Preflight text is explicit about the conditional consumption:

```text
Pop stash

  Apply "Payment validation WIP" to develop, then remove it from the stash.

  · 4 files will be changed
  · Created from develop at a84c120
  · The stash entry is removed only if the apply succeeds.

  Not recoverable — once removed, a stash entry is not stored anywhere else.

                                   [ Cancel ]  [ Pop stash ]
```

**A failed or conflicted pop does not drop the entry.** This is Git's own
behavior, verified: a conflicting `git stash pop` exits 1, leaves the conflicted
result in the worktree, keeps the entry, and says so. Fjord reports the same
thing and does not "finish the job" by dropping it.

#### 6.4 Drop

```rust
DestructiveAction::StashDrop { id: StashId }
```

- New action on the **existing** enum, the existing
  `preflight_destructive_action` → one-use token → `execute_destructive_action`
  path, and the existing shared dialog. It gets no private command, for the same
  reason `P10-WC-04`'s file deletion did not: a destructive action that bypasses
  the preflight would be the first, and there must not be a first.
- Executes `git stash drop stash@{n}` with `n` from a §1.6 re-resolution under
  the write lock.
- Consequences are bounded and concrete: the stash's `title`, its current
  `ref_name`, `files_changed`, and its base branch/commit.
- Recoverability: **`NotRecoverable`**, unconditionally.

On that last point, deliberately: dropping a stash leaves its commit dangling in
the object database, and `git fsck` can sometimes find it. Fjord does not label
that *Reflog* or *Stash*. `refs/stash`'s reflog entry is removed by the drop, the
objects become unreferenced, and `git gc` — which runs automatically — may remove
them at any time. A recoverability label is contractual in this codebase
([`repository-safety.md`](repository-safety.md) §3): an action labeled
recoverable must actually be recoverable, and that is asserted in tests. "Usually
recoverable for a while" is not a label Fjord offers.

#### 6.5 Conflicts from apply and pop

Verified against real Git: a conflicting `git stash apply`/`pop` writes unmerged
index entries (`UU`), writes **no** `MERGE_HEAD`, and creates only an
`AUTO_MERGE` ref, which `operation_state::detect` does not key on. So
`RepoOperationState` correctly stays `Normal`, and treating a stash conflict as a
sequencer operation would be wrong — there is nothing to `--continue` or
`--abort`.

This is precisely the shape `P10-MERGE-03` already established for squash-merge
conflicts, and it gets the same treatment rather than a new one:

```rust
pub enum StashApplyOutcome {
    Applied,
    Conflicted { paths: Vec<String> },
}

pub struct StashApplyResult {
    pub outcome: StashApplyOutcome,
    /// Pop only: whether the entry was actually removed. Always false for a
    /// conflicted outcome.
    pub entry_removed: bool,
    pub generations: GenerationSet,
}
```

- The conflicted path list is read live from the index after the command — the
  same `conflict_paths` / `fresh_index` primitive squash merge uses. Git's exit
  code alone is not the classifier: exit 1 means "did not complete cleanly", not
  "did nothing".
- Conflicted files need no new UI. Working Changes has always read conflict state
  live and independently of operation state, and its file rows already expose
  `Open merge tool`.
- The operation banner is **not** shown, because there is no operation. The
  result is reported as a notice naming the conflicted files, and — for Pop —
  stating plainly that the entry was kept.

#### 6.6 Create branch from stash

```text
create_branch_from_stash { repo_id, stash_id, name, apply, keep }
    -> CreateBranchFromStashResult
```

Semantics, in order:

1. Create a new local branch at the stash's **original base commit** (`base`).
2. Check it out.
3. Apply the selected stash.
4. **Keep** the stash.

Step 4 is where Fjord deliberately diverges from `git stash branch`, which drops
the entry on a successful apply. A command whose safe-looking name silently
consumes the user's saved work is not a default Fjord adopts. Instead, on a
successful apply, the completion notice offers a separate, explicit **Drop
stash** — which goes through §6.4's preflight like any other drop.

```text
┌─ Create branch from stash ──────────────────────┐
│                                                 │
│  Branch name                                    │
│  [ feature/payment-validation                 ] │
│                                                 │
│  Base:  a84c120  Add payment endpoint           │
│                                                 │
│  [x] Apply stash after checkout                 │
│                                                 │
│  The stash is kept. You can drop it afterwards. │
│                                                 │
│                       [ Cancel ]  [ Create ]    │
└─────────────────────────────────────────────────┘
```

- Branch-name validation is the shipped validation from the existing
  create-branch flow. No second validator.
- Checkout safety is the shipped `checkout_branch` contract
  ([`repository-safety.md`](repository-safety.md) §4): if local changes would be
  overwritten, the checkout returns `checkout_would_overwrite` with its bounded
  path list, and the flow stops there with Cancel. Fjord does **not** silently
  stash the current work to make room, and does not offer stash-and-checkout
  inside this flow — the user can stash explicitly and try again.
- Failure is staged and honest. If the branch is created and checked out but the
  apply conflicts, the result says so: the branch exists, you are on it, the
  conflicts are these, and the stash was kept. Nothing is rolled back, because
  rolling back a checkout the user can already see is more surprising than
  reporting it.
- `keep` exists in the contract and is `true`; it is not surfaced as a checkbox
  in v1. One option is enough for a dialog whose safe answer is fixed.

#### 6.7 Copy

Three non-destructive clipboard actions, each copying a value that is accurate at
the moment it is copied:

| Action | Value |
|---|---|
| Copy stash reference | `stash@{2}` — the current position. Useful for pasting into a terminal *now*; the menu label carries no promise beyond that. |
| Copy stash SHA | The full stash commit OID. Stable forever, and what `git stash show <sha>` accepts. |
| Copy base commit SHA | The full base commit OID. |

No "copy stash message" entry: the message is already selectable text in the
inspector, and a menu entry per visible string is menu bloat.

### 7. Where multi-file selection lives

`Stash N files…` needs a way to *select* several files, and an earlier draft of
this spec owned that selection model as `P10-STASH-07`. It no longer does.

Multi-selection is **Working Changes infrastructure**, not stash infrastructure:
the same selection feeds batch Stage, batch Unstage, batch Discard, and
multi-file patch export, and only one of its five consumers is stash. Owning it
here would have made every other batch action depend on the stash spec, which is
backwards. It is therefore defined once in
[`working-tree-and-diff.md`](working-tree-and-diff.md) §7
(`P10-WC-MULTI-01`–`P10-WC-MULTI-03`), which owns the gestures, the
source-homogeneous rule, right-click behavior, `Ctrl+A`, selection survival,
virtualization, and accessibility.

`P10-STASH-07` was drafted and then **withdrawn before implementation**, rather
than renumbered; its scope moved to `P10-WC-MULTI-01`–`P10-WC-MULTI-03`. No work
is lost and nothing else shifts. It is a historical note here, not an active
roadmap task, and it is not resurrected anywhere. What this spec keeps is the half that is genuinely stash:

- the `StashScope::Paths { paths }` contract that a multi-file selection is
  passed to (§2.1);
- the scoped-creation engine and its two invariants (§2.2–§2.3);
- the per-file-state behavior table (§2.4);
- the shared naming dialog, which the `Stash N files…` entry point opens
  preconfigured (§2.8).

The dependency runs one way and is worth stating plainly: the
`Stash N files…` **menu entry** ships in `P10-WC-MULTI-02`, and it can only ship
after `P10-STASH-02` has delivered exact-scope creation for *n* paths **and
passed its §2.3 proof gate**. Selection without that backend would be a menu
entry that cannot execute — or, worse, one that executes and restores more than
it named. The scoped backend without selection is still fully useful on its own,
since a one-path `Paths` scope is what `Stash file…` becomes (§2.9).

### 8. Generations and invalidation

The existing model ([`performance.md`](performance.md) §5) is correct and is
extended, not replaced. Each stash mutation bumps exactly what it changes:

| Mutation | `working_tree` | `refs` | `history` | `stash` | Note |
|---|:---:|:---:|:---:|:---:|---|
| `CreateStash` (`All` or `Paths`) | ✅ | | | ✅ | Reuses `MutationKind::StashPush` and its `WORKING_STASH` mask unchanged. No ref moves; no commit becomes reachable. |
| `StashApply` | ✅ | | | | **New mask: `WORKING_TREE` only.** Apply does not change the stack. |
| `StashPop` | ✅ | | | ✅ | Existing `WORKING_STASH`. |
| `StashDrop` | | | | ✅ | **New mask: stash only.** Dropping touches no file. |
| `CreateBranchFromStash` | ✅ | ✅ | ✅ | | Composes the existing `CreateBranchAt { checkout: true }` mask with the apply. `stash` is bumped only if the user also drops afterwards, which is a separate action with its own bump. |

Two of these are new masks, and both exist because the blanket alternative is
wrong: bumping `refs` and `history` on a drop would invalidate the branch list
and the entire commit log because a stash entry disappeared.

Frontend query scoping mirrors it exactly. `invalidateRepoData`'s `stashes` scope
gains the stash detail keys, so a pop invalidates the open inspector along with
the list:

```ts
stashes:       (repoId)          => [...detail(repoId), "stashes"],
stashFiles:    (repoId, stashId) => [...stashes(repoId), stashId, "files"],
stashFileDiff: (repoId, stashId, group, path)
                                 => [...stashes(repoId), stashId, "diff", group, path],
```

| Action | Invalidated scopes |
|---|---|
| Create stash | `status`, `working`, `stashes` |
| Apply | `status`, `working` |
| Pop | `status`, `working`, `stashes` |
| Drop | `stashes` |
| Create branch from stash | `status`, `working`, `refs`, `history`, `stashes` |

Graph markers update on all of create / pop / drop with no restart and no
repository reopen, because they are derived from the same `useStashes` query the
tree reads — one invalidation updates the tree section, the graph overlay, the
toolbar badge, and the inspector together.

The watcher path is already correct and unchanged: `RepoChangeSet.stashes` →
`stash`, so a `git stash` run in a terminal appears in Fjord's tree without any
Fjord action at all.

### 9. IPC surface

Recorded normatively in [`ipc-commands.md`](ipc-commands.md); listed here as an
index only.

| Command | Kind | Task |
|---|---|---|
| `get_stashes` | read (replaces the two-field response) | `P10-STASH-01` |
| `get_stash_files` | read | `P10-STASH-04` |
| `get_stash_file_diff` | read | `P10-STASH-04` |
| `stash_paths_supported` | read, global (replaces `stash_file_supported`) | `P10-STASH-02` |
| `create_stash` | mutation (replaces `stash_push` and `stash_file`) | `P10-STASH-02` |
| `apply_stash` | mutation | `P10-STASH-06` |
| `create_branch_from_stash` | mutation | `P10-STASH-06` |
| `preflight_destructive_action` / `execute_destructive_action` | existing, extended with `StashPop { id, restore_index }` and `StashDrop { id }` | `P10-STASH-06` |

Pop gains no command, because it never had one: `P9-10` already removed the
per-action destructive IPC aliases, and pop has run through
`execute_destructive_action` ever since. What `P10-STASH-06` removes is the dead
`GitBackend::stash_pop` port method and its `git2` implementation — index-0-only,
test-only, and the source of the "pops `stash@{0}` only" claim in
[`repository-safety.md`](repository-safety.md). Deleting it leaves exactly one
pop implementation, the system-Git one the executor already uses.

Stash mutations are **not** operation-pipeline operations: they are short, local,
and produce no countable progress, so none of them takes an `operation_id` and
none emits `fjord-operation-progress`
([`operation-events.md`](operation-events.md)).

### 10. Error codes

New stable codes, spelled here so no task invents a variant:

- `stash_not_found` — the selected `StashId` is no longer in the stack (§1.6).
- `stash_ambiguous` — the same commit appears twice in the stack (§1.6).
- `stash_scope_empty` — `Paths` with no paths (§2.1).
- `stash_concurrent_update` — the captured index, `HEAD`, selected worktree
  state, or expected previous `refs/stash` changed before the exact-scope
  transaction could publish; cleanup is rolled back and no Fjord reflog entry is
  created.
- `stash_recovery_failed` — stash creation failed and one or more independent
  recovery steps could not fully restore captured repository state. Diagnostics
  retain the primary and recovery causes; the user must review staged and working
  changes before continuing. This message never claims that nothing was stashed.
- `stash_scope_unrepresentable` — a selected path's state cannot be recorded
  exactly by the scoped-creation construction, so nothing is created rather than
  something approximate (§2.3). Carries the requested semantic target that
  expanded to the offending Git entry in `AppError.paths`, not an arbitrary
  selected path or merely the first expanded entry.
- `stash_apply_would_overwrite` — Git refused before writing; carries the bounded
  path list in `AppError.paths` (§6.2).
- `stash_apply_index_refused` — `--index` could not reinstate the index (§6.2).
- `stash_apply_failed` — Git failed for a reason that is neither a conflict nor
  one of the above.

Reused unchanged: `nothing_to_stash`, `stash_file_conflicted`,
`stash_file_unsupported_git`, `preflight_stale`, `operation_already_in_progress`,
`checkout_would_overwrite`, `path_outside_repository`, `path_not_found`.

`stash_empty` becomes unreachable once the dead `GitBackend::stash_pop` is
deleted and every action names an entry by id; it is retired with that method.

A conflicted apply or pop is **not** an error. It is
`StashApplyOutcome::Conflicted`, exactly as a conflicted merge is a typed result
and not an error ([`branch-merge.md`](branch-merge.md) §6).

## Alternatives considered

**Keep `index` as the action key and just refresh often.** Rejected. There is no
refresh rate that closes the window: the watcher event and the user's click race
by construction, and the failure mode is silent — the wrong stash is popped and
the UI reports success. Identity has to be immutable, or every mitigation is a
narrower race.

**Persist stash names/metadata in SQLite.** Rejected. It creates a second source
of truth that a terminal `git stash drop` immediately falsifies, orphans rows
forever, and makes Fjord-created stashes behave differently from everyone else's.
Git's message field already holds a name; using it means a Fjord stash is a
normal stash.

**Render stash commits as graph history.** Rejected — §5.1. It exposes an
implementation detail as a product surface and puts uncheckoutable commits in a
list whose entire contract is that its entries are checkoutable.

**Implement multi-file stash by hiding unrelated changes, stashing, restoring.**
Rejected — §2.3, inherited from `P10-WC-05`. No atomic boundary; destructive on
interruption.

**Filter the inspector's file list down to the pathspec the stash was created
with.** Rejected — §4.3. It would show the user a list Apply does not honor, and
Fjord cannot even know the original pathspec: Git does not record it. The fix for
Fjord-created scoped stashes is to make the *entry* exact at creation time
(§2.2), never to make the *view* look exact over an entry that is not.

**Accept pathspec `git stash push`'s whole-tree recording as the product
contract for `Paths`, and explain it in the UI.** Rejected. An earlier draft of
this spec did exactly that. It makes `Stash 4 files` a label that can restore a
fifth file, and no amount of explanatory text in an inspector fixes a name that
is wrong. Git's storage format is an implementation detail of one candidate
mechanism; §2.1 makes the subset contract normative and §2.2 makes producing it a
solvable construction problem instead.

**Ship `Stash N files…` on the pathspec mechanism now and tighten the semantics
later.** Rejected — §2.3's proof gate. Users would create entries under one
promise and apply them under another, and the entries outlive the release that
made them. A smaller safe product is better than a misleading one.

**Use `git stash branch` for "Create branch from stash".** Rejected — §6.6. It
drops the stash on success, and a destructive side effect inside a
constructive-sounding action is exactly the pattern this codebase's safety model
exists to prevent.

**Label Drop as reflog-recoverable.** Rejected — §6.4. `git gc` can remove the
dangling objects at any time, and recoverability labels are contractual.

**Owning the Working Changes selection model here.** Rejected — §7. The same
selection feeds Stage, Unstage, Discard, and patch export as well as stash;
owning it in the stash spec would have made four unrelated batch actions depend
on this document. It moved to
[`working-tree-and-diff.md`](working-tree-and-diff.md) §7, and `P10-STASH-07` was
withdrawn rather than left as a second claim on the same implementation.

## Performance considerations

- `get_stashes` is O(stack size), and a stash stack is small by nature. Each
  entry costs one commit lookup plus up to three tree comparisons for
  `files_changed` / `has_index_state` / `has_untracked`. It is cached in the
  repository runtime against the `stash` generation, like every other repository
  read ([`performance.md`](performance.md) §5), so the tree section, the graph
  overlay, the toolbar badge, and the inspector share **one** read.
- Stashes stay part of the warmed repository set rather than becoming a lazy
  fetch on section expand: the toolbar badge and the graph overlay both need the
  list before the user opens anything.
- `files_changed` is a tree-only diff — no blob contents are loaded. Where a
  stash's diff exceeds the bounded ceiling, `StashFiles.truncated` is set and the
  UI says so, the same way oversized commit diffs already behave.
- The graph overlay is a `Map<CommitId, StashEntry[]>` built once per stash-list
  change and read per rendered row. It adds no per-row Git work, no additional
  history pages, and no change to row height or column layout — so the
  virtualizer's measurements are untouched.
- Stash reads take the repository **read** lock and never block a mutation any
  longer than the existing reads do.

## Security / safety

Every rule below is an existing rule, applied to stash:

- **No arbitrary command strings.** Every invocation is an argument vector
  through the resolved `GitCommandFactory`. No shell string is constructed
  anywhere in the feature.
- **No caller-supplied authority.** Paths are repository-relative, canonicalized
  and containment-checked backend-side. Stash references are constructed by the
  backend from a fresh resolution; a `stash@{n}` sent from the frontend would be
  ignored, and no command accepts one.
- **No stale identity.** Every mutation re-resolves `StashId` → position inside
  the write-locked section and fails closed on `stash_not_found` /
  `stash_ambiguous`.
- **No unconfirmed destruction.** Pop and Drop go through
  `preflight_destructive_action` → one-use, scope-bound, two-minute token →
  `execute_destructive_action`. Neither gets a private command. A forged or
  replayed token is an atomic no-op, as `P9-10`'s regression suite already
  asserts for every action in the enum.
- **No implicit autostash and no implicit discard.** Apply, Pop, and Create
  branch from stash all refuse rather than move the user's current work. The
  no-autostash rule of [`branch-merge.md`](branch-merge.md) §4 and
  [`repository-safety.md`](repository-safety.md) §4 is repository-wide, and this
  feature does not carve an exception into it.
- **No optimistic conflict assumptions.** Apply and pop can conflict; both
  outcomes are typed, both are reported, and a conflicted pop never drops.
- **Honest recoverability.** Drop is `NotRecoverable`. Pop is `NotRecoverable`.
  Neither claims the reflog.

## Testing strategy

### Backend (`fjord-git` integration, real Git fixtures)

Stash structure is the subject, so these use real repositories built by the Git
CLI, not synthetic objects.

1. **List with stable identity** — three stashes; each `StashEntry.id` is the
   stash commit OID, and all three differ.
2. **Insertion renumbers positions, not identities** — capture ids and indexes,
   create a fourth stash, re-read: every original `id` is unchanged, every
   `index` and `ref_name` shifted by one.
3. **Dropping an earlier entry re-indexes without mis-targeting** — drop
   `stash@{1}` by id, then act on a previously-`stash@{2}` id and assert the
   action hit that exact entry.
4. **Stash all with a custom message** — the created entry's `message` and
   `title` are the user's text; the worktree is clean afterwards.
5. **Stash one path** — the `P10-WC-05` fixtures, re-run against the new engine,
   unchanged in expectation for invariant **A**, and additionally carried through
   cases 28–31 for invariant **B**. A one-path `Paths` is not a weaker contract
   than a four-path one (§2.9).
6. **Stash several paths (invariant A)** — the **canonical scoped fixture**,
   which cases 6–7 and 28–31 all share:

   | Path | Selected | State |
   |---|:---:|---|
   | `a.txt` | ✅ | tracked, unstaged change |
   | `b.txt` | ❌ | tracked, **staged** change |
   | `c.txt` | ✅ | tracked, **partially staged** (staged change plus a further worktree change) |
   | `d.txt` | ❌ | tracked, unstaged change |
   | `u1.txt` | ✅ | untracked |
   | `u2.txt` | ❌ | untracked |

   Request: `StashScope::Paths { paths: [a.txt, c.txt, u1.txt] }`,
   `include_untracked: true`. After creation, `a`/`c`/`u1` have left the working
   tree per §2.4's table, and the entry exists.
7. **Unrelated state preserved (invariant A)** — for the fixture in (6) and for
   the one-path case in (5): `b.txt`, `d.txt`, and `u2.txt` are byte-for-byte
   identical before and after — **index entry and worktree content both
   asserted**, so an unrelated *staged* entry is proven preserved as a staged
   entry and not merely as file bytes. The whole unrelated index is compared for
   Git-state equivalence, not just the sampled paths.
8. **Mixed selected states** — one unstaged, one staged, one both-sided, one
   deleted, one untracked, in a single request; each behaves per §2.4's table.
9. **Untracked selected paths, per §2.4.1** — with `include_untracked: true`,
   `u1.txt` is in the entry and `u2.txt` is not (an untracked path is included
   because it was *selected*, never because the flag was set). With it off, the
   backend receives an effective set that excludes `u1.txt` and `u1.txt` is left
   untouched in the worktree; a request whose entire effective set is empty
   returns `nothing_to_stash`, and `Paths { paths: [] }` returns
   `stash_scope_empty` (case 11).
10. **Conflicted path refused** — a conflicted path in a `Paths` request and an
    unmerged index for an `All` request both return `stash_file_conflicted` with
    the path, and neither creates an entry.
11. **Empty scope refused** — `Paths { paths: [] }` returns `stash_scope_empty`
    and never reaches Git.
12. **Base commit** — `entry.base` equals the `HEAD` commit at stash time, across
    a later commit and a later branch switch.
13. **File list** — `get_stash_files` groups match `git diff` between the
    corresponding parent trees, for a stash with staged, unstaged, and untracked
    content.
14. **Staged/worktree split correctness** — a path that was staged *and* further
    modified appears in both `staged` and `worktree` with the correct halves of
    its change.
15. **Untracked parent present but empty** — a pathspec stash with `-u` whose
    pathspec excludes every untracked file has `has_untracked == false` and an
    empty `untracked` group.
16. **An *externally* created pathspec stash is reported honestly** — build the
    §4.3 fixture with the **Git CLI**, not through `create_stash`: `a.txt` staged
    and further modified, `b.txt` staged and unrelated, then
    `git stash push -u -m "only a" -- a.txt`. Assert that Git recorded `b.txt`'s
    staged content in the entry, that `get_stash_files` lists `b.txt`, and that
    `apply` reapplies it. This case pins the **inspector's** honesty about
    entries Fjord did not create (§4.3) and stops a future "fix" that filters the
    list. It is explicitly **not** a statement about `create_stash`: the same
    selection made through Fjord must satisfy cases 28–31 instead, and a
    regression that turns Fjord's own scoped creation into this behavior is a
    failure of those cases, not a pass of this one.
17. **Apply a non-top stash** — applying `stash@{2}` by id changes the worktree
    accordingly and leaves the stack length unchanged.
18. **Apply with `restore_index`** — staged state is staged again; plus a case
    where Git refuses `--index`, returning `stash_apply_index_refused` without
    falling back.
19. **Apply refuses to overwrite** — a dirty overlapping path yields
    `stash_apply_would_overwrite` with the path list, and the worktree is
    unchanged.
20. **Pop a non-top stash** — by id; that exact entry is gone and the others
    remain, in order.
21. **Conflicted pop keeps the entry** — asserting all four facts: outcome is
    `Conflicted` with the path, `entry_removed == false`, the entry is still in
    the stack, and `operation_state` is still `Normal` (no `MERGE_HEAD`).
22. **Drop by identity** — drops that exact entry after an intervening push
    changed every index.
23. **Stale identity fails closed** — capture an id, drop the entry externally
    via the Git CLI, then run apply / pop / drop / create-branch with the stale
    id: each returns `stash_not_found` and mutates nothing.
24. **Create branch from stash** — the branch is created at `base` (not at
    `HEAD`), is checked out, the stash is applied, and the entry is **still
    present**; plus a case where the apply conflicts and the branch still exists
    with the entry kept.
25. **Create branch refuses an unsafe checkout** — overlapping local changes
    yield `checkout_would_overwrite` and no branch is created.
26. **Generations** — the `generation.rs` mutation-mask table gains rows for
    every §8 mutation, asserting the exact mask: apply bumps `working_tree` only,
    drop bumps `stash` only, and no stash action bumps `refs` or `history` except
    create-branch-from-stash.
27. **Confirmation binding** — a token issued for `StashPop { id: A }` cannot
    execute `StashPop { id: B }` or `StashDrop { id: A }`, and a replayed token
    is an atomic no-op.

**Invariant B — the scoped-stash content and apply cases.** These are the proof
gate of §2.3. They all use the canonical fixture of case 6, they all create the
stash **through `create_stash`**, and asserting that unrelated files survive
creation (case 7) does **not** substitute for any of them. The apply side is the
important regression: it is the one a user meets days later, and the one a
whole-tree recording silently breaks.

28. **Entry contents are exactly the selected scope** — inspect the entry created
    in case 6 through `get_stash_files`:

    - `a.txt` present;
    - `c.txt` present, with its staged and worktree halves in the correct groups
      per §4.2 (a partially staged selected path keeps its structure — it is not
      flattened);
    - `u1.txt` present in the Untracked group (`include_untracked: true`);
    - `b.txt` **absent**;
    - `d.txt` **absent**;
    - `u2.txt` **absent**.

    `files_changed` counts exactly the present set. Assert against the stash
    commit's trees as well as through `get_stash_files`, so a filtering bug in
    the read layer cannot make a whole-tree entry look correct.
29. **Apply restores only the selected paths** — apply the case-6 entry onto a
    fresh fixture that is clean apart from independent `b.txt` / `d.txt` /
    `u2.txt` content:

    - `a.txt`, `c.txt`, and `u1.txt` are restored;
    - `b.txt`, `d.txt`, and `u2.txt` are **untouched** — worktree bytes and index
      entries both compared, before and after;
    - the same holds with `restore_index` on and off.
30. **Pop restores only the selected paths** — the same assertions as (29) via
    Pop, plus: the entry is removed on a successful apply, and a conflicted pop
    restores nothing outside the selected set and keeps the entry (case 21's
    facts, re-asserted on the scoped fixture).
31. **Set-equality invariant** — the strong, general form, expressed once as a
    reusable assertion rather than as prose:

    ```text
    set(paths touched by applying a Fjord-created `Paths` stash)
        == set(paths of the effective request)
    ```

    Asserted for at least: one path; several paths; a partially staged path; a
    selected untracked path with `include_untracked` on; and a selection made
    while unrelated paths were staged, unstaged, partially staged, and untracked
    at once. Where a selected state is not representable by the chosen
    construction, the request must fail `stash_scope_unrepresentable` and create
    nothing — that outcome is a passing case, an approximate entry is not.
32. **External add at cleanup boundary** — pause after the real `index.lock` and
    expected-HEAD transaction are prepared; an external `git add` is refused,
    and the final real index/worktree match one valid serialization with no stale
    lock.
33. **External HEAD change at cleanup boundary** — the same deterministic pause
    races a CLI commit; the prepared ref and index locks prevent captured
    `HEAD=A` state from being cleaned against `HEAD=B`.
34. **Stash publication CAS race** — pause after cleanup, insert an external
    ordinary stash, and assert Fjord returns `stash_concurrent_update`, restores
    its selected state, and leaves only the external OID in the actual
    `refs/stash` reflog.
35. **Failure before publication** — inject failure after cleanup and compare
    raw index bytes, selected and unrelated tracked/untracked bytes, ref value,
    complete stash reflog, generations, and every transaction/temp lock.

### Frontend (component and hook tests)

1. The **Stashes** section renders in `RepoTree` after Tags, with its count.
2. Order matches the backend list exactly; `stash@{0}` is first.
3. Selecting a stash row opens the Stash Inspector for that entry's id.
4. Right-click on a tree row opens the shared menu carrying that exact `StashId`;
   `Shift+F10` and the Context Menu key do the same, and focus is restored on
   close.
5. Right-click on a graph marker opens the same menu with the same id — asserted
   against a fixture where two stashes share one base commit.
6. Menu composition: Apply / Pop… / Create branch… / three Copy entries / Drop…,
   with Drop last and danger-styled, and `Restore staged state` disabled with a
   reason when `hasIndexState` is false.
7. Pop and Drop open the shared `DestructivePreflightDialog`; Apply and the Copy
   entries do not.
8. A marker attaches to the row whose commit id equals `entry.base`, and to no
   other row.
9. Two stashes on one base render two individually selectable markers; past the
   overflow threshold both remain individually selectable in the flyout.
10. A stash whose base commit is not in a loaded page renders no marker, leaves
    the graph layout untouched, and its tree row still offers **Reveal in graph**.
11. The create dialog submits the user's edited name, not the prefilled default.
12. `Stash file…` from one working-file row opens the dialog with `Paths` scope
    and that one path.
13. `Stash 3 files…` opens it with all three paths listed.
14. `Stash N files…` reaches `create_stash` with every selected path, in one
    call — asserted at this spec's boundary. The selection gestures that produced
    that set are [`working-tree-and-diff.md`](working-tree-and-diff.md) §7's
    frontend cases 1–19 and are not duplicated here.
15. **Effective-set semantics in the dialog (§2.4.1)** — a selection containing
    untracked paths with **Include untracked files** unticked shows the reduced
    count, names the excluded paths, and dispatches only the effective set;
    ticking the box restores both in place; an all-untracked selection with the
    box unticked leaves Confirm disabled with the stated reason.
16. Five-locale parity: every new key exists in `en`, `ru`, `de`, `fr`, `es`,
    with `npm run check-i18n` green.

`npm run check-ipc-docs` must stay green, which requires the shipped-command
tables in [`ipc-commands.md`](ipc-commands.md) to be updated in the same task
that registers each command.

## i18n

New keys, `workspace.json` unless noted. The counted `workingFile.*` batch
labels (including `Stash {{count}} files…`) belong to
[`working-tree-and-diff.md`](working-tree-and-diff.md) §7.17 and are not
repeated here. Every dynamic value is an interpolation
variable, never concatenated ([`i18n.md`](i18n.md)). `stash` stays Latin in
Russian per the glossary.

| Key | English |
|---|---|
| `tree.stashes` | `Stashes` |
| `stash.empty` | `No stashes.` |
| `stash.create.title` | `Stash changes` |
| `stash.create.name` | `Stash name` |
| `stash.create.scope` | `Scope` |
| `stash.create.scopeAll` | `All changed files` |
| `stash.create.scopeSelected_one` | `Selected file` |
| `stash.create.scopeSelected_other` | `Selected files ({{count}})` |
| `stash.create.includeUntracked` | `Include untracked files` |
| `stash.create.untrackedExcluded_one` | `{{count}} selected untracked file will not be stashed.` |
| `stash.create.untrackedExcluded_other` | `{{count}} selected untracked files will not be stashed.` |
| `stash.create.onlyUntracked` | `Every selected file is untracked. Include untracked files to stash them.` |
| `stash.create.confirm` | `Stash` |
| `stash.create.andMore` | `and {{count}} more` |
| `stash.defaultMessage.all` | `Work in progress on {{branch}}` |
| `stash.created` | `Stashed as "{{message}}"` |
| `stash.action.apply` | `Apply stash` |
| `stash.action.pop` | `Pop stash…` |
| `stash.action.drop` | `Drop stash…` |
| `stash.action.createBranch` | `Create branch from stash…` |
| `stash.action.revealInGraph` | `Reveal in graph` |
| `stash.action.copyRef` | `Copy stash reference` |
| `stash.action.copySha` | `Copy stash SHA` |
| `stash.action.copyBaseSha` | `Copy base commit SHA` |
| `stash.restoreIndex` | `Restore staged state` |
| `stash.restoreIndex.unavailable` | `This stash has no staged state to restore.` |
| `stash.inspector.createdFrom` | `Created from {{branch}}` |
| `stash.inspector.createdDetached` | `Created on a detached HEAD` |
| `stash.inspector.baseCommit` | `Base commit` |
| `stash.inspector.files_other` | `{{count}} files` |
| `stash.inspector.groupStaged` | `Staged changes` |
| `stash.inspector.groupWorktree` | `Working changes` |
| `stash.inspector.groupUntracked` | `Untracked` |
| `stash.inspector.applyIsUnstaged` | `Apply restores these changes as unstaged unless you restore the staged state.` |
| `stash.inspector.truncated` | `This stash is too large to list every file.` |
| `stash.branch.title` | `Create branch from stash` |
| `stash.branch.applyAfterCheckout` | `Apply stash after checkout` |
| `stash.branch.keepsStash` | `The stash is kept. You can drop it afterwards.` |
| `stash.conflict.applied` | `Applied with conflicts in {{count}} files.` |
| `stash.conflict.popKept` | `The stash was kept because the apply conflicted.` |
| `stash.revealNotFound` | `The commit this stash was created from is not in this history.` |
| `preflight.stashPop.title` | `Pop stash` |
| `preflight.stashPop.explanation` | `Apply "{{message}}" to {{branch}}, then remove it from the stash.` |
| `preflight.stashPop.conditional` | `The stash entry is removed only if the apply succeeds.` |
| `preflight.stashDrop.title` | `Drop stash` |
| `preflight.stashDrop.explanation` | `Remove "{{message}}" ({{ref}}) from the stash without applying it.` |
| `preflight.consequences.stashEntryConsumed` | `"{{message}}" ({{ref}}) — {{count}} files — will be removed from the stash.` |
| `errors.stash_not_found` *(common)* | `That stash no longer exists. Refresh and try again.` |
| `errors.stash_ambiguous` *(common)* | `More than one stash entry points at the same commit; Fjord will not guess which one you meant.` |
| `errors.stash_scope_empty` *(common)* | `No files were selected to stash.` |
| `errors.stash_concurrent_update` *(common)* | `The repository changed while the stash was being created. Nothing was stashed.` |
| `errors.stash_recovery_failed` *(common)* | `Stash creation failed and Fjord could not fully restore the repository. Review your staged and working changes before continuing.` |
| `errors.stash_scope_unrepresentable` *(common)* | `The state of {{path}} cannot be stashed on its own, so nothing was stashed.` |
| `errors.stash_apply_would_overwrite` *(common)* | `Applying this stash would overwrite local changes.` |
| `errors.stash_apply_index_refused` *(common)* | `The staged state of this stash could not be restored.` |
| `errors.stash_apply_failed` *(common)* | `The stash could not be applied.` |

## Acceptance criteria

1. Every stash action in every layer is keyed on `StashId`; no frontend value,
   query key, menu item, preflight, or executor argument carries a stash index as
   identity. `stash@{n}` is produced only by a backend re-resolution performed
   under the write lock, or rendered/copied for display.
2. A stale `StashId` — the entry was popped or dropped elsewhere — fails closed
   with `stash_not_found` on apply, pop, drop, and create-branch, and mutates
   nothing.
3. `create_stash` is the single creation contract; `stash_push` and `stash_file`
   no longer exist as commands; `git2::stash_save2` is no longer called anywhere;
   and the dead `GitBackend::stash_pop` / `mutations::stash_pop` pair is deleted,
   leaving one pop implementation on the confirmed destructive path.
4. **Both scoped-stash invariants hold, and both are proven.** (A) Stashing
   selected paths leaves every unrelated staged, unstaged, and untracked change
   byte-for-byte unchanged, index entries included, proven by fixtures for each
   state in §2.4. (B) Applying or popping a Fjord-created `StashScope::Paths`
   entry touches **only** the selected paths — `set(touched) == set(requested)`
   — proven by backend cases 28–31 on the canonical fixture. `P10-STASH-02` does
   not ship without (B); an unrepresentable selection fails closed with
   `stash_scope_unrepresentable` rather than producing an approximate entry.
   `StashScope::All` keeps conventional whole-repository semantics;
   `StashScope::Paths` is an exact semantic subset. The two contracts are
   distinct and normative (§2.1), and `Stash file…` runs on the same engine and
   the same contract as `Stash N files…` (§2.9) — there is exactly one
   implementation of interactive scoped stash.
5. Every interactive stash creation collects an editable name; no Fjord-owned
   stash metadata is persisted anywhere.
6. The repository tree has a Stashes section, in Git's stack order, with counts,
   filtering, keyboard navigation, and context-menu parity with branch and tag
   rows.
7. The Stash Inspector shows base commit, source branch (or an honest detached
   note), time, file count, and the three-group file structure derived from the
   stash commit's parent trees — always the entry's **true** contents, never a
   remembered selection and never a presentation-time filter. For a Fjord-created
   `Paths` stash that list contains exactly the selected scope, because criterion
   4(B) made the entry exact; for an externally created stash it contains
   whatever Git recorded, including unrelated paths a terminal pathspec stash
   swept in. Fjord never claims to know an external stash's original pathspec —
   Git does not persist one.
8. Stash file diffs render through the existing bounded `FileDiffWindow`
   pipeline, with the same ceilings and the same renderer. No unbounded diff path
   exists.
9. The commit graph shows a distinct, selectable marker on each stash's base
   commit; Git's internal stash commits never appear as history; multiple
   stashes on one base stay individually selectable; and an unloaded base commit
   neither distorts the layout nor loses the stash.
10. Apply, Pop, Drop, Create branch from stash, and the Copy actions are reachable
    from the tree, the graph, and the inspector through one shared item builder
    and one shared dispatch.
11. Apply works on any entry, keeps it, offers index restoration where it is
    possible, and never discards or stashes current local work implicitly.
12. Pop works on any entry, routes through the destructive preflight, and does
    **not** remove the entry when the apply conflicts or fails.
13. Drop routes through `preflight_destructive_action` → one-use token →
    `execute_destructive_action`, has no private command, and is labeled
    `NotRecoverable`.
14. Create branch from stash branches at the stash's original base commit, checks
    it out, applies, and **keeps** the stash; dropping afterwards is a separate,
    explicit, preflighted action.
15. `Stash N files…` passes every selected path to `create_stash` in one call.
    The selection model that produces it is owned and verified by
    [`working-tree-and-diff.md`](working-tree-and-diff.md) §7, not here.
16. Generations are exact: apply bumps `working_tree` only, drop bumps `stash`
    only, and no stash action bumps `refs` or `history` except
    create-branch-from-stash. Tree, graph, badge, and inspector all refresh after
    create, pop, and drop without a restart.
17. All new strings exist in all five locales with correct plural forms;
    `npm run check-i18n` and `npm run check-ipc-docs` are green.
