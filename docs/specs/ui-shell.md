# Spec: application shell, navigation, and keyboard model

Referenced by: P7-01–P7-16, P9R-01, P10-STASH-03, P10-STASH-05,
P10-WC-MULTI-01, SDD §6, §15.
Related: [`performance.md`](performance.md), [`theming.md`](theming.md),
[`i18n.md`](i18n.md), [`data-model.md`](data-model.md),
[`ipc-commands.md`](ipc-commands.md), [`stash-management.md`](stash-management.md).

## Problem

Fjord's shell was assembled feature by feature, and it shows in four ways that
cost the user attention on every single session:

1. **Chrome competes with content.** The sidebar's top 44 px are permanently
   occupied by a logo, the word "Fjord", and a Settings button
   (`src/presentation/Sidebar.tsx`). A user who opens the app hundreds of times
   does not need to be told which app it is; that space is navigation space. The
   repository toolbar spends its full width on ten equally-weighted icon buttons
   (`src/presentation/RepoToolbar.tsx`), so Fetch/Pull/Push — the actions used
   dozens of times a day — look exactly as important as "open merge tool".
2. **Settings sits inside Git navigation.** Settings is a sidebar affordance and
   also a toolbar-adjacent one; it belongs to neither. There is no consistent
   place for app-level utilities, so Search appears in the repository toolbar and
   nowhere else.
3. **Almost no UI state survives a restart.** Only the two repository pane widths
   are persisted (`localStorage`, `fjord:repo-layout:v1`). Collapsed workspaces,
   the selected workspace and repository, the sidebar width, and the diff view mode
   are re-derived on every launch, so the app never reopens where the user left it.
4. **Keyboard support is incidental.** There is one palette shortcut and a set of
   suppressed browser shortcuts (`src/main.tsx`). There is no shortcut registry,
   no discoverability surface, and no separation between "do something" and
   "go somewhere" — the single palette mixes navigation targets, repository
   actions, and bulk actions in one list (`src/presentation/App.tsx`).

Additionally, repository state (dirty / ahead / behind / conflict) is encoded
partly by color alone in dashboard cards and metric tiles, which fails for
color-vision-deficient users and in high-contrast environments.

## Goals

- Dense, quiet, content-first shell: chrome earns its pixels or is removed.
- One predictable location for app-level utilities, distinct from Git actions.
- A toolbar whose visual weight matches actual usage frequency.
- UI state that survives a restart, so the app reopens where the user left it.
- A coherent keyboard model: every frequent action reachable without the mouse,
  discoverable in the app, and layout-independent.
- Status never encoded by color alone.

## Non-goals

- A redesign of the commit graph, diff view, or inspector internals — this spec
  covers the shell around them. Diff presentation is
  [`working-tree-and-diff.md`](working-tree-and-diff.md).
- New Git capabilities. No task in this phase adds a Git operation; actions are
  rearranged, grouped, and made reachable, not invented.
- A custom title bar or per-OS window chrome changes (SDD §5.4 stands: native
  decorations by default).
- A themeable/user-configurable layout system. Panel widths are persisted;
  arbitrary panel rearrangement is not offered.
- Removing the command palette. It is refocused, not replaced.

## Historical baseline (before Phase 7)

