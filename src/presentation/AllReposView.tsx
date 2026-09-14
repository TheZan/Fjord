import { useMemo, useRef, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useTranslation } from "react-i18next";
import { Input, Muted } from "@/presentation/ui";
import { HealthFilterBar } from "@/presentation/HealthFilterBar";
import { filterRepositoryRows } from "@/application/repoHealth";
import type { UiOverviewFilter } from "@/domain/generated";
import type { RepoHealth, RepositoryEntry, RepoStatusSummary, Workspace } from "@/domain/workspace";

const ROW_HEIGHT = 58;

/**
 * The flat cross-workspace list. It used to sit directly above the
 * workspace-grouped cards on the same screen, listing the exact same
 * repositories a second time; it's now its own view, reachable from the
 * sidebar.
 */
export function AllReposView({
  rows,
  statusByRepo,
  healthByRepo,
  selectedRepoId,
  filter,
  onFilterChange,
  activeFilters,
  onToggleFilter,
  onClearFilters,
  onSelect,
  onWarm,
  utilities,
}: {
  rows: { workspace: Workspace; repo: RepositoryEntry }[];
  statusByRepo: Record<string, RepoStatusSummary>;
  healthByRepo: Record<string, RepoHealth>;
  selectedRepoId: string | null;
  filter: string;
  onFilterChange: (value: string) => void;
  activeFilters: ReadonlySet<UiOverviewFilter>;
  onToggleFilter: (filter: UiOverviewFilter) => void;
  onClearFilters: () => void;
  onSelect: (workspaceId: string, repoId: string) => void;
  onWarm?: (workspaceId: string, repoId: string) => void;
  utilities: ReactNode;
}) {
  const { t } = useTranslation("workspace");
  const parentRef = useRef<HTMLDivElement>(null);
  const filteredRows = useMemo(
    () => filterRepositoryRows(rows, healthByRepo, activeFilters, filter),
    [activeFilters, filter, healthByRepo, rows],
  );
  const rowVirtualizer = useVirtualizer({
    count: filteredRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <header className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-[1_1_14rem]">
          <h2 className="text-[17px] font-medium">{t("allRepositories.title")}</h2>
          <p className="text-[13px]" style={{ color: "var(--slate)" }}>
            {t("dashboard.repoCountValue", { count: filteredRows.length })}
          </p>
        </div>
        <Input
          value={filter}
          onChange={(event) => onFilterChange(event.target.value)}
          placeholder={t("allRepositories.filterPlaceholder")}
          className="min-w-40 max-w-full flex-[0_1_16rem]"
        />
        {utilities}
      </header>

      <HealthFilterBar
        filters={activeFilters}
        onToggle={onToggleFilter}
        onClear={onClearFilters}
      />

      {filteredRows.length === 0 ? (
        <Muted className="text-[13px]">
          {rows.length === 0 ? t("allRepositories.empty") : t("filters.noMatches")}
        </Muted>
      ) : (
        <div
          ref={parentRef}
          className="min-h-[18rem] flex-1 overflow-auto rounded-lg border"
          style={{ borderWidth: "0.5px", borderColor: "var(--hairline)", background: "var(--paper)" }}
        >
          <div
            style={{
              height: `${rowVirtualizer.getTotalSize()}px`,
              position: "relative",
              width: "100%",
            }}
          >
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const { workspace, repo } = filteredRows[virtualRow.index];
              const status = statusByRepo[repo.id]?.status;
              const isSelected = repo.id === selectedRepoId;

              return (
                <div
                  key={repo.id}
                  style={{
                    height: `${virtualRow.size}px`,
                    left: 0,
                    position: "absolute",
                    top: 0,
                    transform: `translateY(${virtualRow.start}px)`,
                    width: "100%",
                  }}
                >
                  <button
                    type="button"
                    onClick={() => onSelect(workspace.id, repo.id)}
                    onPointerEnter={() => onWarm?.(workspace.id, repo.id)}
                    onFocus={() => onWarm?.(workspace.id, repo.id)}
                    data-selected={isSelected}
                    className="interactive-row grid w-full grid-cols-[minmax(0,1fr)_8rem_9rem] items-center gap-3 px-3.5 text-left"
                    style={{
                      borderTopWidth: virtualRow.index === 0 ? 0 : "0.5px",
                      borderTopStyle: "solid",
                      borderTopColor: "var(--hairline)",
                      color: isSelected ? "var(--fjord-ink)" : "var(--ink)",
                      height: ROW_HEIGHT,
                    }}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-medium">{repo.name}</span>
                      <span className="block truncate text-[11px]" style={{ color: "var(--mist)" }}>
                        {repo.path}
                      </span>
                    </span>
                    <span className="truncate text-[11px]" style={{ color: "var(--slate)" }}>
                      {workspace.name}
                    </span>
                    <span
                      className="truncate text-right font-mono text-[11px]"
                      style={{ color: "var(--slate)" }}
                    >
                      {status?.branch ?? t("dashboard.unknown")}
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
