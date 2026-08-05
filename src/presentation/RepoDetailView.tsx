import { useTranslation } from "react-i18next";
import { BranchesPanel } from "@/presentation/BranchesPanel";
import { CommitGraph } from "@/presentation/CommitGraph";
import { CommitInspector } from "@/presentation/CommitInspector";
import { Button, Muted } from "@/presentation/ui";
import type { CommitSummary, RepoStatus } from "@/domain/git";
import type { RepositoryEntry } from "@/domain/workspace";

/**
 * A selected repository used to render *below* the dashboard, so clicking a
 * card appended a screenful of content far under the fold. It's a
 * drill-down now: branches on the left, history in the middle, the selected
 * commit on the right — the three-pane shape the design prototype settled on.
 */
export function RepoDetailView({
  repo,
  status,
  statusError,
  actionPending,
  actionError,
  selectedCommit,
  repoVersion,
  onBack,
  onAction,
  onCheckout,
  onSelectCommit,
}: {
  repo: RepositoryEntry;
  status: RepoStatus | null;
  statusError: string | null;
  actionPending: string | null;
  actionError: string | null;
  selectedCommit: CommitSummary | null;
  repoVersion: number;
  onBack: () => void;
  onAction: (action: "fetch" | "pull" | "push" | "open-ide" | "merge-tool") => void;
  onCheckout: (branch: string) => void;
  onSelectCommit: (commit: CommitSummary) => void;
}) {
  const { t } = useTranslation("workspace");

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <header className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={onBack}
            className="mb-0.5 text-[11px]"
            style={{ color: "var(--slate)" }}
          >
            ← {t("nav.back")}
          </button>
          <div className="flex items-baseline gap-2.5">
            <h2 className="truncate text-[17px] font-medium">{repo.name}</h2>
            <span className="truncate font-mono text-[12px]" style={{ color: "var(--slate)" }}>
              {status?.branch ?? t("dashboard.unknown")}
            </span>
          </div>
        </div>

        <Button disabled={actionPending !== null} onClick={() => onAction("fetch")}>
          {actionPending === "fetch" ? t("repoActions.fetching") : t("repoActions.fetch")}
        </Button>
        <Button disabled={actionPending !== null} onClick={() => onAction("pull")}>
          {actionPending === "pull" ? t("repoActions.pulling") : t("repoActions.pull")}
        </Button>
        <Button disabled={actionPending !== null} onClick={() => onAction("push")}>
          {actionPending === "push" ? t("repoActions.pushing") : t("repoActions.push")}
        </Button>
        <Button variant="primary" disabled={actionPending !== null} onClick={() => onAction("open-ide")}>
          {actionPending === "open-ide" ? t("repoActions.openingIde") : t("repoActions.openIde")}
        </Button>
      </header>

      {(actionError || statusError) && (
        <p className="text-[13px]" style={{ color: "var(--rust-ink)" }}>
          {actionError ?? statusError}
        </p>
      )}

      {status?.hasConflict && (
        <div
          className="flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-[13px]"
          style={{ background: "var(--rust-tint)", color: "var(--rust-ink)" }}
        >
          <span>{t("repoStatus.conflict")}</span>
          <Button size="sm" disabled={actionPending !== null} onClick={() => onAction("merge-tool")}>
            {actionPending === "merge-tool"
              ? t("repoStatus.openingMergeTool")
              : t("repoStatus.openMergeTool")}
          </Button>
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-[15rem_minmax(0,1fr)] gap-4 xl:grid-cols-[15rem_minmax(0,1fr)_19rem]">
        <div className="min-h-0 overflow-y-auto">
          <BranchesPanel
            key={`${repo.id}:${repoVersion}:branches`}
            repoId={repo.id}
            onCheckout={onCheckout}
          />
        </div>

        <div className="min-h-0 overflow-y-auto">
          <CommitGraph
            key={`${repo.id}:${repoVersion}:commits`}
            repoId={repo.id}
            selectedCommitId={selectedCommit?.id ?? null}
            onSelectCommit={onSelectCommit}
          />
        </div>

        <div className="hidden min-h-0 overflow-y-auto xl:block">
          {selectedCommit ? (
            <CommitInspector repoId={repo.id} commit={selectedCommit} />
          ) : (
            <Muted className="text-[12px]">{t("inspector.empty")}</Muted>
          )}
        </div>
      </div>
    </div>
  );
}
