import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { userErrorMessage } from "@/application/errorMessage";
import { useBranches } from "@/application/useBranches";
import { useOperationProgress } from "@/application/useOperationProgress";
import { useRepositoryChangeEvents } from "@/application/useRepositoryChangeEvents";
import { queryKeys } from "@/application/queryKeys";
import { useRepositories } from "@/application/useRepositories";
import { warmRepositoryData } from "@/application/warmRepositoryData";
import type { GlobalSearchResult } from "@/domain/git";
import type { BulkRepoResult } from "@/domain/workspace";
import {
  bulkOpenInIde,
  cancelOperation,
  getSettings,
  invokeErrorCode,
  runBulkFetch,
  runBulkPull,
  type OperationProgressEvent,
  type OperationTask,
} from "@/infrastructure/tauriClient";
import { AllReposView } from "@/presentation/AllReposView";
import { CommandPalette, type PaletteItem } from "@/presentation/CommandPalette";
import { ErrorBoundary } from "@/presentation/ErrorBoundary";
import { Onboarding } from "@/presentation/Onboarding";
import { OverviewView } from "@/presentation/OverviewView";
import {
  RepoDetailContainer,
  type RepoDetailCommand,
  type RepoDetailCommandPayload,
} from "@/presentation/RepoDetailContainer";
import { SettingsDialog } from "@/presentation/SettingsDialog";
import { Sidebar } from "@/presentation/Sidebar";
import { Button } from "@/presentation/ui";
import { useCommandPaletteState } from "@/presentation/useCommandPaletteState";
import type { View } from "@/presentation/view";

/**
 * Owns app-level state and wires the screens together. Layout and styling
 * live in the view components — this file deliberately holds no markup
 * beyond the shell, after it grew to ~1200 lines of inline JSX with every
 * feature stacked onto a single scrolling page.
 */
