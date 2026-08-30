import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { createAppShortcutBindings } from "@/application/appShortcuts";
import { commandPaletteMergeBranches, mergeSourceForBranch } from "@/application/mergeBranchAction";
import { userErrorMessage } from "@/application/errorMessage";
import { useStartup } from "@/application/StartupProvider";
import { updateCoordinator } from "@/application/update/UpdateCoordinator";
import { useOperationProgress } from "@/application/useOperationProgress";
import { useGitAuthPrompts } from "@/application/useGitAuthPrompts";
import { useBranches } from "@/application/useBranches";
import { useRepositoryChangeEvents } from "@/application/useRepositoryChangeEvents";
import { queryKeys } from "@/application/queryKeys";
import { resolveRestoredSelection } from "@/application/uiSelection";
import { useRepositories } from "@/application/useRepositories";
import { useShortcutRegistry } from "@/application/useShortcutRegistry";
import { repoIsBehind, repoNeedsAttention } from "@/application/repoHealth";
import { warmRepositoryData } from "@/application/warmRepositoryData";
import type { GlobalSearchResult } from "@/domain/git";
import type { BulkRepoResult } from "@/domain/workspace";
import {
  bulkOpenInIde,
  cancelOperation,
  invokeErrorCode,
  runBulkFetch,
  runBulkPull,
  setRepositoryActivity,
  type OperationProgressEvent,
  type OperationTask,
} from "@/infrastructure/tauriClient";
import { loadUiState, saveSelection } from "@/infrastructure/uiState";
import { AllReposView } from "@/presentation/AllReposView";
import { CommandPalette, type PaletteItem } from "@/presentation/CommandPalette";
import { CloneRepositoryDialog } from "@/presentation/CloneRepositoryDialog";
import { CreateRepositoryDialog } from "@/presentation/CreateRepositoryDialog";
import { ErrorBoundary } from "@/presentation/ErrorBoundary";
import { GlobalSearchDialog } from "@/presentation/GlobalSearchDialog";
import { Onboarding } from "@/presentation/Onboarding";
import { OverviewView } from "@/presentation/OverviewView";
import {
  RepoDetailContainer,
  type RepoDetailCommand,
  type RepoDetailCommandPayload,
} from "@/presentation/RepoDetailContainer";
import { SettingsDialog } from "@/presentation/SettingsDialog";
import { ShortcutHelpSheet } from "@/presentation/ShortcutHelpSheet";
import { UpdateDialog } from "@/presentation/UpdateDialog";
import {
  setInteractionDiagnosticsEnabled,
  useInteractionCommit,
} from "@/presentation/performance";
import { GitAuthPromptDialog } from "@/presentation/GitAuthPromptDialog";
import { MainShell, ShellUtilities } from "@/presentation/MainShell";
import { ResizableSidebar } from "@/presentation/ResizableSidebar";
import { RepositorySwitcher, type RepositorySwitcherItem } from "@/presentation/RepositorySwitcher";
import { RepositoryOnboardingDialog } from "@/presentation/RepositoryOnboardingDialog";
import { Sidebar } from "@/presentation/Sidebar";
import { Button } from "@/presentation/ui";
import { useCommandPaletteState } from "@/presentation/useCommandPaletteState";
import type { View } from "@/presentation/view";

const UPDATE_STARTUP_CHECK_DELAY_MS = 4000;

/**
 * Owns app-level state and wires the screens together. Layout and styling
 * live in the view components — this file deliberately holds no markup
 * beyond the shell, after it grew to ~1200 lines of inline JSX with every
 * feature stacked onto a single scrolling page.
 */
