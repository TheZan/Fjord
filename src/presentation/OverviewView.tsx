import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useTranslation } from "react-i18next";
import { loadUiState, saveOverviewFilters } from "@/infrastructure/uiState";
import { RepoCard } from "@/presentation/RepoCard";
import { Button, Muted, ScreenSurface, Surface, TYPOGRAPHY } from "@/presentation/ui";
import { OverflowMenu } from "@/presentation/OverflowMenu";
import type { RepositoryEntry, RepoStatusSummary, Workspace } from "@/domain/workspace";

interface OverviewProps {
  workspace: Workspace | null;
  repositories: RepositoryEntry[];
  statusByRepo: Record<string, RepoStatusSummary>;
  selectedRepoId: string | null;
  metrics: { total: number; attention: number; behind: number };
  bulkPending: string | null;
  bulkProgress: {
    completed: number;
    total: number;
    error: string | null;
    status: string;
  } | null;
  onCancelBulk: () => void;
  onBulk: (action: "fetch" | "pull" | "open-ide") => void;
  onOpenRepository: () => void;
  onImport: () => void;
  onSelectRepo: (repoId: string) => void;
  onWarmRepo: (repoId: string) => void;
  onRemoveRepo: (repoId: string) => void;
  importPending: boolean;
}

const CARD_ROW_HEIGHT = 112;
const CARD_GRID_GAP = 12;
type OverviewFilter = "attention" | "behind";

export function OverviewView({
  workspace,
  repositories,
  statusByRepo,
  selectedRepoId,
  metrics,
  bulkPending,
  bulkProgress,
  onCancelBulk,
  onBulk,
  onOpenRepository,
  onImport,
  onSelectRepo,
  onWarmRepo,
  onRemoveRepo,
  importPending,
}: OverviewProps) {
  const { t } = useTranslation("workspace");
  const [activeFilters, setActiveFilters] = useState<Set<OverviewFilter>>(() => new Set());
  const uiStateRestoredRef = useRef(false);

  useEffect(() => {
    if (uiStateRestoredRef.current) return;
    uiStateRestoredRef.current = true;
    void loadUiState()
      .then((state) => setActiveFilters(new Set(state.overview.filters)))
      .catch(() => undefined);
  }, []);
  const filteredRepositories = useMemo(() => {
    const attentionActive = metrics.attention > 0 && activeFilters.has("attention");
    const behindActive = metrics.behind > 0 && activeFilters.has("behind");
    if (!attentionActive && !behindActive) return repositories;
    return repositories.filter((repo) => {
      const status = statusByRepo[repo.id]?.status;
      return (
        (attentionActive && Boolean(status?.hasConflict || status?.dirtyCount || status?.ahead || status?.behind)) ||
        (behindActive && (status?.behind ?? 0) > 0)
      );
    });
  }, [activeFilters, metrics.attention, metrics.behind, repositories, statusByRepo]);

  function toggleFilter(filter: OverviewFilter) {
    setActiveFilters((current) => {
      const next = new Set(current);
      if (next.has(filter)) next.delete(filter);
      else next.add(filter);
      void saveOverviewFilters([...next]).catch(() => undefined);
      return next;
    });
  }

  return (
    <ScreenSurface screen="overview" className="flex min-h-0 flex-1 flex-col gap-5">
      <header className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 className={`truncate ${TYPOGRAPHY.screenTitle}`}>
            {workspace?.name ?? t("dashboard.title")}
          </h2>
        </div>

        <Button
          disabled={!workspace || bulkPending !== null}
          onClick={() => onBulk("fetch")}
        >
          {bulkPending === "fetch" ? t("bulk.fetching") : t("bulk.fetch")}
        </Button>
        <Button disabled={!workspace || bulkPending !== null} onClick={() => onBulk("pull")}>
          {bulkPending === "pull" ? t("bulk.pulling") : t("bulk.pull")}
        </Button>
        <Button variant="primary" disabled={!workspace} onClick={onOpenRepository}>
          {t("repositories.addButton")}
        </Button>
        <OverflowMenu
          label={t("toolbar.moreActions")}
          items={[
            {
              id: "open-all-in-ide",
              label: bulkPending === "open-ide" ? t("bulk.openingIde") : t("bulk.openIde"),
              disabled: !workspace || bulkPending !== null,
              onSelect: () => onBulk("open-ide"),
            },
            {
              id: "import",
              label: importPending ? t("repositories.importingButton") : t("repositories.importButton"),
              disabled: !workspace || importPending,
              onSelect: onImport,
            },
          ]}
        />
      </header>

      {bulkProgress ? <BulkProgressStrip progress={bulkProgress} onCancel={onCancelBulk} /> : null}

      <SummaryLine
        metrics={metrics}
        attentionActive={metrics.attention > 0 && activeFilters.has("attention")}
        behindActive={metrics.behind > 0 && activeFilters.has("behind")}
        onToggle={toggleFilter}
      />

      {filteredRepositories.length === 0 ? (
        <Muted className="text-[13px]">
          {repositories.length === 0 ? t("repositories.empty") : t("dashboard.noFilterMatches")}
        </Muted>
      ) : (
        <VirtualRepoGrid
          repositories={filteredRepositories}
          statusByRepo={statusByRepo}
          selectedRepoId={selectedRepoId}
          onSelectRepo={onSelectRepo}
          onWarmRepo={onWarmRepo}
          onRemoveRepo={onRemoveRepo}
        />
      )}
    </ScreenSurface>
  );
}

