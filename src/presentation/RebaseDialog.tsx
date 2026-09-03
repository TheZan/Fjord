import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { useRebaseBranch } from "@/application/useRebaseBranch";
import type { MergeDirtyPolicy, MergeSource, RebasePreflight } from "@/domain/git";
import { mergeSourceLabel } from "@/application/mergeBranchAction";
import { useDialogFocusTrap } from "@/presentation/useDialogFocusTrap";
import { Button } from "@/presentation/ui";

export function RebaseDialog({ repoId, onto, currentBranch, pending, executionError, progress,
  onConfirm, onCancel, onClose }: {
  repoId: string; onto: MergeSource; currentBranch: string; pending: boolean;
  executionError: string | null; progress?: string | null;
  onConfirm: (preflight: RebasePreflight, policy: MergeDirtyPolicy) => void;
  onCancel: () => void; onClose: () => void;
}) {
  const { t } = useTranslation("workspace");
  const ref = useRef<HTMLDivElement>(null);
  const { preflight, loading, error, errorCode } = useRebaseBranch(repoId, onto);
  const close = () => { if (!pending) onClose(); };
  useDialogFocusTrap(ref, close);
  const values = { current: preflight?.currentBranch ?? currentBranch, onto: preflight?.ontoLabel ?? mergeSourceLabel(onto) };
  const blockers = preflight?.blockers ?? [];
  const hard = blockers.some((code) => code !== "index_has_staged_changes" && code !== "would_overwrite");
  const stash = Boolean(preflight && (preflight.dirty.staged || preflight.dirty.modified || preflight.dirty.wouldOverwrite.length));
  const noOp = preflight?.alreadyUpToDate;
  return <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4" onMouseDown={close}>
    <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t("rebase.title", values)} aria-busy={pending || loading}
      className="desktop-popover w-full max-w-lg rounded-lg border p-4"
      style={{ background: "var(--paper)", borderColor: "var(--hairline-strong)" }} onMouseDown={(event) => event.stopPropagation()}>
      <h2 className="text-sm font-semibold">{t("rebase.title", values)}</h2>
      <div className="mt-3 space-y-2 text-[13px]" aria-live="polite">
        {loading ? <p>{t("merge.loading")}</p> : null}
        {error ? <p role="alert">{t(rebaseErrorKey(errorCode), values)}</p> : null}
        {executionError ? <p role="alert">{executionError}</p> : null}
        {preflight ? <>
          <p>{noOp ? t("rebase.noOp", values) : t("rebase.prediction", { ...values, count: preflight.commits })}</p>
          {preflight.publishedRewrite ? <p className="rounded-md p-2" style={{ background: "var(--amber-tint)" }}>
            {t("rebase.published", { count: preflight.publishedRewrite.commits })}
          </p> : null}
          {blockers.map((code) => <p key={code} role="alert">{t(`rebase.blocked.${code}`, values)}</p>)}
          {preflight.dirty.wouldOverwrite.length ? <ul className="max-h-32 overflow-auto">
            {preflight.dirty.wouldOverwrite.map((path) => <li key={path}>{path}</li>)}
          </ul> : null}
          {stash && !noOp ? <p>{t("rebase.stashExplanation")}</p> : null}
        </> : null}
        {pending ? <p role="status">{progress || t("rebase.running")}</p> : null}
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={pending ? onCancel : onClose}>{pending ? t("rebase.cancelOperation") : t("merge.cancel")}</Button>
        {!noOp ? <Button variant="primary" disabled={!preflight || loading || Boolean(error) || hard || pending}
          onClick={() => preflight && onConfirm(preflight, stash ? "stashFirst" : "refuse")}>
          {pending ? t("rebase.running") : stash ? t("rebase.stashAndRebase") : t("rebase.confirm")}
        </Button> : null}
      </div>
    </div>
  </div>;
}

export function rebaseErrorKey(code: string | null) {
  if (code === "preflight_stale") return "rebase.stale";
  if (code === "operation_already_in_progress") return "rebase.blocked.operation_already_in_progress";
  const blocker = code?.replace(/^integration_/, "");
  return blocker && ["target_is_current_branch", "target_not_found", "target_unsupported", "detached_head", "unborn_head", "index_has_staged_changes", "would_overwrite"].includes(blocker)
    ? `rebase.blocked.${blocker}` : "rebase.failed";
}