export function App() {
  const queryClient = useQueryClient();
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
    clearError,
    selectWorkspace,
    createWorkspace,
    renameWorkspace,
    deleteWorkspace,
    moveWorkspace,
    moveWorkspaceTo,
    openRepository,
    importRepositories,
    removeRepository,
  } = useRepositories();

  const operations = useOperationProgress();
  const [view, setView] = useState<View>("overview");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [repoFilter, setRepoFilter] = useState("");
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
  const [repoDetailCommand, setRepoDetailCommand] = useState<RepoDetailCommand | null>(null);
  const [, setRepoDetailCommandId] = useState(0);
  const [bulkActionPending, setBulkActionPending] = useState<string | null>(null);
  const [bulkActionNotice, setBulkActionNotice] = useState<string | null>(null);
  const [bulkOperationId, setBulkOperationId] = useState<string | null>(null);
  const [autoFetch, setAutoFetch] = useState(false);
  const repositoryWarmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const {
    closePalette,
    open: paletteOpen,
    openPalette,
    query: paletteQuery,
    remoteItems: remotePaletteItems,
    setQuery: setPaletteQuery,
  } = useCommandPaletteState({ onSearchResult: (result) => void openSearchResult(result) });
  const { branches: paletteBranches } = useBranches(paletteOpen ? selectedRepoId : null);

  const allRepositories = useMemo(
    () => Object.values(repositoriesByWorkspace).flat(),
    [repositoriesByWorkspace],
  );
  useRepositoryChangeEvents(allRepositories);
  const selectedRepo = allRepositories.find((repo) => repo.id === selectedRepoId) ?? null;
  const workspaceRepos = selectedWorkspaceId ? (repositoriesByWorkspace[selectedWorkspaceId] ?? []) : [];
  const isFirstRun = !loading && workspaces.length === 0;
  const activeBulkOperation = bulkOperationId ? (operations[bulkOperationId] ?? null) : null;

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
    let mounted = true;
    void getSettings()
      .then((settings) => {
        if (mounted) setAutoFetch(settings.autoFetch);
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (selectedRepoId && !allRepositories.some((repo) => repo.id === selectedRepoId)) {
      setSelectedRepoId(null);
      setRepoDetailCommand(null);
    }
  }, [allRepositories, selectedRepoId]);

  useEffect(
    () => () => {
      if (repositoryWarmTimerRef.current) clearTimeout(repositoryWarmTimerRef.current);
    },
    [],
  );

  async function runBulkAction(
    action: string,
    run: () => OperationTask<BulkRepoResult[]> | Promise<BulkRepoResult[]>,
  ) {
    setBulkActionNotice(null);
    setBulkActionPending(action);
    setBulkOperationId(null);
    try {
      const started = run();
      const promise = "operationId" in started ? started.promise : started;
      if ("operationId" in started) setBulkOperationId(started.operationId);
      const results = await promise;
      const failed = results.filter((result) => !result.ok).length;
      setBulkActionNotice(tw("bulk.summary", { succeeded: results.length - failed, failed }));
      if (selectedWorkspaceId) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.status(selectedWorkspaceId) }),
          ...workspaceRepos.map((repo) =>
            queryClient.invalidateQueries({ queryKey: queryKeys.repos.detail(repo.id) }),
          ),
        ]);
      }
    } catch (e) {
      setBulkActionNotice(
        invokeErrorCode(e) === "operation_cancelled"
          ? tw("operations.cancelled")
          : userErrorMessage(e),
      );
    } finally {
      setBulkActionPending(null);
      setBulkOperationId(null);
    }
  }

  function onBulk(action: "fetch" | "pull" | "open-ide") {
    if (!selectedWorkspaceId) return;
    if (action === "fetch") {
      void runBulkAction(action, () => runBulkFetch(selectedWorkspaceId));
      return;
    }
    if (action === "pull") {
      void runBulkAction(action, () => runBulkPull(selectedWorkspaceId));
      return;
    }
    void runBulkAction(action, () => bulkOpenInIde(selectedWorkspaceId));
  }

  function sendRepoDetailCommand(command: RepoDetailCommandPayload) {
    setRepoDetailCommandId((id) => {
      const nextId = id + 1;
      setRepoDetailCommand({ ...command, id: nextId });
      return nextId;
    });
  }

  function startRepositoryWarm(repoId: string) {
    if (repositoryWarmTimerRef.current) clearTimeout(repositoryWarmTimerRef.current);
    repositoryWarmTimerRef.current = null;
    void warmRepositoryData(queryClient, repoId);
  }

  function queueRepositoryWarm(repoId: string) {
    if (repositoryWarmTimerRef.current) clearTimeout(repositoryWarmTimerRef.current);
    repositoryWarmTimerRef.current = setTimeout(() => {
      startRepositoryWarm(repoId);
    }, 80);
  }

  async function selectRepository(workspaceId: string, repoId: string) {
    setRepoDetailCommand(null);
    startRepositoryWarm(repoId);
    if (workspaceId !== selectedWorkspaceId) await selectWorkspace(workspaceId);
    setSelectedRepoId(repoId);
  }

  async function openSearchResult(result: GlobalSearchResult) {
    await selectRepository(result.workspaceId, result.repoId);
    if (result.kind === "branch" && result.branch) {
      sendRepoDetailCommand({ kind: "checkout", branch: result.branch });
    } else if (result.kind === "commit" && result.commit) {
      sendRepoDetailCommand({ kind: "selectCommit", commit: result.commit });
    }
  }

  const paletteItems: PaletteItem[] = [
    {
      id: "settings:open",
      label: tw("settings.openCommand"),
      detail: tw("settings.openCommandDetail"),
      kind: tw("commandPalette.action"),
      run: () => setSettingsOpen(true),
    },
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
          run: () => sendRepoDetailCommand({ kind: "repoAction", action }),
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
          ? sendRepoDetailCommand({ kind: "checkout", branch: branch.name })
          : undefined,
    })),
  ];

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
          setRepoDetailCommand(null);
        }}
        workspaces={workspaces}
        repositoriesByWorkspace={repositoriesByWorkspace}
        statusByRepo={statusByRepo}
        repoCountByWorkspace={repoCountByWorkspace}
        attentionByWorkspace={attentionByWorkspace}
        selectedWorkspaceId={selectedWorkspaceId}
        selectedRepoId={selectedRepoId}
        onSelectWorkspace={(id) => {
          void selectWorkspace(id);
          setSelectedRepoId(null);
          setRepoDetailCommand(null);
          setView("overview");
        }}
        onCreateWorkspace={(name) => void createWorkspace(name)}
        onRenameWorkspace={(id, name) => void renameWorkspace(id, name)}
        onDeleteWorkspace={(id) => void deleteWorkspace(id)}
        onMoveWorkspace={(id, direction) => void moveWorkspace(id, direction)}
        onMoveWorkspaceTo={(id, targetId) => void moveWorkspaceTo(id, targetId)}
        onSelectRepository={(workspaceId, repoId) => void selectRepository(workspaceId, repoId)}
        onWarmRepository={queueRepositoryWarm}
        pending={workspaceActionPending}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <main className="flex min-w-0 flex-1 flex-col overflow-y-auto p-6">
        {(error || bulkActionNotice) && (
          <div
            role={error ? "alert" : "status"}
            className="mb-4 flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-[13px]"
            style={{
              background: error ? "var(--rust-tint)" : "var(--paper)",
              borderColor: error ? "var(--rust)" : "var(--hairline)",
              color: error ? "var(--rust-ink)" : "var(--slate)",
            }}
          >
            <span>{error ?? bulkActionNotice}</span>
            <Button
              size="sm"
              variant="ghost"
              aria-label={tw("notifications.close")}
              onClick={error ? clearError : () => setBulkActionNotice(null)}
            >
              ✕
            </Button>
          </div>
        )}

        <ErrorBoundary key={selectedRepo ? `repo:${selectedRepo.id}` : `view:${view}`}>
        {selectedRepo ? (
          <RepoDetailContainer
            repo={selectedRepo}
            autoFetch={autoFetch}
            command={repoDetailCommand}
            onBack={() => {
              setSelectedRepoId(null);
              setRepoDetailCommand(null);
            }}
            onOpenSearch={openPalette}
          />
        ) : view === "overview" ? (
          <OverviewView
            workspace={selectedWorkspace}
            repositories={workspaceRepos}
            statusByRepo={statusByRepo}
            selectedRepoId={selectedRepoId}
            metrics={metrics}
            bulkPending={bulkActionPending}
            bulkProgress={toBulkProgress(activeBulkOperation)}
            onCancelBulk={() => {
              if (bulkOperationId) void cancelOperation(bulkOperationId);
            }}
            onBulk={onBulk}
            onOpenRepository={openRepository}
            onImport={() => void importRepositories()}
            importPending={workspaceActionPending === "import"}
            onSelectRepo={(repoId) =>
              selectedWorkspaceId ? void selectRepository(selectedWorkspaceId, repoId) : undefined
            }
            onWarmRepo={queueRepositoryWarm}
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
            onWarm={(_workspaceId, repoId) => queueRepositoryWarm(repoId)}
          />
        )}
        </ErrorBoundary>
      </main>

      {paletteOpen && (
        <CommandPalette
          items={paletteItems}
          remoteItems={remotePaletteItems}
          query={paletteQuery}
          onQueryChange={setPaletteQuery}
          onClose={closePalette}
        />
      )}

      {settingsOpen && (
        <SettingsDialog
          onClose={() => setSettingsOpen(false)}
          onSettingsChange={(settings) => setAutoFetch(settings.autoFetch)}
        />
      )}
    </div>
  );
}

function toBulkProgress(event: OperationProgressEvent | null) {
  if (!event) return null;
  return {
    completed: event.completed,
    total: event.total,
    error: event.error,
    status: event.status,
  };
}
