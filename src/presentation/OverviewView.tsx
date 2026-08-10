import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useTranslation } from "react-i18next";
import { RepoCard } from "@/presentation/RepoCard";
import { Button, Muted } from "@/presentation/ui";
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

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5">
      <header className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[17px] font-medium">
            {workspace?.name ?? t("dashboard.title")}
          </h2>
          <p className="text-[13px]" style={{ color: "var(--slate)" }}>
            {t("dashboard.repoCountValue", { count: metrics.total })}
          </p>
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
          {t("repositories.openButton")}
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

      <div className="grid grid-cols-3 gap-3">
        <Metric label={t("dashboard.repoCount")} value={metrics.total} />
        <Metric
          label={t("dashboard.needAttention")}
          value={metrics.attention}
          tone={metrics.attention > 0 ? "var(--amber)" : undefined}
        />
        <Metric
          label={t("dashboard.behindOrigin")}
          value={metrics.behind}
          tone={metrics.behind > 0 ? "var(--amber)" : undefined}
        />
      </div>

      {repositories.length === 0 ? (
        <Muted className="text-[13px]">{t("repositories.empty")}</Muted>
      ) : (
        <VirtualRepoGrid
          repositories={repositories}
          statusByRepo={statusByRepo}
          selectedRepoId={selectedRepoId}
          onSelectRepo={onSelectRepo}
          onWarmRepo={onWarmRepo}
          onRemoveRepo={onRemoveRepo}
        />
      )}
    </div>
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
    <div
      className="flex items-center gap-3 rounded-lg border px-3 py-2"
      style={{ borderWidth: "0.5px", borderColor: "var(--hairline)", background: "var(--paper)" }}
    >
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
    </div>
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

function Metric({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-lg border px-3.5 py-3" style={{ background: "var(--paper)", borderColor: "var(--hairline)" }}>
      <span
        className="block text-[10px] font-medium uppercase tracking-[0.08em]"
        style={{ color: "var(--mist)" }}
      >
        {label}
      </span>
      <span className="mt-0.5 block text-[22px] font-medium tabular-nums" style={{ color: tone }}>
        {value}
      </span>
    </div>
  );
}
