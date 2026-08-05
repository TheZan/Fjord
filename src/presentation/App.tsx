import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useBranches } from "@/application/useBranches";
import { useRepositories } from "@/application/useRepositories";
import { useRepoStatus } from "@/application/useRepoStatus";
import type { CommitSummary, GlobalSearchResult } from "@/domain/git";
import {
  bulkFetch,
  bulkOpenInIde,
  bulkPull,
  checkoutBranch,
  commitRepo,
  createBranch,
  fetchRepo,
  globalSearch,
  invokeErrorMessage,
  openInIde,
  openMergeTool,
  openTerminal,
  pullRepo,
  pushRepo,
  stageFiles,
  stashPop,
  stashPush,
  unstageFiles,
} from "@/infrastructure/tauriClient";
import { AllReposView } from "@/presentation/AllReposView";
import { CommandPalette, type PaletteItem } from "@/presentation/CommandPalette";
import { Onboarding } from "@/presentation/Onboarding";
import { OverviewView } from "@/presentation/OverviewView";
import { RepoDetailView } from "@/presentation/RepoDetailView";
import type { RepoAction } from "@/presentation/RepoToolbar";
import { SettingsDialog } from "@/presentation/SettingsDialog";
import { Sidebar } from "@/presentation/Sidebar";
import { Button } from "@/presentation/ui";
import type { View } from "@/presentation/view";

/**
 * Owns app-level state and wires the screens together. Layout and styling
 * live in the view components — this file deliberately holds no markup
 * beyond the shell, after it grew to ~1200 lines of inline JSX with every
 * feature stacked onto a single scrolling page.
 */