| Element | State |
|---|---|
| Sidebar | Logo + "Fjord" + Settings button header; two nav items (Overview, All repositories); workspace list with inline create/rename/reorder (drag), expandable repository children. Fixed width `w-60`. In-memory expansion state, reset on reload. |
| Global utilities | 🚧 None. Settings opens from the sidebar header and from the palette; Search opens only from the repository toolbar or `Ctrl/Cmd+F`-style handling inside the graph. |
| RepoToolbar | Back button + repo name + branch + counters on the left; three `ToolGroup`s of equal-weight 60 px icon buttons: fetch/pull/push · branch/stash/pop · terminal/IDE/search/inspector. Progress strip below. |
| Overview header | Title + repo count, then five buttons: Fetch all, Pull all, Open all in IDE, Import, Open repository. Then a three-card metric grid, then the virtualized repo grid. |
| Borders | `rounded-lg border` on the toolbar, the metric cards, each repo card, the working-changes panel, and the progress strips — cards inside cards inside a bordered main pane. |
| Layout persistence | ⚠️ `ResizableRepoLayout` persists left/right pane widths in `localStorage`. Sidebar width fixed; nothing else persisted. |
| Palette | `Ctrl/Cmd`-opened; mixes settings, repositories, per-repo actions, bulk actions, and branches; remote global-search results merged in. |
| Shortcuts | `isPrimaryShortcut` matches physical key codes (layout-independent) ✅; browser shortcuts suppressed in `main.tsx`; no registry, no help surface. |
| Accessibility | Icon buttons carry `title`/`aria-label` ✅. Status tones (`--amber`, `--rust`) carry meaning without a redundant text or shape cue in metric tiles and cards. |
| i18n | 5 locales shipped (`en`, `ru`, `de`, `es`, `fr`), 309 English keys, CI drift check ✅. |

## Current state

| Element | State |
|---|---|
| Sidebar | ✅ Resizable navigation/workspace tree with no working-shell branding or Settings entry; width, expansion, and selection persist through the versioned UI-state store. Workspace attention dots and repository primary-state badges consume backend-sorted `RepoHealth`. |
| Global utilities | ✅ Reusable `ShellUtilities` owns exactly Search and Settings and is composed into the active screen header. The shortcut/palette and Settings dialog owners are unchanged. There is no dedicated utility row. |
| Settings dialog | ✅ Compact modal with a narrow sidebar and five product sections in order: General, Git, Tools, Appearance, About. General owns language; Git groups executable, authentication/environment, repository trust, and connection diagnostics; Tools owns performance traces plus built-in/custom editor selection; Appearance owns the three theme choices; About contains only app/version and log-folder diagnostics. There is no Sync section or background auto-fetch control. 🚧 `P10-WC-06` adds one control to the existing Tools section — the optional external diff-tool **name** — without adding a section ([`working-tree-and-diff.md`](working-tree-and-diff.md) §6.4). |
| RepoToolbar | ✅ Identity/state left; Fetch/Pull/Push/Branch center; IDE and overflow next; one separated `ShellUtilities` slot last. Stash/Pop/Terminal/Merge tool/compact Inspector live in overflow. No duplicate Search. |
| Overview header | ✅ Four workspace actions (Fetch all, Pull all, Add repository, overflow), followed by the separated two-control utility slot; one compact filterable summary line replaces metric cards. Its attention count/filter reads `RepoHealth.needs_attention`, so a merely dirty repository is not included. |
| All repositories header | ✅ Title/count, text filter, then the same two-control utility slot. |
| Borders | ✅ `Surface`/`ScreenSurface` enforce one visual ownership level with hairline separators instead of nested bordered cards. |
| Layout persistence | ✅ SQLite-backed versioned UI state owns sidebar/tree/inspector widths, collapsed workspaces, selection, diff/file modes, and Overview filters. |
| Palette and shortcuts | ✅ Actions palette (`Ctrl/Cmd+K`), repository switcher (`Ctrl/Cmd+P`), scoped repository search (`Ctrl/Cmd+F`), Settings (`Ctrl/Cmd+,`), help, refresh, workspace selection, and Escape share one registry/listener. |
| Accessibility and i18n | ✅ Screen axe scans and overlay focus tests pass; status uses text/glyph plus color; all shell strings are synchronized across five locales. |

## Proposed design

