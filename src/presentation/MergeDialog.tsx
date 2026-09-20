import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { mergeSourceLabel, mergeSourceRemoteName } from "@/application/mergeBranchAction";
import { useMergeBranch } from "@/application/useMergeBranch";
import type {
  MergeDirtyPolicy,
  MergeMode,
  MergePreflight,
  MergeSource,
} from "@/domain/git";
import { Button } from "@/presentation/ui";
import { useDialogFocusTrap } from "@/presentation/useDialogFocusTrap";

export function MergeDialog({
  repoId,
  source,
  currentBranch,
  pending,
  onConfirm,
  onClose,
}: {
  repoId: string;
  source: MergeSource;
  currentBranch: string;
  pending: boolean;
  onConfirm: (
    mode: MergeMode,
    dirtyPolicy: MergeDirtyPolicy,
    fetchFirst: boolean,
    allowUnrelatedHistories: boolean,
  ) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("workspace");
  const dialogRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<MergeMode>("default");
  const [fetchFirst, setFetchFirst] = useState(false);
  const [allowUnrelatedHistories, setAllowUnrelatedHistories] = useState(false);
  const { preflight, loading, error, errorCode } = useMergeBranch(repoId, source);
  const remoteName = mergeSourceRemoteName(source);
  useDialogFocusTrap(dialogRef, onClose);

  const sourceLabel = preflight?.sourceLabel ?? mergeSourceLabel(source);
  const target = preflight?.targetBranch ?? currentBranch;
  const dirtyBlocked = Boolean(
    preflight?.blockers.some((blocker) =>
      blocker === "merge_index_has_staged_changes" || blocker === "merge_would_overwrite"
    ),
  );
  const hardBlockers = preflight?.blockers.filter((blocker) =>
    blocker !== "merge_index_has_staged_changes" && blocker !== "merge_would_overwrite"
  ) ?? [];
  const alreadyUpToDate = preflight?.prediction.kind === "alreadyUpToDate";
  const unrelated = preflight?.prediction.kind === "unrelated";

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4"
      onMouseDown={pending ? undefined : onClose}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={t("merge.title", { source: sourceLabel, target })}
        className="desktop-popover w-full max-w-lg rounded-lg border p-4"
        style={{ background: "var(--paper)", borderColor: "var(--hairline-strong)" }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 className="text-sm font-semibold" style={{ color: "var(--ink)" }}>
          {t("merge.title", { source: sourceLabel, target })}
        </h2>

        <div className="mt-3 text-[13px]" style={{ color: "var(--slate)" }}>
          {loading ? <p>{t("merge.loading")}</p> : null}
          {error ? (
            <p role="alert" style={{ color: "var(--rust-ink)" }}>
              {preflightErrorText(errorCode, sourceLabel, target, error, t)}
            </p>
          ) : null}
          {preflight ? <p>{predictionText(preflight, mode, t)}</p> : null}
          {remoteName && preflight ? (
            <div className="mt-2">
              <p>{t("merge.remote.knownCommit", { sha: preflight.sourceCommit.slice(0, 7) })}</p>
              <p>{t("merge.remote.explanation")}</p>
            </div>
          ) : null}
          {dirtyBlocked ? (
            <div className="mt-3 rounded-md px-3 py-2" style={{ background: "var(--amber-tint)" }}>
              <p className="font-medium" style={{ color: "var(--amber-ink)" }}>{t("merge.dirty.title")}</p>
              {preflight?.dirty.staged ? (
                <p>{t("merge.blocked.stagedChanges", { count: preflight.dirty.staged })}</p>
              ) : null}
              {preflight?.dirty.wouldOverwrite.length ? (
                <p>{t("merge.blocked.wouldOverwrite", { count: preflight.dirty.wouldOverwrite.length })}</p>
              ) : null}
            </div>
          ) : null}
          {hardBlockers.map((blocker) => (
            <p key={blocker} className="mt-2" role="alert" style={{ color: "var(--rust-ink)" }}>
              {blockerText(blocker, sourceLabel, target, t)}
            </p>
          ))}
        </div>

        {!alreadyUpToDate && hardBlockers.length === 0 ? (
          <fieldset className="mt-4 flex flex-col gap-2 text-[13px]" disabled={pending || loading}>
            <legend className="mb-1 font-medium" style={{ color: "var(--slate)" }}>
              {t("merge.mode.label")}
            </legend>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="merge-mode"
                value="default"
                checked={mode === "default"}
                onChange={() => setMode("default")}
              />
              {t("merge.mode.default")}
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="merge-mode"
                value="fastForwardOnly"
                checked={mode === "fastForwardOnly"}
                onChange={() => setMode("fastForwardOnly")}
              />
              {t("merge.mode.fastForwardOnly")}
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="merge-mode"
                value="noFastForward"
                checked={mode === "noFastForward"}
                onChange={() => setMode("noFastForward")}
              />
              {t("merge.mode.noFastForward")}
            </label>
          </fieldset>
        ) : null}

        {!alreadyUpToDate && hardBlockers.length === 0 && remoteName ? (
          <label className="mt-3 flex items-center gap-2 text-[13px]" style={{ color: "var(--slate)" }}>
            <input
              type="checkbox"
              checked={fetchFirst}
              disabled={pending || loading}
              onChange={(event) => setFetchFirst(event.target.checked)}
            />
            {t("merge.remote.fetchFirst", { remote: remoteName })}
          </label>
        ) : null}

        {unrelated && hardBlockers.length === 0 ? (
          <label className="mt-3 flex items-center gap-2 text-[13px]" style={{ color: "var(--slate)" }}>
            <input
              type="checkbox"
              checked={allowUnrelatedHistories}
              disabled={pending || loading}
              onChange={(event) => setAllowUnrelatedHistories(event.target.checked)}
            />
            {t("merge.unrelated.acknowledge")}
          </label>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={onClose} disabled={pending}>
            {alreadyUpToDate ? t("merge.dismiss") : t("merge.cancel")}
          </Button>
          {!alreadyUpToDate && hardBlockers.length === 0 && preflight ? (
            <Button
              variant="primary"
              disabled={pending || loading || (unrelated && !allowUnrelatedHistories)}
              onClick={() => onConfirm(
                mode,
                dirtyBlocked ? "stashFirst" : "refuse",
                fetchFirst,
                allowUnrelatedHistories,
              )}
            >
              {pending
                ? t("merge.running")
                : dirtyBlocked
                  ? t("merge.dirty.stashAndMerge")
                  : t("merge.confirm")}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export { mergeSourceLabel } from "@/application/mergeBranchAction";

/// The preflight prediction is mode-independent: it is computed before a mode is
/// chosen. The sentence the user reads is not — `noFastForward` records a merge
/// commit exactly where the prediction says a fast-forward is possible.
export function predictionText(
  preflight: MergePreflight,
  mode: MergeMode,
  t: (key: string, values?: Record<string, unknown>) => string,
) {
  const values = { source: preflight.sourceLabel, target: preflight.targetBranch };
  switch (preflight.prediction.kind) {
    case "alreadyUpToDate":
      return t("merge.prediction.alreadyUpToDate", values);
    case "fastForward":
      return t(
        mode === "noFastForward"
          ? "merge.prediction.fastForwardNoFf"
          : "merge.prediction.fastForward",
        { ...values, count: preflight.prediction.commits },
      );
    case "mergeCommit":
      return t("merge.prediction.mergeCommit", {
        ...values,
        ahead: preflight.prediction.ahead,
        behind: preflight.prediction.behind,
      });
    case "unrelated":
      return t("merge.prediction.unrelated", values);
  }
}

export function blockerText(
  blocker: string,
  source: string,
  target: string,
  t: (key: string, values?: Record<string, unknown>) => string,
) {
  const keys: Record<string, string> = {
    merge_source_is_current_branch: "merge.blocked.sourceIsCurrentBranch",
    merge_source_not_found: "merge.blocked.sourceNotFound",
    merge_source_unsupported: "merge.blocked.sourceKindUnsupported",
    operation_already_in_progress: "merge.blocked.operationInProgress",
    merge_detached_head: "merge.blocked.detachedHead",
    merge_unborn_head: "merge.blocked.unbornHead",
  };
  return t(keys[blocker] ?? "merge.error.failed", { source, target });
}

export function preflightErrorText(
  code: string | null,
  source: string,
  target: string,
  fallback: string,
  t: (key: string, values?: Record<string, unknown>) => string,
) {
  const blocker = code === "merge_source_not_found"
    ? "merge_source_not_found"
    : code === "merge_source_unsupported"
      ? "merge_source_unsupported"
      : code === "merge_detached_head"
        ? "merge_detached_head"
        : code === "merge_unborn_head"
          ? "merge_unborn_head"
          : null;
  return blocker ? blockerText(blocker, source, target, t) : fallback;
}