function BulkProgressStrip({
  progress,
  onCancel,
}: {
  progress: {
    completed: number;
    total: number;
    error: string | null;
    status: string;
  };
  onCancel: () => void;
}) {
  const { t } = useTranslation("workspace");
  const percent =
    progress.total > 0 ? Math.min(100, Math.round((progress.completed / progress.total) * 100)) : 0;

  return (
    <Surface className="flex items-center gap-3 px-3 py-2" style={{ background: "var(--paper)" }}>
      <div className="h-1.5 min-w-32 flex-1 overflow-hidden rounded-full" style={{ background: "var(--page-bg)" }}>
        <div
          className="h-full rounded-full transition-[width]"
          style={{ background: "var(--fjord)", width: `${percent}%` }}
        />
      </div>
      <span className="w-24 shrink-0 text-right text-[11px]" style={{ color: "var(--slate)" }}>
        {t("operations.progress", { completed: progress.completed, total: progress.total })}
      </span>
      <Button size="sm" variant="ghost" onClick={onCancel}>
        {t("operations.cancel")}
      </Button>
    </Surface>
  );
}

function VirtualRepoGrid({
  repositories,
  statusByRepo,
  selectedRepoId,
  onSelectRepo,
  onWarmRepo,
  onRemoveRepo,
}: {
  repositories: RepositoryEntry[];
  statusByRepo: Record<string, RepoStatusSummary>;
  selectedRepoId: string | null;
  onSelectRepo: (repoId: string) => void;
  onWarmRepo: (repoId: string) => void;
  onRemoveRepo: (repoId: string) => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const columns = width >= 1024 ? 3 : width >= 640 ? 2 : 1;
  const rows = useMemo(() => {
    const result: RepositoryEntry[][] = [];
    for (let index = 0; index < repositories.length; index += columns) {
      result.push(repositories.slice(index, index + columns));
    }
    return result;
  }, [columns, repositories]);

  useEffect(() => {
    const element = parentRef.current;
    if (!element) return;

    setWidth(element.clientWidth);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => CARD_ROW_HEIGHT + CARD_GRID_GAP,
    overscan: 6,
  });

  return (
    <div ref={parentRef} className="min-h-[18rem] flex-1 overflow-auto">
      <div
        style={{
          height: `${rowVirtualizer.getTotalSize()}px`,
          position: "relative",
          width: "100%",
        }}
      >
        {rowVirtualizer.getVirtualItems().map((virtualRow) => (
          <div
            key={virtualRow.index}
            className="grid gap-3"
            style={{
              gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
              height: CARD_ROW_HEIGHT,
              left: 0,
              position: "absolute",
              top: 0,
              transform: `translateY(${virtualRow.start}px)`,
              width: "100%",
            }}
          >
            {rows[virtualRow.index].map((repo) => (
              <RepoCard
                key={repo.id}
                repo={repo}
                status={statusByRepo[repo.id]?.status}
                selected={repo.id === selectedRepoId}
                onSelect={() => onSelectRepo(repo.id)}
                onWarm={() => onWarmRepo(repo.id)}
                onRemove={() => onRemoveRepo(repo.id)}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function SummaryLine({
  metrics,
  attentionActive,
  behindActive,
  onToggle,
}: {
  metrics: { total: number; attention: number; behind: number };
  attentionActive: boolean;
  behindActive: boolean;
  onToggle: (filter: OverviewFilter) => void;
}) {
  const { t } = useTranslation("workspace");
  return (
    <div className={`flex min-h-7 items-center gap-2 ${TYPOGRAPHY.body}`} style={{ color: "var(--slate)" }}>
      <span className="font-medium tabular-nums" style={{ color: "var(--ink)" }}>
        {t("dashboard.repoCountValue", { count: metrics.total })}
      </span>
      {metrics.attention > 0 ? (
        <>
          <span aria-hidden="true">·</span>
          <SummaryFilter active={attentionActive} onClick={() => onToggle("attention")}>
            {t("dashboard.needAttentionValue", { count: metrics.attention })}
          </SummaryFilter>
        </>
      ) : null}
      {metrics.behind > 0 ? (
        <>
          <span aria-hidden="true">·</span>
          <SummaryFilter active={behindActive} onClick={() => onToggle("behind")}>
            {t("dashboard.behindOriginValue", { count: metrics.behind })}
          </SummaryFilter>
        </>
      ) : null}
    </div>
  );
}

function SummaryFilter({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className="interactive-control rounded px-1.5 py-1 font-medium tabular-nums"
      style={{ color: active ? "var(--amber-ink)" : "var(--slate)", background: active ? "var(--amber-tint)" : undefined }}
    >
      {children}
    </button>
  );
}