export function App() {
  const { t: tw } = useTranslation("workspace");
  const {
    workspaces,
    selectedWorkspace,
    selectedWorkspaceId,
    repositoriesByWorkspace,
    statusByRepo,
    loading,
    error,
    workspaceActionPending,
    selectWorkspace,
    createWorkspace,
    renameWorkspace,
    deleteWorkspace,
    moveWorkspace,
    openRepository,
    importRepositories,
    removeRepository,
  } = useRepositories();

  const [view, setView] = useState<View>("overview");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [repoFilter, setRepoFilter] = useState("");
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
  const [selectedCommit, setSelectedCommit] = useState<CommitSummary | null>(null);
  // The WIP row and a commit are alternate selections of the same middle
  // pane, so they're kept mutually exclusive rather than both being live.
  const [workingSelected, setWorkingSelected] = useState(false);
  const [repoVersion, setRepoVersion] = useState(0);
  const [repoActionError, setRepoActionError] = useState<string | null>(null);
  const [repoActionPending, setRepoActionPending] = useState<string | null>(null);
  const [bulkActionPending, setBulkActionPending] = useState<string | null>(null);
  const [bulkActionNotice, setBulkActionNotice] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [searchResults, setSearchResults] = useState<GlobalSearchResult[]>([]);

  const { status: repoStatus, error: repoStatusError } = useRepoStatus(selectedRepoId, repoVersion);
  const { branches: paletteBranches } = useBranches(paletteOpen ? selectedRepoId : null);

  const allRepositories = useMemo(
    () => Object.values(repositoriesByWorkspace).flat(),
    [repositoriesByWorkspace],
  );
  const selectedRepo = allRepositories.find((repo) => repo.id === selectedRepoId) ?? null;
  const workspaceRepos = selectedWorkspaceId ? (repositoriesByWorkspace[selectedWorkspaceId] ?? []) : [];
  const isFirstRun = !loading && workspaces.length === 0;

  const flatRows = workspaces.flatMap((workspace) =>
    (repositoriesByWorkspace[workspace.id] ?? []).map((repo) => ({ workspace, repo })),
  );

  const needsAttention = (repoId: string) => {
    const status = statusByRepo[repoId]?.status;
    return Boolean(status?.hasConflict || status?.dirtyCount || status?.ahead || status?.behind);
  };

  const metrics = {
    total: workspaceRepos.length,
    attention: workspaceRepos.filter((repo) => needsAttention(repo.id)).length,
    behind: workspaceRepos.filter((repo) => (statusByRepo[repo.id]?.status.behind ?? 0) > 0).length,
  };

  const repoCountByWorkspace = Object.fromEntries(
    workspaces.map((workspace) => [workspace.id, (repositoriesByWorkspace[workspace.id] ?? []).length]),
  );
  const attentionByWorkspace = Object.fromEntries(
    workspaces.map((workspace) => [
      workspace.id,
      (repositoriesByWorkspace[workspace.id] ?? []).filter((repo) => needsAttention(repo.id)).length,
    ]),
  );

  const normalizedFilter = repoFilter.trim().toLocaleLowerCase();
  const filteredRows = flatRows.filter(({ workspace, repo }) =>
    !normalizedFilter
      ? true
      : [repo.name, repo.path, workspace.name].some((value) =>
          value.toLocaleLowerCase().includes(normalizedFilter),
        ),
  );

  useEffect(() => {
    if (selectedRepoId && !allRepositories.some((repo) => repo.id === selectedRepoId)) {
      setSelectedRepoId(null);
      setSelectedCommit(null);
    }
  }, [allRepositories, selectedRepoId]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        setPaletteQuery("");
        setPaletteOpen(true);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Global search now runs through the palette instead of a separate card on
  // the dashboard — two always-visible search fields on one screen was one of
  // the things making it feel cluttered.
  useEffect(() => {
    const query = paletteQuery.trim();
    if (!paletteOpen || query.length < 2) {
      setSearchResults([]);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      globalSearch(query, null, 20)
        .then((results) => {
          if (!cancelled) setSearchResults(results);
        })
        .catch(() => {
          if (!cancelled) setSearchResults([]);
        });
    }, 200);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [paletteQuery, paletteOpen]);

  /**
   * `mutates` distinguishes actions that change the repository from ones that
   * merely launch something external — opening a terminal or an IDE used to
   * clear the selected commit and close an open diff for no reason.
   */
  async function runRepoAction(
    action: string,
    run: () => Promise<void>,
    mutates = true,
  ): Promise<boolean> {
    setRepoActionError(null);
    setRepoActionPending(action);
    try {
      await run();
      if (mutates) {
        setSelectedCommit(null);
        setRepoVersion((version) => version + 1);
      }
      return true;
    } catch (e) {
      setRepoActionError(invokeErrorMessage(e));
      return false;
    } finally {
      setRepoActionPending(null);
    }
  }

  /**
   * Staging changes what the commit panel shows but not which history entry
   * is open, so unlike the other mutations these keep the WIP row selected.
   */
  function runWorkingAction(action: string, run: () => Promise<void>): Promise<boolean> {
    return runRepoAction(action, run, false).then((ok) => {
      if (ok) setRepoVersion((version) => version + 1);
      return ok;
    });
  }

  async function runBulkAction(
    action: string,
    run: () => Promise<Array<{ ok: boolean; error: string | null }>>,
  ) {
    setBulkActionNotice(null);
    setBulkActionPending(action);
    try {
      const results = await run();
      const failed = results.filter((result) => !result.ok).length;
      setBulkActionNotice(tw("bulk.summary", { succeeded: results.length - failed, failed }));
      setRepoVersion((version) => version + 1);
    } catch (e) {
      setBulkActionNotice(invokeErrorMessage(e));
    } finally {
      setBulkActionPending(null);
    }
  }

  function onBulk(action: "fetch" | "pull" | "open-ide") {
    if (!selectedWorkspaceId) return;
    const runner =
      action === "fetch" ? bulkFetch : action === "pull" ? bulkPull : bulkOpenInIde;
    void runBulkAction(action, () => runner(selectedWorkspaceId));
  }

  function onRepoAction(action: RepoAction) {
    if (!selectedRepoId) return;
    const id = selectedRepoId;
    const runners: Record<RepoAction, () => Promise<void>> = {
      fetch: () => fetchRepo(id),
      pull: () => pullRepo(id),
      push: () => pushRepo(id),
      stash: () => stashPush(id),
      "stash-pop": () => stashPop(id),
      terminal: () => openTerminal(id),
      "open-ide": () => openInIde(id),
      "merge-tool": () => openMergeTool(id),
    };
    const launchesExternalTool = action === "terminal" || action === "open-ide";
    void runRepoAction(action, runners[action], !launchesExternalTool);
  }

  function onCreateBranch(name: string) {
    if (!selectedRepoId) return;
    const id = selectedRepoId;
    void runRepoAction("create-branch", () => createBranch(id, name, true));
  }

  function onStage(paths: string[]) {
    if (!selectedRepoId) return;
    const id = selectedRepoId;
    void runWorkingAction("stage", () => stageFiles(id, paths));
  }

  function onUnstage(paths: string[]) {
    if (!selectedRepoId) return;
    const id = selectedRepoId;
    void runWorkingAction("unstage", () => unstageFiles(id, paths));
  }

  async function onCommit(message: string): Promise<boolean> {
    if (!selectedRepoId) return false;
    const id = selectedRepoId;
    return runWorkingAction("commit", () => commitRepo(id, message).then(() => undefined));
  }

  async function selectRepository(workspaceId: string, repoId: string) {
    if (workspaceId !== selectedWorkspaceId) await selectWorkspace(workspaceId);
    setSelectedRepoId(repoId);
    setSelectedCommit(null);
    setWorkingSelected(false);
  }

  function selectCommit(commit: CommitSummary) {
    setWorkingSelected(false);
    setSelectedCommit((current) => (commit.id === current?.id ? null : commit));
  }

  async function openSearchResult(result: GlobalSearchResult) {
    await selectRepository(result.workspaceId, result.repoId);
    if (result.kind === "branch" && result.branch) {
      void runRepoAction("checkout", () => checkoutBranch(result.repoId, result.branch!));
    } else if (result.kind === "commit" && result.commit) {
      setWorkingSelected(false);
      setSelectedCommit(result.commit);
    }
  }

  const paletteItems: PaletteItem[] = [
    ...flatRows.map(({ workspace, repo }) => ({
      id: `repo:${repo.id}`,
      label: repo.name,
      detail: `${workspace.name} · ${repo.path}`,
      kind: tw("commandPalette.repository"),
      run: () => selectRepository(workspace.id, repo.id),
    })),
    ...(selectedRepo
      ? (["open-ide", "fetch", "pull"] as const).map((action) => ({
          id: `action:${action}`,
          label: tw(action === "open-ide" ? "repoActions.openIde" : `repoActions.${action}`),
          detail: selectedRepo.name,
          kind: tw("commandPalette.action"),
          run: () => onRepoAction(action),
        }))
      : []),
    ...(selectedWorkspaceId
      ? (["fetch", "pull", "open-ide"] as const).map((action) => ({
          id: `bulk:${action}`,
          label: tw(action === "open-ide" ? "bulk.openIde" : `bulk.${action}`),
          detail: selectedWorkspace?.name ?? "",
          kind: tw("commandPalette.action"),
          run: () => onBulk(action),
        }))
      : []),
    ...paletteBranches.map((branch) => ({
      id: `branch:${branch.name}`,
      label: branch.name,
      detail: selectedRepo?.name ?? "",
      kind: branch.isRemote ? tw("commandPalette.remoteBranch") : tw("commandPalette.localBranch"),
      run: () =>
        selectedRepoId
          ? void runRepoAction("checkout", () => checkoutBranch(selectedRepoId, branch.name))
          : undefined,
    })),
  ];

  const remotePaletteItems: PaletteItem[] = searchResults
    .filter((result) => result.kind === "commit")
    .map((result, index) => ({
      id: `search:${result.repoId}:${result.commit?.id ?? index}`,
      label: result.commit?.message.split("\n")[0] ?? result.repoName,
      detail: `${result.repoName} · ${result.commit?.id.slice(0, 7) ?? ""}`,
      kind: tw("commandPalette.commit"),
      run: () => openSearchResult(result),
    }));

  if (isFirstRun) {
    return (
      <Onboarding
        onCreate={async (name, withImport) => {
          const created = await createWorkspace(name || tw("onboarding.defaultWorkspaceName"));
          if (created && withImport) await importRepositories(created.id);
        }}
      />
    );
  }

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: "var(--page-bg)", color: "var(--ink)" }}>
      <Sidebar
        view={view}
        onViewChange={(next) => {
          setView(next);
          setSelectedRepoId(null);
        }}
        workspaces={workspaces}
        repoCountByWorkspace={repoCountByWorkspace}
        attentionByWorkspace={attentionByWorkspace}
        selectedWorkspaceId={selectedWorkspaceId}
        onSelectWorkspace={(id) => {
          void selectWorkspace(id);
          setSelectedRepoId(null);
          setView("overview");
        }}
        onCreateWorkspace={(name) => void createWorkspace(name)}
        onRenameWorkspace={(id, name) => void renameWorkspace(id, name)}
        onDeleteWorkspace={(id) => void deleteWorkspace(id)}
        onMoveWorkspace={(id, direction) => void moveWorkspace(id, direction)}
        pending={workspaceActionPending}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <main className="flex min-w-0 flex-1 flex-col overflow-y-auto p-6">
        {(error || bulkActionNotice) && (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-[13px]"
            style={{ background: "var(--paper)", color: error ? "var(--rust-ink)" : "var(--slate)" }}
          >
            <span>{error ?? bulkActionNotice}</span>
            {bulkActionNotice && !error && (
              <Button size="sm" variant="ghost" onClick={() => setBulkActionNotice(null)}>
                ✕
              </Button>
            )}
          </div>
        )}

        {selectedRepo ? (
          <RepoDetailView
            repo={selectedRepo}
            status={repoStatus}
            statusError={repoStatusError}
            actionPending={repoActionPending}
            actionError={repoActionError}
            selectedCommit={selectedCommit}
            workingSelected={workingSelected}
            repoVersion={repoVersion}
            onBack={() => {
              setSelectedRepoId(null);
              setSelectedCommit(null);
              setWorkingSelected(false);
            }}
            onAction={onRepoAction}
            onCheckout={(branch) =>
              void runRepoAction("checkout", () => checkoutBranch(selectedRepo.id, branch))
            }
            onCreateBranch={onCreateBranch}
            onOpenSearch={() => {
              setPaletteQuery("");
              setPaletteOpen(true);
            }}
            onSelectCommit={selectCommit}
            onSelectWorking={() => {
              setSelectedCommit(null);
              setWorkingSelected(true);
            }}
            onStage={onStage}
            onUnstage={onUnstage}
            onCommit={onCommit}
          />
        ) : view === "overview" ? (
          <OverviewView
            workspace={selectedWorkspace}
            repositories={workspaceRepos}
            statusByRepo={statusByRepo}
            selectedRepoId={selectedRepoId}
            metrics={metrics}
            bulkPending={bulkActionPending}
            onBulk={onBulk}
            onOpenRepository={openRepository}
            onImport={() => void importRepositories()}
            importPending={workspaceActionPending === "import"}
            onSelectRepo={(repoId) =>
              selectedWorkspaceId ? void selectRepository(selectedWorkspaceId, repoId) : undefined
            }
            onRemoveRepo={(repoId) => void removeRepository(repoId)}
          />
        ) : (
          <AllReposView
            rows={filteredRows}
            statusByRepo={statusByRepo}
            selectedRepoId={selectedRepoId}
            filter={repoFilter}
            onFilterChange={setRepoFilter}
            onSelect={(workspaceId, repoId) => void selectRepository(workspaceId, repoId)}
          />
        )}
      </main>

      {paletteOpen && (
        <CommandPalette
          items={paletteItems}
          remoteItems={remotePaletteItems}
          query={paletteQuery}
          onQueryChange={setPaletteQuery}
          onClose={() => setPaletteOpen(false)}
        />
      )}

      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
