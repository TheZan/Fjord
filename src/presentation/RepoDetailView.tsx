import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useWorkingChanges } from "@/application/useWorkingChanges";
import type { DiffSource } from "@/application/useFileDiff";
import { CommitGraph } from "@/presentation/CommitGraph";
import { CommitInspector } from "@/presentation/CommitInspector";
import { FileDiffView } from "@/presentation/FileDiffView";
import { RepoToolbar, type RepoAction } from "@/presentation/RepoToolbar";
import { RepoTree } from "@/presentation/RepoTree";
import { WorkingChangesPanel, type SelectedWorkingFile } from "@/presentation/WorkingChangesPanel";
import { Button, Muted } from "@/presentation/ui";
import type { CommitSummary, RepoStatus } from "@/domain/git";
import type { RepositoryEntry } from "@/domain/workspace";

/**
 * A selected repository used to render *below* the dashboard, so clicking a
 * card appended a screenful of content far under the fold. It's a
 * drill-down now: a collapsible branch/tag tree on the left, history in the
 * middle — replaced by a full-detail file diff when one is selected — and
 * either the selected commit or the commit panel on the right.
 */
export function RepoDetailView({
  repo,
  status,
  statusError,
  actionPending,
  actionError,
  operationProgress,
  selectedCommit,
  workingSelected,
  onBack,
  onAction,
  onCancelOperation,
  onCheckout,
  onCreateBranch,
  onOpenSearch,
  onSelectCommit,
  onSelectWorking,
  onStage,
  onUnstage,
  onCommit,
}: {
  repo: RepositoryEntry;
  status: RepoStatus | null;
  statusError: string | null;
  actionPending: string | null;
  actionError: string | null;
  operationProgress: {
    completed: number;
    total: number;
    error: string | null;
    status: string;
  } | null;
  selectedCommit: CommitSummary | null;
  workingSelected: boolean;
  onBack: () => void;
  onAction: (action: RepoAction) => void;
  onCancelOperation: () => void;
  onCheckout: (branch: string) => void;
  onCreateBranch: (name: string) => void;
  onOpenSearch: () => void;
  onSelectCommit: (commit: CommitSummary) => void;
  onSelectWorking: () => void;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  onCommit: (message: string) => Promise<boolean>;
}) {
  const { t } = useTranslation("workspace");
  const [selectedCommitFile, setSelectedCommitFile] = useState<string | null>(null);
  const [selectedWorkingFile, setSelectedWorkingFile] = useState<SelectedWorkingFile | null>(null);
  const {
    changes,
    loading: changesLoading,
    error: changesError,
  } = useWorkingChanges(repo.id);

  const workingFileCount = changes.staged.length + changes.unstaged.length;

  useEffect(() => {
    setSelectedCommitFile(null);
  }, [selectedCommit?.id]);

  // A file that just got staged moves to the other list; keeping the old
  // selection would show a diff that no longer exists on that side.
  useEffect(() => {
    if (!selectedWorkingFile) return;
    const list = selectedWorkingFile.staged ? changes.staged : changes.unstaged;
    if (!list.some((file) => file.path === selectedWorkingFile.path)) setSelectedWorkingFile(null);
  }, [changes, selectedWorkingFile]);

  const diffTarget: { path: string; source: DiffSource } | null = workingSelected
    ? selectedWorkingFile
      ? {
          path: selectedWorkingFile.path,
          source: { kind: "working", staged: selectedWorkingFile.staged },
        }
      : null
    : selectedCommit && selectedCommitFile
      ? { path: selectedCommitFile, source: { kind: "commit", commitId: selectedCommit.id } }
      : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <RepoToolbar
        repo={repo}
        status={status}
        actionPending={actionPending}
        operationProgress={operationProgress}
        onBack={onBack}
        onAction={onAction}
        onCancelOperation={onCancelOperation}
        onCreateBranch={onCreateBranch}
        onOpenSearch={onOpenSearch}
      />

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

      <div className="grid min-h-0 flex-1 grid-cols-[15rem_minmax(0,1fr)] gap-4 xl:grid-cols-[15rem_minmax(0,1fr)_24rem]">
        <div className="min-h-0 overflow-y-auto">
          <RepoTree repoId={repo.id} onCheckout={onCheckout} />
        </div>

        <div className="min-h-0">
          {diffTarget ? (
            <FileDiffView
              repoId={repo.id}
              path={diffTarget.path}
              source={diffTarget.source}
              onBack={() =>
                workingSelected ? setSelectedWorkingFile(null) : setSelectedCommitFile(null)
              }
            />
          ) : (
            <div className="h-full min-h-0">
              <CommitGraph
                repoId={repo.id}
                currentBranch={status?.branch ?? null}
                selectedCommitId={selectedCommit?.id ?? null}
                onSelectCommit={onSelectCommit}
                workingFileCount={workingFileCount}
                workingSelected={workingSelected}
                onSelectWorking={onSelectWorking}
              />
            </div>
          )}
        </div>

        <div className="hidden min-h-0 xl:block">
          {workingSelected ? (
            <WorkingChangesPanel
              changes={changes}
              loading={changesLoading}
              error={changesError}
              busy={actionPending !== null}
              selectedFile={selectedWorkingFile}
              onSelectFile={setSelectedWorkingFile}
              onStage={onStage}
              onUnstage={onUnstage}
              onCommit={onCommit}
            />
          ) : selectedCommit ? (
            <CommitInspector
              repoId={repo.id}
              commit={selectedCommit}
              selectedFilePath={selectedCommitFile}
              onSelectFile={setSelectedCommitFile}
            />
          ) : (
            <Muted className="text-[12px]">{t("inspector.empty")}</Muted>
          )}
        </div>
      </div>
    </div>
  );
}
