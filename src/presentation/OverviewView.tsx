import { useTranslation } from "react-i18next";
import { RepoCard } from "@/presentation/RepoCard";
import { Button, Muted } from "@/presentation/ui";
import type { RepositoryEntry, RepoStatusSummary, Workspace } from "@/domain/workspace";

interface OverviewProps {
  workspace: Workspace | null;
  repositories: RepositoryEntry[];
  statusByRepo: Record<string, RepoStatusSummary>;
  selectedRepoId: string | null;
  metrics: { total: number; attention: number; behind: number };
  bulkPending: string | null;
  onBulk: (action: "fetch" | "pull" | "open-ide") => void;
  onOpenRepository: () => void;
  onImport: () => void;
  onSelectRepo: (repoId: string) => void;
  onRemoveRepo: (repoId: string) => void;
  importPending: boolean;
}

export function OverviewView({
  workspace,
  repositories,
  statusByRepo,
  selectedRepoId,
  metrics,
  bulkPending,
  onBulk,
  onOpenRepository,
  onImport,
  onSelectRepo,
  onRemoveRepo,
  importPending,
}: OverviewProps) {
  const { t } = useTranslation("workspace");

  return (
    <div className="flex flex-col gap-5">
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
        <Button disabled={!workspace || bulkPending !== null} onClick={() => onBulk("open-ide")}>
          {bulkPending === "open-ide" ? t("bulk.openingIde") : t("bulk.openIde")}
        </Button>
        <div className="mx-1 h-5 w-px" style={{ background: "var(--hairline)" }} />
        <Button disabled={!workspace || importPending} onClick={onImport}>
          {importPending ? t("repositories.importingButton") : t("repositories.importButton")}
        </Button>
        <Button variant="primary" disabled={!workspace} onClick={onOpenRepository}>
          {t("repositories.openButton")}
        </Button>
      </header>

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
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {repositories.map((repo) => (
            <RepoCard
              key={repo.id}
              repo={repo}
              status={statusByRepo[repo.id]?.status}
              selected={repo.id === selectedRepoId}
              onSelect={() => onSelectRepo(repo.id)}
              onRemove={() => onRemoveRepo(repo.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-xl px-3.5 py-3" style={{ background: "var(--paper)" }}>
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