export function App() {
  useInteractionCommit();
  const queryClient = useQueryClient();
  const { activated } = useStartup();
  const { t: tw } = useTranslation("workspace");
  const {
    workspaces,
    selectedWorkspace,
    selectedWorkspaceId,
    repositoriesByWorkspace,
    statusByRepo,
    healthByRepo,
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
    cloneRepository,
    createRepository,
    importRepositories,
    removeRepository,
  } = useRepositories();

  const operations = useOperationProgress();
  const gitAuth = useGitAuthPrompts();
  const [view, setView] = useState<View>("overview");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [repositoryOnboardingStep, setRepositoryOnboardingStep] = useState<
    "choices" | "clone" | "create" | null
  >(null);
  const [repoFilter, setRepoFilter] = useState("");
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
  const [repoDetailCommand, setRepoDetailCommand] = useState<RepoDetailCommand | null>(null);
  const [, setRepoDetailCommandId] = useState(0);
  const [bulkActionPending, setBulkActionPending] = useState<string | null>(null);
  const [bulkActionNotice, setBulkActionNotice] = useState<string | null>(null);
  const [bulkOperationId, setBulkOperationId] = useState<string | null>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [switcherQuery, setSwitcherQuery] = useState("");
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const [navigationRecency, setNavigationRecency] = useState<Record<string, number>>({});
  const navigationSequenceRef = useRef(0);
  const repositoryWarmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const uiSelectionRestoredRef = useRef(false);
  const [uiSelectionRestored, setUiSelectionRestored] = useState(false);

  const {
    closePalette,
    open: paletteOpen,
    openPalette,
    query: paletteQuery,
    setQuery: setPaletteQuery,
  } = useCommandPaletteState();

  const allRepositories = useMemo(
    () => Object.values(repositoriesByWorkspace).flat(),
    [repositoriesByWorkspace],
  );
  useRepositoryChangeEvents(allRepositories);
  const selectedRepo = allRepositories.find((repo) => repo.id === selectedRepoId) ?? null;
  const { branches: selectedRepoBranches } = useBranches(selectedRepoId);
  const shortcutBindings = createAppShortcutBindings({
    workspaceCount: workspaces.length,
    actions: {
      openPalette,
      openRepositorySwitcher: () => {
        setSwitcherQuery("");
        setSwitcherOpen(true);
      },
      openSettings: () => setSettingsOpen(true),
      openRepositorySearch: () => sendRepoDetailCommand({ kind: "openCommitSearch" }),
      openGlobalSearch: () => setGlobalSearchOpen(true),
      commit: () => document.dispatchEvent(new CustomEvent("fjord:commit")),
      refreshRepository: () => sendRepoDetailCommand({ kind: "refresh" }),
      refreshWorkspace: () => {
        if (!selectedWorkspaceId) return;
        void queryClient.invalidateQueries({
          queryKey: queryKeys.workspaces.status(selectedWorkspaceId),
        });
      },
      switchWorkspace: (index) => {
        const workspace = workspaces[index];
        if (!workspace) return;
        void selectWorkspace(workspace.id);
        setSelectedRepoId(null);
        setView("overview");
      },
      openHelp: () => setShortcutHelpOpen(true),
      closeTopOverlay: () => {
        if (shortcutHelpOpen) setShortcutHelpOpen(false);
        else if (globalSearchOpen) setGlobalSearchOpen(false);
        else if (settingsOpen) setSettingsOpen(false);
        else if (switcherOpen) setSwitcherOpen(false);
        else if (paletteOpen) closePalette();
      },
    },
  });
  useShortcutRegistry(
    shortcutBindings,
    paletteOpen || switcherOpen || settingsOpen || globalSearchOpen || shortcutHelpOpen
      ? ["dialog"]
      : selectedRepo
        ? ["repository"]
        : [],
  );
  const workspaceRepos = selectedWorkspaceId ? (repositoriesByWorkspace[selectedWorkspaceId] ?? []) : [];
  const isFirstRun = !loading && workspaces.length === 0;
  const activeBulkOperation = bulkOperationId ? (operations[bulkOperationId] ?? null) : null;

  const flatRows = workspaces.flatMap((workspace) =>
    (repositoriesByWorkspace[workspace.id] ?? []).map((repo) => ({ workspace, repo })),
  );

  const metrics = {
    total: workspaceRepos.length,
    attention: workspaceRepos.filter((repo) => repoNeedsAttention(healthByRepo[repo.id])).length,
    behind: workspaceRepos.filter((repo) => repoIsBehind(healthByRepo[repo.id])).length,
  };

  const repoCountByWorkspace = Object.fromEntries(
    workspaces.map((workspace) => [workspace.id, (repositoriesByWorkspace[workspace.id] ?? []).length]),
  );
  const attentionByWorkspace = Object.fromEntries(
    workspaces.map((workspace) => [
      workspace.id,
      (repositoriesByWorkspace[workspace.id] ?? []).filter((repo) =>
        repoNeedsAttention(healthByRepo[repo.id]),
      ).length,
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
    if (loading || workspaces.length === 0 || uiSelectionRestoredRef.current) return;
    uiSelectionRestoredRef.current = true;
    void loadUiState()
      .then(async (state) => {
        const restored = resolveRestoredSelection(
          state.selection,
          workspaces,
          repositoriesByWorkspace,
        );
        if (restored.workspaceId && restored.workspaceId !== selectedWorkspaceId) {
          await selectWorkspace(restored.workspaceId);
        }
        setSelectedRepoId(restored.repositoryId);
      })
      .catch(() => undefined)
      .finally(() => setUiSelectionRestored(true));
  }, [loading, repositoriesByWorkspace, selectWorkspace, selectedWorkspaceId, workspaces]);

  useEffect(() => {
    if (!uiSelectionRestored) return;
    const timeout = window.setTimeout(() => {
      void saveSelection(selectedWorkspaceId, selectedRepoId).catch(() => undefined);
    }, 500);
    return () => window.clearTimeout(timeout);
  }, [selectedRepoId, selectedWorkspaceId, uiSelectionRestored]);

  useEffect(() => {
    if (activated) {
      void setRepositoryActivity(selectedWorkspaceId, selectedRepoId).catch(() => undefined);
    }
  }, [activated, selectedRepoId, selectedWorkspaceId]);

  // One automatic update check per launch, a few seconds after first paint —
  // never blocking startup and never polling (docs/releasing.md's
  // runtime-update-check contract). `checkOnStartup` itself is idempotent,
  // so StrictMode's double-effect and this timer firing twice are harmless.
  useEffect(() => {
    if (!activated) return;
    const timeout = window.setTimeout(() => {
      void updateCoordinator.checkOnStartup();
    }, UPDATE_STARTUP_CHECK_DELAY_MS);
    return () => window.clearTimeout(timeout);
  }, [activated]);

  useEffect(() => {
    const id = selectedRepoId
      ? `repo:${selectedRepoId}`
      : selectedWorkspaceId
        ? `workspace:${selectedWorkspaceId}`
        : null;
    if (!id) return;
    navigationSequenceRef.current += 1;
    setNavigationRecency((current) => ({ ...current, [id]: navigationSequenceRef.current }));
  }, [selectedRepoId, selectedWorkspaceId]);

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
    ...(selectedRepo
      ? commandPaletteMergeBranches(selectedRepoBranches)
          .map((branch) => ({
            id: `merge:${branch.name}`,
            label: `${tw("commandPalette.mergeBranch")} ${branch.name}`,
            detail: tw("context.mergeInto", {
              source: branch.name,
              target: selectedRepoBranches.find((candidate) => candidate.isCurrent)?.name ?? "HEAD",
            }),
            group: tw("commandPalette.activeRepositoryGroup"),
            run: () => sendRepoDetailCommand({
              kind: "merge",
              source: mergeSourceForBranch(branch),
            }),
          }))
      : []),
    ...(selectedRepo
      ? (["open-ide", "fetch", "pull"] as const).map((action) => ({
          id: `action:${action}`,
          label: tw(action === "open-ide" ? "repoActions.openIde" : `repoActions.${action}`),
          detail: selectedRepo.name,
          group: tw("commandPalette.activeRepositoryGroup"),
          run: () => sendRepoDetailCommand({ kind: "repoAction", action }),
        }))
      : []),
    ...(selectedWorkspaceId
      ? (["fetch", "pull", "open-ide"] as const).map((action) => ({
          id: `bulk:${action}`,
          label: tw(action === "open-ide" ? "bulk.openIde" : `bulk.${action}`),
          detail: selectedWorkspace?.name ?? "",
          group: tw("commandPalette.workspaceGroup"),
          run: () => onBulk(action),
        }))
      : []),
    {
      id: "view:overview",
      label: tw("nav.overview"),
      detail: tw("commandPalette.viewDetail"),
      group: tw("commandPalette.globalGroup"),
      run: () => {
        setSelectedRepoId(null);
        setView("overview");
      },
    },
    {
      id: "view:all",
      label: tw("nav.allRepositories"),
      detail: tw("commandPalette.viewDetail"),
      group: tw("commandPalette.globalGroup"),
      run: () => {
        setSelectedRepoId(null);
        setView("repositories");
      },
    },
    {
      id: "settings:open",
      label: tw("settings.openCommand"),
      detail: tw("settings.openCommandDetail"),
      group: tw("commandPalette.globalGroup"),
      run: () => setSettingsOpen(true),
    },
  ];

  const switcherItems: RepositorySwitcherItem[] = [
    ...workspaces.map((workspace) => ({
      id: `workspace:${workspace.id}`,
      label: workspace.name,
      detail: tw("repositorySwitcher.workspaceDetail", {
        count: repositoriesByWorkspace[workspace.id]?.length ?? 0,
      }),
      kind: "workspace" as const,
      recency: navigationRecency[`workspace:${workspace.id}`] ?? 0,
      run: async () => {
        await selectWorkspace(workspace.id);
        setSelectedRepoId(null);
        setView("overview");
      },
    })),
    ...flatRows.map(({ workspace, repo }) => ({
      id: `repo:${repo.id}`,
      label: repo.name,
      detail: `${workspace.name} · ${repo.path}`,
      kind: "repository" as const,
      recency: navigationRecency[`repo:${repo.id}`] ?? 0,
      run: () => selectRepository(workspace.id, repo.id),
    })),
  ];

  if (isFirstRun) {
    return (
      <Onboarding
        onCreate={async (name, withRepository) => {
          const created = await createWorkspace(name || tw("onboarding.defaultWorkspaceName"));
          if (created && withRepository) setRepositoryOnboardingStep("choices");
        }}
      />
    );
  }

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: "var(--page-bg)", color: "var(--ink)" }}>
      <ResizableSidebar resizeLabel={tw("nav.resizeSidebar")}>
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
        healthByRepo={healthByRepo}
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
        />
      </ResizableSidebar>

      <MainShell>
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
            command={repoDetailCommand}
            onBack={() => {
              setSelectedRepoId(null);
              setRepoDetailCommand(null);
            }}
            utilities={
              <ShellUtilities
                searchLabel={tw("toolbar.search")}
                settingsLabel={tw("settings.title")}
                onOpenSearch={openPalette}
                onOpenSettings={() => setSettingsOpen(true)}
              />
            }
          />
        ) : view === "overview" ? (
          <OverviewView
            workspace={selectedWorkspace}
            repositories={workspaceRepos}
            statusByRepo={statusByRepo}
            healthByRepo={healthByRepo}
            selectedRepoId={selectedRepoId}
            metrics={metrics}
            bulkPending={bulkActionPending}
            bulkProgress={toBulkProgress(activeBulkOperation)}
            onCancelBulk={() => {
              if (bulkOperationId) void cancelOperation(bulkOperationId);
            }}
            onBulk={onBulk}
            onAddRepository={() => setRepositoryOnboardingStep("choices")}
            onSelectRepo={(repoId) =>
              selectedWorkspaceId ? void selectRepository(selectedWorkspaceId, repoId) : undefined
            }
            onWarmRepo={queueRepositoryWarm}
            onRemoveRepo={(repoId) => void removeRepository(repoId)}
            utilities={
              <ShellUtilities
                searchLabel={tw("toolbar.search")}
                settingsLabel={tw("settings.title")}
                onOpenSearch={openPalette}
                onOpenSettings={() => setSettingsOpen(true)}
              />
            }
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
            utilities={
              <ShellUtilities
                searchLabel={tw("toolbar.search")}
                settingsLabel={tw("settings.title")}
                onOpenSearch={openPalette}
                onOpenSettings={() => setSettingsOpen(true)}
              />
            }
          />
        )}
        </ErrorBoundary>
      </MainShell>

      {paletteOpen && (
        <CommandPalette
          items={paletteItems}
          query={paletteQuery}
          onQueryChange={setPaletteQuery}
          onClose={closePalette}
        />
      )}

      {switcherOpen && (
        <RepositorySwitcher
          items={switcherItems}
          query={switcherQuery}
          onQueryChange={setSwitcherQuery}
          onClose={() => setSwitcherOpen(false)}
        />
      )}

      {globalSearchOpen && (
        <GlobalSearchDialog
          onSelect={(result) => void openSearchResult(result)}
          onClose={() => setGlobalSearchOpen(false)}
        />
      )}

      {shortcutHelpOpen && (
        <ShortcutHelpSheet
          bindings={shortcutBindings}
          onClose={() => setShortcutHelpOpen(false)}
        />
      )}

      {settingsOpen && (
        <SettingsDialog
          repositories={allRepositories}
          onClose={() => setSettingsOpen(false)}
          onSettingsChange={(settings) => {
            setInteractionDiagnosticsEnabled(settings.performanceDiagnostics);
          }}
        />
      )}

      <UpdateDialog />

      {repositoryOnboardingStep === "choices" && (
        <RepositoryOnboardingDialog
          onOpenExisting={() => {
            void openRepository().then((added) => {
              if (added) setRepositoryOnboardingStep(null);
            });
          }}
          onScanFolder={() => {
            void importRepositories().then((repositories) => {
              if (repositories !== null) setRepositoryOnboardingStep(null);
            });
          }}
          onClone={() => setRepositoryOnboardingStep("clone")}
          onCreate={() => setRepositoryOnboardingStep("create")}
          onClose={() => setRepositoryOnboardingStep(null)}
        />
      )}

      {repositoryOnboardingStep === "clone" && selectedWorkspaceId && (
        <CloneRepositoryDialog
          workspaceId={selectedWorkspaceId}
          operations={operations}
          onClone={cloneRepository}
          onCancelOperation={(operationId) => void cancelOperation(operationId)}
          onSuccess={(result) => {
            setRepositoryOnboardingStep(null);
            void selectRepository(result.repository.workspaceId, result.repository.id);
          }}
          onBack={() => setRepositoryOnboardingStep("choices")}
        />
      )}

      {repositoryOnboardingStep === "create" && selectedWorkspaceId && (
        <CreateRepositoryDialog
          workspaceId={selectedWorkspaceId}
          onCreate={createRepository}
          onSuccess={(result) => {
            setRepositoryOnboardingStep(null);
            void selectRepository(result.repository.workspaceId, result.repository.id);
          }}
          onBack={() => setRepositoryOnboardingStep("choices")}
        />
      )}

      {gitAuth.activePrompt && (
        <GitAuthPromptDialog
          prompt={gitAuth.activePrompt}
          repositoryName={allRepositories.find(
            (repository) => repository.id === operations[gitAuth.activePrompt!.operationId]?.repoId,
          )?.name}
          queuedCount={gitAuth.queuedCount}
          onAnswer={(value) => gitAuth.answerPrompt(gitAuth.activePrompt!, value)}
          onCancel={() => gitAuth.cancelPrompt(gitAuth.activePrompt!)}
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
