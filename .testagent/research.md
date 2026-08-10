# P5-26 frontend test research

## Request and strategy

P5-26 requires behavioral Vitest coverage for ten frontend subsystems. The scope is broad but bounded to the explicitly named modules, so a single Research -> Plan -> Implement pass is appropriate. Existing unrelated worktree changes must be preserved; the worktree was clean at the start of this task.

## Toolchain and conventions

- TypeScript 7, React 19, Vite 8, Vitest 4, jsdom, React Testing Library, and `@testing-library/jest-dom`.
- Tests live beside production files as `*.test.ts` / `*.test.tsx` and import through the `@/` alias.
- `src/test/setup.ts` installs jest-dom and calls Testing Library cleanup after every test.
- Component tests mock `react-i18next` with a deterministic key-returning `t` function. Virtualized components mock `@tanstack/react-virtual` so jsdom renders deterministic virtual rows.
- Hook tests use `renderHook`; React Query hooks use a fresh `QueryClient`/`QueryClientProvider` with retries disabled.
- External Tauri/IPC reads are mocked. Tests must not call networks, bind ports, or rely on wall-clock timing.
- Scoped command: `npm test -- <test-file ...>`. Full validation: `npm test`, then `npm run build` (`tsc && vite build`).

## Production surfaces and behavior to cover

### `src/presentation/RepoTree.tsx`

- Data comes from `useBranches(repoId)` and `useTags(repoId)`.
- Local branches are expanded initially; remote branches and tags are collapsed.
- Filters case-insensitively, hides remote `HEAD` aliases, reports match counts, and clears filtering.
- Branch rows select on click, checkout on double click or Ctrl+Enter, and expose branch-specific context actions; tag rows expose tag actions.
- Arrow/Home/End keyboard handling moves focus between visible `[data-tree-item]` rows.
- Virtualized lists require a deterministic virtualizer mock.

### `src/presentation/WorkingChangesPanel.tsx`

- Splits unstaged and staged files, maps bulk actions to all paths, and maps per-file actions to one path.
- A selected file carries both path and staged state.
- Commit is enabled only for validated data, a non-empty trimmed summary, staged files, and no busy mutation.
- Commit message trims summary/description and joins them with a blank line; successful commits clear fields, failed commits retain them.
- `RepositorySnapshotUI.test.tsx` only covers validation gating, so a dedicated behavior test remains necessary.

### `src/presentation/FileDiffView.tsx`

- Existing `FileDiffView.test.tsx` only checks near-end window loading.
- Must additionally cover hunk/line rendering (line numbers and +/- prefixes), optional back action, binary state, oversized-file state, empty diff state, and no virtual line rows for non-text states.
- `useFileDiff` and virtualizer are already mocked in the existing test and can be extended into mutable state.

### `src/presentation/CommandPalette.tsx`

- `paletteScore` implements direct substring ranking, subsequence fallback, case folding, empty query, and non-match.
- Local items are scored/sorted, backend `remoteItems` are appended, and the combined list is capped at 12.
- Keyboard navigation clamps at bounds, resets on query change, Enter runs the selected item after closing, and Escape/backdrop close without running.

### `src/presentation/useCommandPaletteState.ts`

- Ctrl/Cmd+physical KeyK opens and clears the palette.
- Backend search is debounced 200 ms, requires an open palette and at least two trimmed characters, and requests 20 global results.
- Only commit results become remote items; labels/details derive from the first commit-message line, repository name, and short SHA.
- Results from cancelled/stale requests and rejected searches must not populate items; running a remote item dispatches the original result.

### `src/presentation/RepoToolbar.tsx`

- `useStashes` controls pop availability/count.
- Mutating Git actions are blocked while data is unvalidated or any action is pending; terminal/IDE are only blocked by a pending action; search/inspector remain available.
- Stash requires dirty work; pop requires at least one stash.
- Pending action state is visible via disabled controls/label/icon state.
- Branch creation trims the name and closes/reset the popover; blank submission does not dispatch.
- Operation progress clamps the bar to 100% and cancel dispatches.

### `src/presentation/Sidebar.tsx`

- The selected workspace auto-expands and renders repository status; explicit expand/collapse controls toggle children.
- Repository hover/focus warms data and click selects with workspace/repository IDs.
- Workspace creation/rename/menu movement/delete dispatch through controlled inputs.
- Native drag events set the source, accept another workspace as the target, and call `onMoveWorkspaceTo(source, target)`; self-drop must not dispatch.

### `src/presentation/OverviewView.tsx`

- Renders the supplied metrics and workspace/empty state.
- Bulk actions reflect pending state and dispatch correct action; import/open availability follows workspace/pending state.
- Bulk progress computes a clamped percentage and cancel dispatches.
- `VirtualRepoGrid` chooses 1/2/3 columns from measured width, groups repositories into rows, and renders only rows returned by the virtualizer.
- `ResizeObserver`, `clientWidth`, virtualizer, and preferably `RepoCard` should be mocked for deterministic behavior and callback assertions.

### `src/application/useCommitSearch.ts`

- Query is disabled for null repository or blank trimmed text.
- Enabled searches use the trimmed query, fixed limit 120, abort signal, exact query key, and 30-second staleness.
- Return mapping covers data/default empty, fetching state, and stringified error.

### `src/application/warmRepositoryData.ts`

- Prefetches exactly status, branches, tags, first commit page, and working changes for one repository.
- Every query applies repository stale/gc policy and forwards the Query Function signal to the IPC wrapper.
- History uses an infinite query with `initialPageParam: null`, the shared page size, and `lastPage.nextCursor`.

### `src/presentation/graphLayout.worker.ts`

- Module import installs `self.onmessage`.
- Reset replaces cached commits/layout and reports `incremental: false`.
- Append continues from cached graph state, concatenates rows/commits, and reports `incremental: true` plus total commit count.
- Response echoes request ID and reports duration from `performance.now`.
- Test via isolated/dynamic module imports with mocked `self`, `performance.now`, and (to focus on transport) `computeGraphLayoutChunk`.

## Existing supporting tests

- `graphLayout.test.ts` covers the layout algorithm but not worker messaging.
- `FileEntryList.test.tsx` and `fileTree.test.ts` cover list/tree helpers, not panel composition.
- `GitContextMenu.test.tsx` covers generic menu navigation, not RepoTree dispatch.
- `RepoCard.test.tsx` covers a single card, not Overview grid behavior.
- `RepositorySnapshotUI.test.tsx` covers one WorkingChangesPanel validation gate only.
- `useRepositories.test.tsx` indirectly warms repositories but does not assert `warmRepositoryData` query contracts.

## Testability assessment

All requested behavior can be observed through public props/hooks, DOM interaction, React Query, and module-level worker transport. No production-code changes are expected.
