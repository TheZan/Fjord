# P5-26 frontend test implementation plan

## Strategy

Use one Research -> Plan -> Implement pass split into four sequential phases. Each phase adds deterministic Vitest/Testing Library unit tests with mocked IPC, translation, virtualization, and browser-only observers as required. Production files remain unchanged unless a behavior proves unobservable (none are currently expected).

## Phase 1 — query contracts and worker transport

Files:

- Add `src/application/useCommitSearch.test.tsx`.
- Add `src/application/warmRepositoryData.test.ts`.
- Add `src/presentation/graphLayout.worker.test.ts`.

Cases:

- `useCommitSearch`: disabled null/blank cases; trimmed enabled query; limit 120 and abort signal; returned data/loading/error mapping.
- `warmRepositoryData`: exact five query keys; shared stale/gc policies; query functions and signal forwarding; commit pagination/page size/next cursor.
- graph worker: handler installation; reset response; append using cached state; request IDs/count/incremental flags/duration and postMessage behavior.

Verify:

`npm test -- src/application/useCommitSearch.test.tsx src/application/warmRepositoryData.test.ts src/presentation/graphLayout.worker.test.ts`

## Phase 2 — command palette and repository tree

Files:

- Add `src/presentation/CommandPalette.test.tsx` (including `useCommandPaletteState` cases, or use a separate `useCommandPaletteState.test.tsx` when clearer).
- Add `src/presentation/RepoTree.test.tsx`.
- Add `src/presentation/RepoDetailContainer.test.tsx` for the remote-checkout confirmation boundary exposed by `RepoTree`.

Cases:

- Palette scoring/ranking: direct match before subsequence, non-match exclusion, remote-result merge and result cap.
- Palette interaction: arrow navigation with boundary clamp/reset, Enter close-then-run, click/mouse selection, Escape/backdrop close.
- Palette state: physical Ctrl/Cmd+K open/reset, 200-ms debounce, minimum query length, IPC arguments, commit-only mapping, stale/rejected search handling, remote-item dispatch.
- RepoTree: local/remote/tag grouping and remote HEAD suppression, expansion, case-insensitive filtering/clear/count, click/double-click/Ctrl+Enter behavior, focus navigation, and branch/tag context action dispatch.
- RepoDetailContainer: an `origin/*` checkout opens confirmation and does not call the backend until confirmation.

Verify:

`npm test -- src/presentation/CommandPalette.test.tsx src/presentation/useCommandPaletteState.test.tsx src/presentation/RepoTree.test.tsx`

## Phase 3 — changes, diff, and toolbar

Files:

- Add `src/presentation/WorkingChangesPanel.test.tsx`.
- Extend `src/presentation/FileDiffView.test.tsx`.
- Add `src/presentation/RepoToolbar.test.tsx`.

Cases:

- WorkingChangesPanel: staged/unstaged sections, select payload, bulk and per-file paths, busy/unvalidated gating, trimmed summary/description composition, successful clear, failed retention, keyboard submit.
- FileDiffView: hunk and +/- line output through virtualization, back action, binary/too-large/empty/error states, and existing incremental-window trigger.
- RepoToolbar: validation/pending availability matrix, dirty/stash gates and action dispatch, branch name trimming/blank behavior, search/inspector availability, progress clamping and cancellation.

Verify:

`npm test -- src/presentation/WorkingChangesPanel.test.tsx src/presentation/FileDiffView.test.tsx src/presentation/RepoToolbar.test.tsx`

## Phase 4 — shell navigation and overview virtualization

Files:

- Add `src/presentation/Sidebar.test.tsx`.
- Add `src/presentation/OverviewView.test.tsx`.

Cases:

- Sidebar: selected-workspace auto-expansion and explicit collapse, repository select/warm callbacks and status, workspace create/rename/menu actions, drag reorder target dispatch and self-drop protection.
- Overview: metrics/empty state, action availability and pending labels, bulk dispatch/progress/cancel, import/open callbacks, deterministic 1/2/3-column grouping, virtual-row rendering, card select/warm/remove callback plumbing.

Verify:

`npm test -- src/presentation/Sidebar.test.tsx src/presentation/OverviewView.test.tsx`

## Final validation and coverage-gap audit

1. Confirm every explicitly named P5-26 source has a direct test file or direct test block.
2. Run `npm test` from the workspace root.
3. Run `npm run build` from the workspace root.
4. Fix incorrect expectations by rereading production behavior; do not skip tests.
5. Report any pre-existing failures separately and enumerate all changed files and covered behaviors.