### 1. Information architecture

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Sidebar (resizable)          │  Screen header       actions │ [⌕][⚙]│
│  Overview                    ├───────────────────────────────────────┤
│  All repositories            │   Screen content                      │
│                              │   (Overview | All repos | Repository) │
│  WORKSPACES               +  │                                       │
│   ▸ Backend            3     │                                       │
│   ▾ Frontend           2 ⚠1  │                                       │
│      web-app                 │                                       │
│      design-system           │                                       │
└──────────────────────────────┴───────────────────────────────────────┘
```

- The sidebar starts at navigation. The Fjord mark and wordmark move to
  onboarding, the About panel, and the OS-level app icon/window title — the
  places where identity is actually needed.
- **`ShellUtilities`** owns exactly Search and Settings. Each main screen places
  that shared component at the trailing edge of its existing header, after a
  hairline separator. It is not part of the sidebar and Search is not duplicated
  by the repository toolbar.
- The semantic owner, ARIA labels, callbacks, and shortcuts remain global while
  the screen owns composition. This keeps the utilities in a stable top-right
  area without spending a dedicated 44 px row on two icons.

Why the header and not the sidebar bottom: the sidebar is the navigation tree and
grows with workspaces; anchoring utilities to it makes their position depend on
content length. The trailing header slot stays visible on every main screen and
preserves content-over-chrome.

#### 1.1 Repository navigation sections

Inside the Repository screen, the left column is the repository tree
(`RepoTree.tsx`): collapsible sections with one shared filter box, each body
virtualized and capped in height. Its section order is fixed, and this spec owns
that order:

```text
Branches → Local, Remote
Tags
Stashes          (P10-STASH-03)
Worktrees        (P10-03, workspace-workflows.md §1)
Remotes          (P10-07, workspace-workflows.md §3)
```

**Stashes sit after Tags and before Worktrees, in their own section — never
merged into the ref sections.** A branch or tag is a ref the user can check out,
push, or merge; a stash is none of those, and listing it among refs would invite
gestures that cannot work. The section is collapsed by default like Remote and
Tags, shows an exact count, renders an empty state rather than hiding itself at
zero, and inherits the shared filter, roving tabindex, arrow navigation, fixed
row height, and `Shift+F10` / Context-Menu-key parity every other section already
has. Row content, ordering, and actions are
[`stash-management.md`](stash-management.md) §3 and §6 — this spec owns only
where the section lives and that it behaves like its siblings.

Within the Working Changes panel, a selection of two or more file rows adds a
compact strip to that section's existing header — `4 selected` plus two or three
high-frequency actions, an overflow, and Clear. It reuses the header idiom
already in place rather than introducing a floating overlay or a new visual
language, and it exists so that batch actions are not discoverable only by
right-click. Its contents and the actions' availability are
[`working-tree-and-diff.md`](working-tree-and-diff.md) §7.14 and §7.9.

In the commit graph, a stash appears as a **marker in the base commit's ref-badge
row**, alongside branch and tag badges but visually distinct from them by glyph
and treatment plus a text label — never colour alone (§7). It is not a lane, adds
no edges, and changes no row height or column assignment, so graph virtualization
is unaffected. Git's internal stash commits are never rendered as history. The
selection, overflow-flyout, and not-yet-loaded-base behavior are
[`stash-management.md`](stash-management.md) §5.

### 2. RepoToolbar hierarchy

```text
┌──────────────────────────────────────────────────────────────────────┐
│ ← repo-name                    Fetch  Pull  Push  Branch   IDE ⋯ │ ⌕ ⚙│
│   ⎇ main  ↑2 ↓1 ●3                                                    │
└──────────────────────────────────────────────────────────────────────┘
```

| Zone | Contents | Rule |
|---|---|---|
| Left | Back, repository name, branch, ahead/behind/dirty state | Identity and state only — never an action that mutates the repository. |
| Center | Fetch, Pull, Push, Branch | Primary weight. Capped at five items; adding a sixth requires demoting one. |
| Right | Open in IDE, overflow `⋯`, then `ShellUtilities` (Search, Settings) after a separator | Repository tools remain distinct from application utilities. |

The overflow menu holds: Stash, Stash pop, Open terminal, Open merge tool,
Inspector toggle (compact layouts), and later additions from Phases 8–10.
`P10-STASH-02` replaces the unnamed **Stash** entry with **Stash changes…**,
which opens the shared naming dialog; `P10-STASH-06` retires the whole-stack
**Stash pop** entry, because popping now names an exact entry and is reached
from the Stashes section, the graph marker, or the Stash Inspector rather than
from a toolbar button that can only ever mean `stash@{0}`. The stash **count
badge** stays, for the reason the badge rule below already gives: it answers a
question at a glance instead of requiring a click.
Branch integration actions (Merge, Rebase) are **not** toolbar or overflow
entries: they are per-ref actions and belong to the branch context menus and the
actions palette ([`branch-merge.md`](branch-merge.md) §8), because a toolbar
button cannot name which branch it would merge.
Conflict-state actions are the exception: when the repository is in a conflicted
or in-progress operation state, the relevant action is promoted out of overflow
into a state banner (see [`repository-safety.md`](repository-safety.md)) — a
user in a broken state should not have to go hunting.

Rules that keep the hierarchy from decaying:

- The center zone shows *labels*, the right zone shows icons with tooltips.
- Badges (behind count on Pull, ahead count on Push, stash count) stay, because
  they carry state the left zone would otherwise duplicate.
- An action that is unavailable is disabled with a reason in its tooltip, never
  hidden — hidden actions make the toolbar's shape unstable between repositories.

### 3. Overview screen

Header reduces to: **Fetch all · Pull all · Add repository · `⋯`**. The overflow
carries "Open all in IDE". **Add repository** opens the single app-owned
repository-onboarding surface; scanning a folder is no longer a separate action
with a second owner.

The onboarding surface has four stable choices: **Open Existing Repository**,
**Scan Folder for Repositories**, **Clone Repository**, and **Create Repository**.
It is also reached after creating a workspace during first run. The dialog follows
the shell overlay contract: first-action focus, trapped Tab order, Escape
dismissal, invoker focus restoration, and localized labels/descriptions. P9R-01
reuses the existing Open and Scan operations and adds no IPC or Git mutation;
P9R-03 and P9R-05 fill the stable Clone and Create slots without adding a second
owner for repository onboarding.

The first-run workspace screen is a choice, not a wizard: **Create only** enters
an empty workspace, while **Create and add repository** opens the same four-choice
surface. The empty Overview explains all four paths and links back to that owner.
Cancelling a native Open/Scan picker keeps the choices visible; Back/Escape from
Clone or Create returns to them without creating or registering anything.

Clone opens a second app-owned overlay with Repository URL, destination-parent
picker, and repository-folder-name fields. Common HTTPS, SSH, and SCP-style Git
URLs seed the editable folder name; the operation cannot start until all three
inputs are valid. While cloning, the fields and navigation are locked, operation
events drive a determinate progress bar when Git reports totals (otherwise a
message-only phase), and Cancel targets the same operation ID. Stable transport
and destination errors are localized without exposing raw Git output. Success
publishes the returned repository into the workspace query at most once, closes
the overlay, and selects it through the normal repository-detail navigation path.

Create opens the corresponding app-owned overlay with repository name,
parent-folder picker, and initial-branch fields. `main` is the visible default;
unsafe directory or ref-like names and an absent parent folder keep **Create and
open** disabled. The fields and navigation are locked while the local operation
runs, and stable destination/registration failures are localized. Success
publishes the returned repository into the workspace query at most once and
selects it through the same navigation path as every other repository. An unborn
`HEAD` is a normal repository state: the operation banner names it, history is an
empty page rather than a read failure, and the ordinary working-changes/commit
surface remains available for the first commit.

The three metric cards are replaced by a single summary line:

```text
12 repositories · 3 need attention · 2 behind
```

- Rendered as one line of text with the counts emphasized typographically, not as
  bordered tiles.
- Each segment is a filter toggle (Phase 10 wires the filters; Phase 7 ships the
  line with "needs attention" and "behind" as the two initial filters).
- Zero-value segments are omitted rather than shown as "0", so a healthy
  workspace reads `12 repositories` and nothing else.

### 4. Visual density

- One border level per surface. The main pane provides the background; cards
  inside it use a subtle background (`--paper`) and, at most, a hairline
  separator — not a full border. A card inside a card gets no second border.
- Group by whitespace and by a `GroupLabel`-style caption; use `--hairline` only
  where an actual boundary must be readable (pane splits, list section splits).
- Typography carries hierarchy: size and weight steps already exist in
  `src/presentation/ui.tsx` and get consolidated into a documented scale so new
  components stop inventing `text-[13px]` variants ad hoc.

This is a token/CSS-level change under [`theming.md`](theming.md); no new theme
modes are introduced.

### 5. Persisted UI state

Owner: the backend, via a new `ui_state` table (see
[`data-model.md`](data-model.md) for the migration), read once at startup and
written debounced.

| Key | Value | Written on |
|---|---|---|
| `sidebar.width` | number (px) | resize end |
| `repo.treeWidth`, `repo.inspectorWidth` | number (px) | resize end |
| `sidebar.collapsedWorkspaces` | workspace id list | toggle |
| `selection.workspaceId`, `selection.repositoryId` | id | selection change, debounced 500 ms |
| `repo.diffMode` | `unified` \| `split` | change |
| `repo.fileViewMode` | `path` \| `tree` | change |
| `overview.filter` | filter id list | change |

Contract:

- IPC: `get_ui_state` → `UiState`, `update_ui_state` → `UiState` (partial patch,
  same shape as `update_settings`). One row, versioned, droppable.
- Unknown keys and version mismatches are ignored on read and rewritten on next
  save — a stale row can never break a launch.
- A restored selection that no longer resolves (workspace or repository removed)
  falls back to the current default without an error.
- The existing `localStorage` pane widths are migrated on first launch and the key
  is then removed, so widths are not stored in two places.

Why the backend and not `localStorage`: the app already owns a settings store, the
write is async and off the render path, and the WebView's storage is cleared by
several ordinary conditions (profile reset, updater on some platforms). UI state
that silently vanishes is worse than UI state that was never persisted.

### 6. Keyboard model

Two distinct surfaces:

| Surface | Question it answers | Default binding | Contents |
|---|---|---|---|
| Command palette | "do something" | `Ctrl/Cmd+K` | Actions only: repository actions, bulk actions, settings, view switches. Grouped by scope with the active repository's actions first. 🚧 **Merge branch…** joins this list (`P10-MERGE-01`); it ranks the active repository's local branches and dispatches the same application action as the two context menus, adding no branch logic of its own. |
| Repository switcher | "go somewhere" | `Ctrl/Cmd+P` | Repositories and workspaces only, ranked by recency then fuzzy score. |

Additional bindings:

| Binding | Action |
|---|---|
| `Ctrl/Cmd+,` | Settings |
| `Ctrl/Cmd+F` | Search within the active repository (commit search) |
| `Ctrl/Cmd+Shift+F` | Global search across repositories |
| `Ctrl/Cmd+Enter` | Commit (already implemented in the commit panel) |
| `Ctrl/Cmd+R` | Refresh the active scope (revalidate snapshot) |
| `Ctrl/Cmd+1..9` | Switch to the *n*-th workspace |
| `?` | Shortcut help |
| `Esc` | Close the topmost overlay |
| `Shift+F10` / **Context Menu** key | Open the context menu for the focused row |
| `Ctrl/Cmd+A` | 🚧 Select all file rows in the focused Working Changes section (`P10-WC-MULTI-01`) |
| `Shift`+Arrow | 🚧 Extend the Working Changes selection from its anchor |
| `Ctrl/Cmd+Space` | 🚧 Toggle the focused Working Changes row without moving focus |

`Ctrl/Cmd+A`, `Shift`+Arrow, and `Ctrl/Cmd+Space` are **list-scoped**, not global:
they apply only while a Working Changes list holds focus, and `Ctrl/Cmd+A` there
must not fall through to the document's select-all. Their exact semantics — which
rows are eligible, what "visible" means in Tree view, and how focus stays
separate from selection — are
[`working-tree-and-diff.md`](working-tree-and-diff.md) §7.4 and §7.6; this table
records only that the shell reserves the bindings and that they are registered
through the same shortcut registry as everything else in it.

**Context menus are part of the keyboard model, not a mouse affordance.** Every
surface that offers a right-click menu must open the same menu, with the same
payload, from `Shift+F10` and from the platform Context Menu key on the focused
row. This applies to the shipped branch and tag menus and to the menus added by
[`working-tree-and-diff.md`](working-tree-and-diff.md) §6 (Working Changes file
rows) and [`branch-merge.md`](branch-merge.md) §8 (commit-graph branch labels).
Where a list supports multi-selection, the keyboard path obeys the same
preserve-or-replace rule as the mouse: opening the menu on a focused row that is
already in the selection keeps the selection, and on one outside it replaces the
selection first (§7.7 of the working-tree spec).
Contract:

- Opening the menu first focuses/selects the target row, so the visible selection
  and the menu's target can never disagree.
- The menu owns the **logical identity** of its target (repository, ref, or
  `{ path, source }` file identity) — never a DOM node and never a virtual-row
  index. Every list carrying a context menu is virtualized; a menu anchored to a
  recycled node would silently retarget, and a menu whose target disappears
  closes instead of acting.
- Arrow/Home/End navigation, item shortcuts, Escape, and focus restoration to the
  invoking row follow the existing shared `ContextMenu` behavior. New menus reuse
  that primitive rather than adding a second popover implementation; submenus are
  an addition to it, not a replacement for it.
- Unavailable entries are disabled with a stated reason, per §2's rule.

Implementation contract:

- A **shortcut registry** module in `src/application/` owns bindings as data:
  `{ id, code, modifiers, scope, handler }`, where `scope` is one of `global`,
  `repository`, `dialog`. Registration is declarative; a duplicate binding within
  the same scope is a development-time error, not a silent last-wins.
- Matching goes through the existing `isPrimaryShortcut` code-based comparison, so
  bindings keep working on non-Latin keyboard layouts (`Ctrl+К` on a Russian
  layout must still open the palette).
- Text inputs swallow shortcuts except `Esc` and the explicit commit binding.
- Every registered binding appears in the help sheet with a localized label; the
  help sheet is generated from the registry, so it cannot drift.

### 7. Accessibility

- Every status is encoded by **at least two** of: text, shape/glyph, position,
  color. Concretely: dirty → `●3` glyph + count, ahead/behind → `↑2` / `↓1`
  glyphs + counts, conflict → a labeled badge with text, not a red dot.
- Status colors keep a documented contrast ratio against both themes
  (WCAG AA for text-sized elements) — verified in the theming tokens.
- Focus order follows the visual order in each screen; every overlay traps focus
  and restores it on close.
- All icon-only controls keep `aria-label` and a tooltip; the overflow menu is a
  real menu with arrow-key navigation.
- No action is reachable only by right-click. Every context menu opens from the
  keyboard per §6, traps its own navigation, closes on Escape, and returns focus
  to the row it was opened from.

## Alternatives considered

**Utility placement: dedicated strip vs. sidebar footer vs. shared component in
screen headers.** A sidebar footer competes with the workspace list and makes
Settings look navigation-scoped. The first Phase 7 implementation chose a fixed
44 px strip for position stability, but repository screens then showed the same
Search action twice and every screen paid the vertical cost. `P7-FIX-04` keeps one
semantic `ShellUtilities` owner and composes it into each header. This retains a
stable top-right location while eliminating the duplicate and wasted row.

**Settings: dialog vs. dedicated screen.** Settings remains a compact modal with
five stable sections. A dedicated route would add navigation state that must
interact with repository selection and persisted UI state without improving the
current set-once preference workflow. The utility-bar entry point stays
independent of that future choice.

**Metrics: compact line vs. keeping the metric cards.** Cards are scannable but
consume ~90 px of vertical space above the content on every workspace, for three
numbers that are usually `12 / 0 / 0`. The line is chosen because it is the same
information at a tenth of the cost and, unlike the cards, it can become
interactive filters without adding chrome.

**Shortcuts: one palette vs. palette + switcher.** One palette is less to learn.
It is also the reason the current palette needs a "kind" column and still ranks a
branch name against a bulk action. Two surfaces are chosen because the two
questions have different ranking rules (recency for navigation, relevance for
actions) and different result shapes.

**UI state storage: SQLite vs. `localStorage`.** See §5 — durability and one
owner.

## Performance considerations

- `ShellUtilities` and the toolbar are static structure; they must not subscribe to
  repository queries. Counters in the left zone read the already-subscribed status
  query, not a new one.
- Persisted UI state is read once at startup, from the same bootstrap round trip
  as settings, and must not add a round trip to the startup path
  ([`performance.md`](performance.md) §8: nothing blocks first paint).
- Writes are debounced (resize end, 500 ms for selection) so dragging a splitter
  produces one write, not one per pointer move.
- The summary line replaces three `Metric` components and removes their layout
  cost from every Overview render.
- The shortcut registry attaches exactly one `keydown` listener at the document
  level and dispatches by scope; per-component listeners are removed.

## Security / safety

- No new IPC surface beyond `get_ui_state` / `update_ui_state`, which carry ids,
  numbers, and enum values only — no paths, no repository content.
- A restored selection is validated against the current store before use.
- Shortcuts must not bind destructive actions without confirmation; no binding in
  this spec triggers a Git mutation directly except commit, which requires staged
  content and a message. Destructive actions are reachable through the palette,
  and their confirmation dialogs (Phase 9) still apply.

## Testing strategy

| Level | Coverage |
|---|---|
| Unit | Shortcut registry: scope resolution, duplicate detection, layout-independent matching, input-field suppression. UI-state patch merge and version rejection. |
| Frontend/component | Sidebar renders without branding and starts at navigation; the shared utility slot is present in all three headers with exactly one Search and one Settings; toolbar zones render the specified actions without duplicate Search and overflow contains the rest; summary line omits zero segments; disabled actions expose a reason. |
| Integration | `get_ui_state`/`update_ui_state` round-trip through the store; a removed workspace in a restored selection falls back cleanly. |
| E2E | Restart restores sidebar width, pane widths, collapsed workspaces, and the last selected repository. `Ctrl/Cmd+K` and `Ctrl/Cmd+P` open their respective surfaces and contain the expected item kinds. |
| Accessibility | Automated axe pass on each screen; a manual check that dirty/ahead/behind/conflict remain distinguishable in a grayscale screenshot. |
| i18n | `npm run check-i18n` green for all five locales after every task in this phase. |

## Acceptance criteria

1. No Fjord logo or wordmark appears anywhere in the working shell; both remain in
   onboarding and About, and the app title remains in the OS window title.
2. The sidebar's first interactive element is a navigation item.
3. Exactly one Search and one Settings control appear in the trailing utility
   slot of the Overview, All repositories, and Repository headers; Settings is
   not present in the sidebar, and their registered shortcuts remain available.
4. The repository toolbar center zone contains at most five actions, all of which
   are Fetch, Pull, Push, Branch, or a documented successor; Stash, Stash pop,
   Terminal, and Merge tool are reachable only from the overflow menu, except when
   an operation-state banner promotes one. (`P10-STASH-06` removes Stash pop from
   the overflow entirely, per §2; the criterion is that it is never a center-zone
   action, which stays true.)
5. The Overview header contains at most four workspace controls, one of which is
   an overflow menu, plus the two globally-owned utility controls after a visual
   separator.
6. The Overview summary line renders as a single text line, omits zero-valued
   segments, and its "needs attention" and "behind" segments toggle the same
   persisted filter set as the six compact health chips shared with All
   Repositories. Health filters compose with OR; All Repositories text search is
   ANDed with that health result.
7. No component renders a bordered card inside another bordered card; verified by
   a component test asserting one border level per surface in Overview and the
   repository screen.
8. After a restart, the app restores sidebar width, tree width, inspector width,
   collapsed workspaces, last selected workspace and repository, and diff mode.
9. Restoring a selection whose workspace or repository no longer exists opens the
   default view without an error dialog.
10. Every action listed in §6 is triggerable by its binding on a Latin and on a
    Cyrillic keyboard layout, and appears in the `?` help sheet with a localized
    label generated from the registry.
11. Dirty, ahead, behind, and conflict states are each distinguishable in a
    grayscale rendering of the Overview and repository screens.
12. `npm run check-i18n` passes for all five shipped locales with no missing or
    orphaned keys.
13. Every context menu in the app opens from `Shift+F10` and the Context Menu key
    on the focused row with the same payload as right-click, keeps its target's
    logical identity across virtualized scrolling, and restores focus on Escape.
