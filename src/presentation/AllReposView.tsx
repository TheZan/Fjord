import { useTranslation } from "react-i18next";
import { Input, Muted } from "@/presentation/ui";
import type { RepositoryEntry, RepoStatusSummary, Workspace } from "@/domain/workspace";

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
}: {
  rows: { workspace: Workspace; repo: RepositoryEntry }[];
  statusByRepo: Record<string, RepoStatusSummary>;
  selectedRepoId: string | null;
  filter: string;
  onFilterChange: (value: string) => void;
  onSelect: (workspaceId: string, repoId: string) => void;
}) {
  const { t } = useTranslation("workspace");

  return (
    <div className="flex flex-col gap-4">
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
          className="overflow-hidden rounded-xl border"
          style={{ borderWidth: "0.5px", borderColor: "var(--hairline)", background: "var(--paper)" }}
        >
          {rows.map(({ workspace, repo }, index) => {
            const status = statusByRepo[repo.id]?.status;
            const isSelected = repo.id === selectedRepoId;

            return (
              <button
                key={repo.id}
                type="button"
                onClick={() => onSelect(workspace.id, repo.id)}
                className="grid w-full grid-cols-[minmax(0,1fr)_8rem_9rem] items-center gap-3 px-3.5 py-2.5 text-left"
                style={{
                  borderTopWidth: index === 0 ? 0 : "0.5px",
                  borderTopStyle: "solid",
                  borderTopColor: "var(--hairline)",
                  background: isSelected ? "var(--fjord-tint)" : "transparent",
                  color: isSelected ? "var(--fjord-ink)" : "var(--ink)",
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
            );
          })}
        </div>
      )}
    </div>
  );
}
