import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { useMergeBranch } from "@/application/useMergeBranch";
import type { MergeDirtyPolicy, MergeSource } from "@/domain/git";
import { blockerText, mergeSourceLabel, predictionText, preflightErrorText } from "@/presentation/MergeDialog";
import { Button } from "@/presentation/ui";
import { useDialogFocusTrap } from "@/presentation/useDialogFocusTrap";

/**
 * `git merge --squash`: shares `MergeDialog`'s preflight, blockers, and dirty
 * (stash-first) policy exactly, since a squash starts from the same real
 * ahead/behind/blocker facts as an ordinary merge. It has no mode selector
 * (squash never fast-forwards) and confirms into a single "stage the diff"
 * outcome rather than a merge commit.
 */
export function SquashMergeDialog({
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
  onConfirm: (dirtyPolicy: MergeDirtyPolicy) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("workspace");
  const dialogRef = useRef<HTMLDivElement>(null);
  const { preflight, loading, error, errorCode } = useMergeBranch(repoId, source);
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
        aria-label={t("squashMerge.title", { source: sourceLabel, target })}
        className="desktop-popover w-full max-w-lg rounded-lg border p-4"
        style={{ background: "var(--paper)", borderColor: "var(--hairline-strong)" }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 className="text-sm font-semibold" style={{ color: "var(--ink)" }}>
          {t("squashMerge.title", { source: sourceLabel, target })}
        </h2>

        <div className="mt-3 text-[13px]" style={{ color: "var(--slate)" }}>
          {loading ? <p>{t("squashMerge.loading")}</p> : null}
          {error ? (
            <p role="alert" style={{ color: "var(--rust-ink)" }}>
              {preflightErrorText(errorCode, sourceLabel, target, error, t)}
            </p>
          ) : null}
          {preflight ? (
            <p>
              {alreadyUpToDate
                ? predictionText(preflight, t)
                : t("squashMerge.explanation", { source: sourceLabel, target })}
            </p>
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

        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={onClose} disabled={pending}>
            {alreadyUpToDate ? t("squashMerge.dismiss") : t("squashMerge.cancel")}
          </Button>
          {!alreadyUpToDate && hardBlockers.length === 0 && preflight ? (
            <Button
              variant="primary"
              disabled={pending || loading}
              onClick={() => onConfirm(dirtyBlocked ? "stashFirst" : "refuse")}
            >
              {pending
                ? t("squashMerge.running")
                : dirtyBlocked
                  ? t("squashMerge.dirty.stashAndSquashMerge")
                  : t("squashMerge.confirm")}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
