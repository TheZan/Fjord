import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/infrastructure/theme/ThemeProvider";
import { setLocale } from "@/infrastructure/i18n";
import { SUPPORTED_LOCALES } from "@/locales/registry";
import type { Theme } from "@/domain/settings";
import { FjordMark } from "@/presentation/FjordMark";
import { BranchesPanel } from "@/presentation/BranchesPanel";
import { CommitGraph } from "@/presentation/CommitGraph";
import { CommitInspector } from "@/presentation/CommitInspector";
import { useBranches } from "@/application/useBranches";
import { useRepositories } from "@/application/useRepositories";
import { useRepoStatus } from "@/application/useRepoStatus";
import type { CommitSummary } from "@/domain/git";
import {
  bulkFetch,
  bulkOpenInIde,
  bulkPull,
  checkoutBranch,
  fetchRepo,
  invokeErrorMessage,
  openInIde,
  openMergeTool,
  pullRepo,
  pushRepo,
} from "@/infrastructure/tauriClient";

const THEME_CHOICES: Theme[] = ["light", "dark", "system"];

interface PaletteItem {
  id: string;
  label: string;
  detail: string;
  kind: string;
  run: () => void | Promise<void>;
}

function paletteScore(query: string, label: string, detail: string): number | null {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return 0;

  const haystack = `${label} ${detail}`.toLocaleLowerCase();
  const directIndex = haystack.indexOf(needle);
  if (directIndex >= 0) return directIndex;

  let cursor = 0;
  let score = 100;
  for (const char of needle) {
    const found = haystack.indexOf(char, cursor);
    if (found < 0) return null;
    score += found - cursor;
    cursor = found + 1;
  }
  return score;
}

