import { useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useTranslation } from "react-i18next";
import { Input, Muted } from "@/presentation/ui";
import type { RepositoryEntry, RepoStatusSummary, Workspace } from "@/domain/workspace";

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
  selectedRepoId,
  filter,
  onFilterChange,
  onSelect,
  onWarm,
}: {
  rows: { workspace: Workspace; repo: RepositoryEntry }[];
  statusByRepo: Record<string, RepoStatusSummary>;
  selectedRepoId: string | null;
  filter: string;
  onFilterChange: (value: string) => void;
  onSelect: (workspaceId: string, repoId: string) => void;
  onWarm?: (workspaceId: string, repoId: string) => void;
}) {
  const { t } = useTranslation("workspace");
  const parentRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <header className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-[17px] font-medium">{t("allRepositories.title")}</h2>
          <p className="text-[13px]" style={{ color: "var(--slate)" }}>
            {t("dashboard.repoCountValue", { count: rows.length })}
          </p>
        </div>
        <Input
          value={filter}
          onChange={(event) => onFilterChange(event.target.value)}
          placeholder={t("allRepositories.filterPlaceholder")}
          className="w-64"
        />
      </header>

      {rows.length === 0 ? (
        <Muted className="text-[13px]">{t("allRepositories.empty")}</Muted>
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
              const { workspace, repo } = rows[virtualRow.index];
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