export function App() {
  const { t, i18n } = useTranslation();
  const { t: tw } = useTranslation("workspace");
  const { choice, setChoice } = useTheme();
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
    removeRepository,
  } = useRepositories();
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [editingWorkspaceId, setEditingWorkspaceId] = useState<string | null>(null);
  const [editingWorkspaceName, setEditingWorkspaceName] = useState("");
  const [repoFilter, setRepoFilter] = useState("");
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
  const [selectedCommit, setSelectedCommit] = useState<CommitSummary | null>(null);
  const [repoVersion, setRepoVersion] = useState(0);
  const [repoActionError, setRepoActionError] = useState<string | null>(null);
  const [repoActionPending, setRepoActionPending] = useState<string | null>(null);
  const [bulkActionPending, setBulkActionPending] = useState<string | null>(null);
  const [bulkActionSummary, setBulkActionSummary] = useState<string | null>(null);
  const [bulkActionError, setBulkActionError] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteIndex, setPaletteIndex] = useState(0);
  const { status: repoStatus, error: repoStatusError } = useRepoStatus(selectedRepoId, repoVersion);
  const { branches: paletteBranches } = useBranches(paletteOpen ? selectedRepoId : null);
  const allRepositories = Object.values(repositoriesByWorkspace).flat();
  const selectedRepo = allRepositories.find((repo) => repo.id === selectedRepoId) ?? null;
  const totalRepoCount = allRepositories.length;
  const needAttentionCount = allRepositories.filter((repo) => {
    const status = statusByRepo[repo.id]?.status;
    return Boolean(status?.hasConflict || status?.dirtyCount || status?.ahead || status?.behind);
  }).length;
  const behindOriginCount = allRepositories.filter((repo) => (statusByRepo[repo.id]?.status.behind ?? 0) > 0)
    .length;
  const flatRepositories = workspaces.flatMap((workspace) =>
    (repositoriesByWorkspace[workspace.id] ?? []).map((repo) => ({ workspace, repo })),
  );
  const normalizedRepoFilter = repoFilter.trim().toLocaleLowerCase();
  const filteredRepositories = flatRepositories.filter(({ workspace, repo }) => {
    if (!normalizedRepoFilter) return true;

    return [repo.name, repo.path, workspace.name].some((value) =>
      value.toLocaleLowerCase().includes(normalizedRepoFilter),
    );
  });
  const rawPaletteItems: PaletteItem[] = [
    ...flatRepositories.map(({ workspace, repo }) => ({
      id: `repo:${repo.id}`,
      label: repo.name,
      detail: `${workspace.name} · ${repo.path}`,
      kind: tw("commandPalette.repository"),
      run: () => chooseRepository(workspace.id, repo.id),
    })),
    ...(selectedRepo
      ? [
          {
            id: "action:open-ide",
            label: tw("repoActions.openIde"),
            detail: selectedRepo.name,
            kind: tw("commandPalette.action"),
            run: () => runRepoAction("open-ide", () => openInIde(selectedRepo.id)),
          },
          {
            id: "action:fetch",
            label: tw("repoActions.fetch"),
            detail: selectedRepo.name,
            kind: tw("commandPalette.action"),
            run: () => runRepoAction("fetch", () => fetchRepo(selectedRepo.id)),
          },
          {
            id: "action:pull",
            label: tw("repoActions.pull"),
            detail: selectedRepo.name,
            kind: tw("commandPalette.action"),
            run: () => runRepoAction("pull", () => pullRepo(selectedRepo.id)),
          },
        ]
      : []),
    ...(selectedWorkspaceId
      ? [
          {
            id: "bulk:fetch",
            label: tw("bulk.fetch"),
            detail: selectedWorkspace?.name ?? "",
            kind: tw("commandPalette.action"),
            run: () => runBulkAction("fetch", () => bulkFetch(selectedWorkspaceId)),
          },
          {
            id: "bulk:pull",
            label: tw("bulk.pull"),
            detail: selectedWorkspace?.name ?? "",
            kind: tw("commandPalette.action"),
            run: () => runBulkAction("pull", () => bulkPull(selectedWorkspaceId)),
          },
          {
            id: "bulk:open-ide",
            label: tw("bulk.openIde"),
            detail: selectedWorkspace?.name ?? "",
            kind: tw("commandPalette.action"),
            run: () => runBulkAction("open-ide", () => bulkOpenInIde(selectedWorkspaceId)),
          },
        ]
      : []),
    ...paletteBranches.map((branch) => ({
      id: `branch:${branch.name}`,
      label: branch.name,
      detail: selectedRepo?.name ?? "",
      kind: branch.isRemote ? tw("commandPalette.remoteBranch") : tw("commandPalette.localBranch"),
      run: () =>
        selectedRepoId
          ? runRepoAction("checkout", () => checkoutBranch(selectedRepoId, branch.name))
          : undefined,
    })),
  ];
  const paletteItems = rawPaletteItems
    .flatMap((item) => {
      const score = paletteScore(paletteQuery, item.label, item.detail);
      return score === null ? [] : [{ item, score }];
    })
    .sort((a, b) => a.score - b.score)
    .map((entry) => entry.item);
  const visiblePaletteItems = paletteItems.slice(0, 12);

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
        setPaletteOpen(true);
        setPaletteQuery("");
        setPaletteIndex(0);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    setPaletteIndex(0);
  }, [paletteQuery, paletteOpen]);

  async function runRepoAction(action: string, run: () => Promise<void>) {
    setRepoActionError(null);
    setRepoActionPending(action);
    try {
      await run();
      setSelectedCommit(null);
      setRepoVersion((version) => version + 1);
    } catch (e) {
      setRepoActionError(invokeErrorMessage(e));
    } finally {
      setRepoActionPending(null);
    }
  }

  async function runBulkAction(
    action: string,
    run: () => Promise<Array<{ ok: boolean; error: string | null }>>,
  ) {
    setBulkActionError(null);
    setBulkActionSummary(null);
    setBulkActionPending(action);
    try {
      const results = await run();
      const failed = results.filter((result) => !result.ok).length;
      setBulkActionSummary(
        tw("bulk.summary", {
          succeeded: results.length - failed,
          failed,
        }),
      );
      setRepoVersion((version) => version + 1);
    } catch (e) {
      setBulkActionError(invokeErrorMessage(e));
    } finally {
      setBulkActionPending(null);
    }
  }

  async function submitWorkspace() {
    await createWorkspace(newWorkspaceName);
    setNewWorkspaceName("");
  }

  async function submitRename(workspaceId: string) {
    await renameWorkspace(workspaceId, editingWorkspaceName);
    setEditingWorkspaceId(null);
    setEditingWorkspaceName("");
  }

  function beginRename(workspaceId: string, name: string) {
    setEditingWorkspaceId(workspaceId);
    setEditingWorkspaceName(name);
  }

  async function chooseWorkspace(workspaceId: string) {
    await selectWorkspace(workspaceId);
    setSelectedRepoId(null);
    setSelectedCommit(null);
  }

  async function chooseRepository(workspaceId: string, repoId: string) {
    if (workspaceId !== selectedWorkspaceId) {
      await selectWorkspace(workspaceId);
    }

    setSelectedRepoId(repoId === selectedRepoId ? null : repoId);
    setSelectedCommit(null);
  }

  function moveRepositorySelection(direction: -1 | 1) {
    if (filteredRepositories.length === 0) return;

    const currentIndex = filteredRepositories.findIndex(({ repo }) => repo.id === selectedRepoId);
    const nextIndex =
      currentIndex < 0
        ? direction > 0
          ? 0
          : filteredRepositories.length - 1
        : Math.min(Math.max(currentIndex + direction, 0), filteredRepositories.length - 1);
    const next = filteredRepositories[nextIndex];
    void chooseRepository(next.workspace.id, next.repo.id);
  }

  async function runPaletteItem(item: PaletteItem | undefined) {
    if (!item) return;

    setPaletteOpen(false);
    setPaletteQuery("");
    await item.run();
  }

  async function removeTrackedRepository(repoId: string) {
    if (repoId === selectedRepoId) {
      setSelectedRepoId(null);
      setSelectedCommit(null);
    }
    await removeRepository(repoId);
  }

  return (
    <main className="flex min-h-screen" style={{ background: "var(--page-bg)", color: "var(--ink)" }}>
      <aside
        className="flex w-80 shrink-0 flex-col gap-5 border-r p-5"
        style={{ borderColor: "var(--hairline)", background: "var(--paper)" }}
      >
        <div className="flex items-center gap-3">
          <FjordMark size={28} style={{ color: "var(--brand)" }} />
          <div>
            <h1 className="text-lg font-medium">{t("app.title")}</h1>
            <p className="text-xs" style={{ color: "var(--slate)" }}>
              {t("app.tagline")}
            </p>
          </div>
        </div>

        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-xs font-medium uppercase tracking-wide" style={{ color: "var(--mist)" }}>
              {tw("workspaces.label")}
            </h2>
            {loading && (
              <span className="text-xs" style={{ color: "var(--mist)" }}>
                {tw("workspaces.loading")}
              </span>
            )}
          </div>

          <div className="flex gap-2">
            <input
              value={newWorkspaceName}
              onChange={(event) => setNewWorkspaceName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void submitWorkspace();
              }}
              placeholder={tw("workspaces.createPlaceholder")}
              className="min-w-0 flex-1 rounded border px-3 text-sm outline-none"
              style={{
                borderColor: "var(--hairline)",
                background: "var(--page-bg)",
                color: "var(--ink)",
              }}
            />
            <button
              type="button"
              disabled={workspaceActionPending !== null}
              onClick={() => void submitWorkspace()}
              className="h-9 rounded border px-3 text-sm disabled:opacity-60"
              style={{
                borderColor: "var(--fjord)",
                background: "var(--fjord-tint)",
                color: "var(--fjord-ink)",
              }}
            >
              {tw("workspaces.createButton")}
            </button>
          </div>

          {workspaces.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--slate)" }}>
              {tw("workspaces.empty")}
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {workspaces.map((workspace, index) => {
                const isSelected = workspace.id === selectedWorkspaceId;
                const isEditing = workspace.id === editingWorkspaceId;
                const isPending = workspaceActionPending === workspace.id;

                return (
                  <li
                    key={workspace.id}
                    className="rounded border p-2"
                    style={{
                      borderColor: isSelected ? "var(--fjord)" : "var(--hairline)",
                      background: isSelected ? "var(--fjord-tint)" : "transparent",
                    }}
                  >
                    {isEditing ? (
                      <div className="flex flex-col gap-2">
                        <input
                          value={editingWorkspaceName}
                          onChange={(event) => setEditingWorkspaceName(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") void submitRename(workspace.id);
                            if (event.key === "Escape") setEditingWorkspaceId(null);
                          }}
                          className="h-8 rounded border px-2 text-sm outline-none"
                          style={{
                            borderColor: "var(--hairline)",
                            background: "var(--paper)",
                            color: "var(--ink)",
                          }}
                        />
                        <div className="flex gap-2">
                          <button
                            type="button"
                            disabled={isPending}
                            onClick={() => void submitRename(workspace.id)}
                            className="h-8 rounded border px-2 text-xs disabled:opacity-60"
                            style={{
                              borderColor: "var(--fjord)",
                              background: "var(--paper)",
                              color: "var(--fjord-ink)",
                            }}
                          >
                            {tw("workspaces.save")}
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingWorkspaceId(null)}
                            className="h-8 rounded border px-2 text-xs"
                            style={{
                              borderColor: "var(--hairline)",
                              background: "var(--paper)",
                              color: "var(--ink)",
                            }}
                          >
                            {tw("workspaces.cancel")}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-start gap-2">
                        <button
                          type="button"
                          onClick={() => void chooseWorkspace(workspace.id)}
                          className="min-w-0 flex-1 text-left"
                        >
                          <span className="block truncate text-sm font-medium">{workspace.name}</span>
                        </button>
                        <div className="flex shrink-0 gap-1">
                          <button
                            type="button"
                            disabled={index === 0 || workspaceActionPending !== null}
                            onClick={() => void moveWorkspace(workspace.id, -1)}
                            className="h-7 rounded border px-2 text-xs disabled:opacity-40"
                            style={{
                              borderColor: "var(--hairline)",
                              background: "var(--paper)",
                              color: "var(--ink)",
                            }}
                          >
                            {tw("workspaces.moveUp")}
                          </button>
                          <button
                            type="button"
                            disabled={index === workspaces.length - 1 || workspaceActionPending !== null}
                            onClick={() => void moveWorkspace(workspace.id, 1)}
                            className="h-7 rounded border px-2 text-xs disabled:opacity-40"
                            style={{
                              borderColor: "var(--hairline)",
                              background: "var(--paper)",
                              color: "var(--ink)",
                            }}
                          >
                            {tw("workspaces.moveDown")}
                          </button>
                        </div>
                      </div>
                    )}

                    {!isEditing && (
                      <div className="mt-2 flex gap-2">
                        <button
                          type="button"
                          disabled={workspaceActionPending !== null}
                          onClick={() => beginRename(workspace.id, workspace.name)}
                          className="h-7 rounded border px-2 text-xs disabled:opacity-60"
                          style={{
                            borderColor: "var(--hairline)",
                            background: "var(--paper)",
                            color: "var(--ink)",
                          }}
                        >
                          {tw("workspaces.rename")}
                        </button>
                        <button
                          type="button"
                          disabled={workspaceActionPending !== null}
                          onClick={() => void deleteWorkspace(workspace.id)}
                          className="h-7 rounded border px-2 text-xs disabled:opacity-60"
                          style={{
                            borderColor: "var(--rust)",
                            background: "var(--paper)",
                            color: "var(--rust-ink)",
                          }}
                        >
                          {tw("workspaces.delete")}
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="mt-auto flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium uppercase tracking-wide" style={{ color: "var(--mist)" }}>
              {t("settings.theme.label")}
            </span>
            <div className="grid grid-cols-3 gap-2">
              {THEME_CHOICES.map((themeChoice) => (
                <button
                  key={themeChoice}
                  type="button"
                  onClick={() => setChoice(themeChoice)}
                  className="h-8 rounded border px-2 text-xs"
                  style={{
                    borderColor: choice === themeChoice ? "var(--fjord)" : "var(--hairline)",
                    background: choice === themeChoice ? "var(--fjord-tint)" : "var(--paper)",
                    color: choice === themeChoice ? "var(--fjord-ink)" : "var(--ink)",
                  }}
                >
                  {t(`settings.theme.${themeChoice}`)}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium uppercase tracking-wide" style={{ color: "var(--mist)" }}>
              {t("settings.locale.label")}
            </span>
            <div className="grid grid-cols-2 gap-2">
              {SUPPORTED_LOCALES.map((locale) => (
                <button
                  key={locale.code}
                  type="button"
                  onClick={() => setLocale(locale.code)}
                  className="h-8 rounded border px-2 text-xs"
                  style={{
                    borderColor: i18n.language === locale.code ? "var(--fjord)" : "var(--hairline)",
                    background: i18n.language === locale.code ? "var(--fjord-tint)" : "var(--paper)",
                    color: i18n.language === locale.code ? "var(--fjord-ink)" : "var(--ink)",
                  }}
                >
                  {locale.label}
                </button>
              ))}
            </div>
          </div>
        </section>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col gap-5 p-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-xl font-medium">{tw("dashboard.title")}</h2>
            <p className="text-sm" style={{ color: "var(--slate)" }}>
              {selectedWorkspace
                ? tw("dashboard.addTarget", { workspace: selectedWorkspace.name })
                : tw("workspaces.noSelection")}
            </p>
          </div>
          <button
            type="button"
            disabled={!selectedWorkspaceId}
            onClick={openRepository}
            className="h-9 rounded border px-3 text-sm disabled:opacity-50"
            style={{
              borderColor: "var(--fjord)",
              background: "var(--fjord-tint)",
              color: "var(--fjord-ink)",
            }}
          >
            {tw("repositories.openButton")}
          </button>
        </header>

        {selectedWorkspaceId && (
          <section className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={bulkActionPending !== null}
              onClick={() => runBulkAction("fetch", () => bulkFetch(selectedWorkspaceId))}
              className="h-9 rounded border px-3 text-sm disabled:opacity-60"
              style={{ borderColor: "var(--hairline)", background: "var(--paper)", color: "var(--ink)" }}
            >
              {bulkActionPending === "fetch" ? tw("bulk.fetching") : tw("bulk.fetch")}
            </button>
            <button
              type="button"
              disabled={bulkActionPending !== null}
              onClick={() => runBulkAction("pull", () => bulkPull(selectedWorkspaceId))}
              className="h-9 rounded border px-3 text-sm disabled:opacity-60"
              style={{ borderColor: "var(--hairline)", background: "var(--paper)", color: "var(--ink)" }}
            >
              {bulkActionPending === "pull" ? tw("bulk.pulling") : tw("bulk.pull")}
            </button>
            <button
              type="button"
              disabled={bulkActionPending !== null}
              onClick={() => runBulkAction("open-ide", () => bulkOpenInIde(selectedWorkspaceId))}
              className="h-9 rounded border px-3 text-sm disabled:opacity-60"
              style={{ borderColor: "var(--hairline)", background: "var(--paper)", color: "var(--ink)" }}
            >
              {bulkActionPending === "open-ide" ? tw("bulk.openingIde") : tw("bulk.openIde")}
            </button>
            {bulkActionSummary && (
              <span className="text-sm" style={{ color: "var(--slate)" }}>
                {bulkActionSummary}
              </span>
            )}
            {bulkActionError && (
              <span className="text-sm" style={{ color: "var(--rust-ink)" }}>
                {bulkActionError}
              </span>
            )}
          </section>
        )}

        {error && (
          <p className="text-sm" style={{ color: "var(--rust-ink)" }}>
            {error.includes("not a git repository") ? tw("repositories.notAGitRepository") : error}
          </p>
        )}

        <section className="grid gap-3 md:grid-cols-3">
          {[
            { label: tw("dashboard.repoCount"), value: totalRepoCount },
            { label: tw("dashboard.needAttention"), value: needAttentionCount },
            { label: tw("dashboard.behindOrigin"), value: behindOriginCount },
          ].map((metric) => (
            <div
              key={metric.label}
              className="rounded border p-4"
              style={{ borderColor: "var(--hairline)", background: "var(--paper)" }}
            >
              <p className="text-xs font-medium uppercase tracking-wide" style={{ color: "var(--mist)" }}>
                {metric.label}
              </p>
              <p className="mt-2 text-2xl font-medium">{metric.value}</p>
            </div>
          ))}
        </section>

        {flatRepositories.length > 0 && (
          <section
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                moveRepositorySelection(1);
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                moveRepositorySelection(-1);
              }
            }}
            className="rounded border p-3 outline-none focus:border-[var(--fjord)]"
            style={{ borderColor: "var(--hairline)", background: "var(--paper)" }}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-sm font-medium">{tw("allRepositories.title")}</h3>
              <input
                value={repoFilter}
                onChange={(event) => setRepoFilter(event.target.value)}
                placeholder={tw("allRepositories.filterPlaceholder")}
                className="h-9 min-w-52 rounded border px-3 text-sm outline-none"
                style={{
                  borderColor: "var(--hairline)",
                  background: "var(--page-bg)",
                  color: "var(--ink)",
                }}
              />
            </div>

            {filteredRepositories.length === 0 ? (
              <p className="mt-3 text-sm" style={{ color: "var(--slate)" }}>
                {tw("allRepositories.empty")}
              </p>
            ) : (
              <ul className="mt-3 max-h-72 overflow-auto">
                {filteredRepositories.map(({ workspace, repo }) => {
                  const isSelected = repo.id === selectedRepoId;
                  const cachedStatus = statusByRepo[repo.id]?.status;

                  return (
                    <li key={repo.id}>
                      <button
                        type="button"
                        onClick={() => void chooseRepository(workspace.id, repo.id)}
                        className="grid w-full grid-cols-[minmax(0,1fr)_9rem_7rem] items-center gap-3 rounded px-2 py-2 text-left text-sm"
                        style={{
                          background: isSelected ? "var(--fjord-tint)" : "transparent",
                          color: isSelected ? "var(--fjord-ink)" : "var(--ink)",
                        }}
                      >
                        <span className="min-w-0">
                          <span className="block truncate font-medium">{repo.name}</span>
                          <span className="block truncate text-xs" style={{ color: "var(--mist)" }}>
                            {repo.path}
                          </span>
                        </span>
                        <span className="truncate text-xs" style={{ color: "var(--slate)" }}>
                          {workspace.name}
                        </span>
                        <span className="text-right text-xs" style={{ color: "var(--slate)" }}>
                          {cachedStatus?.branch ?? tw("dashboard.unknown")}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}

        {workspaces.length === 0 && (
          <p className="text-sm" style={{ color: "var(--slate)" }}>
            {tw("workspaces.empty")}
          </p>
        )}

        <section className="flex flex-col gap-5">
          {workspaces.map((workspace) => {
            const groupedRepositories = repositoriesByWorkspace[workspace.id] ?? [];

            return (
              <div key={workspace.id} className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="truncate text-sm font-medium">{workspace.name}</h3>
                  <span className="text-xs" style={{ color: "var(--mist)" }}>
                    {tw("dashboard.repoCountValue", { count: groupedRepositories.length })}
                  </span>
                </div>

                {groupedRepositories.length === 0 ? (
                  <p className="text-sm" style={{ color: "var(--slate)" }}>
                    {tw("repositories.empty")}
                  </p>
                ) : (
                  <ul className="grid gap-2 lg:grid-cols-2 xl:grid-cols-3">
                    {groupedRepositories.map((repo) => {
                      const cachedStatus = statusByRepo[repo.id]?.status;
                      const isSelected = repo.id === selectedRepoId;

                      return (
                        <li
                          key={repo.id}
                          className="rounded border p-3"
                          style={{
                            borderColor: isSelected ? "var(--fjord)" : "var(--hairline)",
                            background: isSelected ? "var(--fjord-tint)" : "var(--paper)",
                          }}
                        >
                          <div className="flex items-start gap-3">
                            <button
                              type="button"
                              onClick={() => void chooseRepository(workspace.id, repo.id)}
                              className="min-w-0 flex-1 text-left"
                            >
                              <span className="block truncate text-sm font-medium">{repo.name}</span>
                              <span className="block truncate text-xs" style={{ color: "var(--mist)" }}>
                                {repo.path}
                              </span>
                            </button>
                            <button
                              type="button"
                              onClick={() => void removeTrackedRepository(repo.id)}
                              className="h-8 shrink-0 rounded border px-2 text-xs"
                              style={{
                                borderColor: "var(--rust)",
                                background: "var(--paper)",
                                color: "var(--rust-ink)",
                              }}
                            >
                              {tw("repositories.removeButton")}
                            </button>
                          </div>

                          <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
                            <div>
                              <dt style={{ color: "var(--mist)" }}>{tw("dashboard.branch")}</dt>
                              <dd className="truncate">{cachedStatus?.branch ?? tw("dashboard.unknown")}</dd>
                            </div>
                            <div>
                              <dt style={{ color: "var(--mist)" }}>{tw("dashboard.dirty")}</dt>
                              <dd>{cachedStatus?.dirtyCount ?? 0}</dd>
                            </div>
                            <div>
                              <dt style={{ color: "var(--mist)" }}>{tw("dashboard.behind")}</dt>
                              <dd>{cachedStatus?.behind ?? 0}</dd>
                            </div>
                            <div>
                              <dt style={{ color: "var(--mist)" }}>{tw("dashboard.ahead")}</dt>
                              <dd>{cachedStatus?.ahead ?? 0}</dd>
                            </div>
                          </dl>
                          {cachedStatus?.hasConflict && (
                            <p className="mt-2 text-xs font-medium" style={{ color: "var(--rust-ink)" }}>
                              {tw("repoStatus.conflict")}
                            </p>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            );
          })}
        </section>

        {selectedRepoId && (
          <div className="flex min-w-0 flex-col gap-4">
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={repoActionPending !== null}
                onClick={() => runRepoAction("fetch", () => fetchRepo(selectedRepoId))}
                className="h-9 rounded border px-3 text-sm disabled:opacity-60"
                style={{ borderColor: "var(--hairline)", background: "var(--paper)", color: "var(--ink)" }}
              >
                {repoActionPending === "fetch" ? tw("repoActions.fetching") : tw("repoActions.fetch")}
              </button>
              <button
                type="button"
                disabled={repoActionPending !== null}
                onClick={() => runRepoAction("pull", () => pullRepo(selectedRepoId))}
                className="h-9 rounded border px-3 text-sm disabled:opacity-60"
                style={{ borderColor: "var(--hairline)", background: "var(--paper)", color: "var(--ink)" }}
              >
                {repoActionPending === "pull" ? tw("repoActions.pulling") : tw("repoActions.pull")}
              </button>
              <button
                type="button"
                disabled={repoActionPending !== null}
                onClick={() => runRepoAction("push", () => pushRepo(selectedRepoId))}
                className="h-9 rounded border px-3 text-sm disabled:opacity-60"
                style={{ borderColor: "var(--hairline)", background: "var(--paper)", color: "var(--ink)" }}
              >
                {repoActionPending === "push" ? tw("repoActions.pushing") : tw("repoActions.push")}
              </button>
              <button
                type="button"
                disabled={repoActionPending !== null}
                onClick={() => runRepoAction("open-ide", () => openInIde(selectedRepoId))}
                className="h-9 rounded border px-3 text-sm disabled:opacity-60"
                style={{ borderColor: "var(--hairline)", background: "var(--paper)", color: "var(--ink)" }}
              >
                {repoActionPending === "open-ide" ? tw("repoActions.openingIde") : tw("repoActions.openIde")}
              </button>
            </div>
            {repoActionError && (
              <p className="text-sm" style={{ color: "var(--rust-ink)" }}>
                {repoActionError}
              </p>
            )}
            {repoStatusError && (
              <p className="text-sm" style={{ color: "var(--rust-ink)" }}>
                {repoStatusError}
              </p>
            )}
            {repoStatus?.hasConflict && (
              <div
                className="flex max-w-2xl items-center justify-between gap-3 rounded border p-3 text-sm"
                style={{ borderColor: "var(--rust)", background: "var(--rust-tint)", color: "var(--rust-ink)" }}
              >
                <span>{tw("repoStatus.conflict")}</span>
                <button
                  type="button"
                  disabled={repoActionPending !== null}
                  onClick={() => runRepoAction("merge-tool", () => openMergeTool(selectedRepoId))}
                  className="h-8 shrink-0 rounded border px-2 text-xs disabled:opacity-60"
                  style={{ borderColor: "var(--rust)", background: "var(--paper)", color: "var(--rust-ink)" }}
                >
                  {repoActionPending === "merge-tool"
                    ? tw("repoStatus.openingMergeTool")
                    : tw("repoStatus.openMergeTool")}
                </button>
              </div>
            )}
            <BranchesPanel
              key={`${selectedRepoId}:${repoVersion}:branches`}
              repoId={selectedRepoId}
              onCheckout={(branch) => runRepoAction("checkout", () => checkoutBranch(selectedRepoId, branch))}
            />
            <CommitGraph
              key={`${selectedRepoId}:${repoVersion}:commits`}
              repoId={selectedRepoId}
              selectedCommitId={selectedCommit?.id ?? null}
              onSelectCommit={(commit) => setSelectedCommit(commit.id === selectedCommit?.id ? null : commit)}
            />
            {selectedCommit && <CommitInspector repoId={selectedRepoId} commit={selectedCommit} />}
          </div>
        )}
      </section>

      {paletteOpen && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-20"
          style={{ background: "rgba(0, 0, 0, 0.35)" }}
          onMouseDown={() => setPaletteOpen(false)}
        >
          <div
            className="w-full max-w-2xl rounded border shadow-xl"
            style={{ borderColor: "var(--hairline)", background: "var(--paper)" }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <input
              autoFocus
              value={paletteQuery}
              onChange={(event) => setPaletteQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setPaletteOpen(false);
                }
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setPaletteIndex((index) => Math.min(index + 1, Math.max(visiblePaletteItems.length - 1, 0)));
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setPaletteIndex((index) => Math.max(index - 1, 0));
                }
                if (event.key === "Enter") {
                  event.preventDefault();
                  void runPaletteItem(visiblePaletteItems[paletteIndex]);
                }
              }}
              placeholder={tw("commandPalette.placeholder")}
              className="h-12 w-full border-b px-4 text-sm outline-none"
              style={{
                borderColor: "var(--hairline)",
                background: "var(--paper)",
                color: "var(--ink)",
              }}
            />
            {paletteItems.length === 0 ? (
              <p className="p-4 text-sm" style={{ color: "var(--slate)" }}>
                {tw("commandPalette.empty")}
              </p>
            ) : (
              <ul className="max-h-96 overflow-auto p-2">
                {visiblePaletteItems.map((item, index) => {
                  const isSelected = index === paletteIndex;

                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        onMouseEnter={() => setPaletteIndex(index)}
                        onClick={() => void runPaletteItem(item)}
                        className="grid w-full grid-cols-[minmax(0,1fr)_8rem] items-center gap-3 rounded px-3 py-2 text-left text-sm"
                        style={{
                          background: isSelected ? "var(--fjord-tint)" : "transparent",
                          color: isSelected ? "var(--fjord-ink)" : "var(--ink)",
                        }}
                      >
                        <span className="min-w-0">
                          <span className="block truncate font-medium">{item.label}</span>
                          <span className="block truncate text-xs" style={{ color: "var(--mist)" }}>
                            {item.detail}
                          </span>
                        </span>
                        <span className="truncate text-right text-xs" style={{ color: "var(--slate)" }}>
                          {item.kind}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
