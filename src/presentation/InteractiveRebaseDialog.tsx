import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useInteractiveRebase } from "@/application/useInteractiveRebase";
import type { MergeDirtyPolicy, MergeSource, RebasePreflight, RebaseTodoAction, RebaseTodoStep } from "@/domain/git";
import { mergeSourceLabel } from "@/application/mergeBranchAction";
import { rebaseErrorKey } from "@/presentation/RebaseDialog";
import { useDialogFocusTrap } from "@/presentation/useDialogFocusTrap";
import { Button, Select, Textarea } from "@/presentation/ui";

type ActionKind = RebaseTodoAction["kind"];
const ACTION_KINDS: ActionKind[] = ["pick", "reword", "fixup", "squash", "drop"];

function actionFor(kind: ActionKind, previousMessage: string): RebaseTodoAction {
  if (kind === "reword" || kind === "squash") return { kind, message: previousMessage };
  return { kind };
}

function messageOf(action: RebaseTodoAction): string {
  return action.kind === "reword" || action.kind === "squash" ? action.message : "";
}

function validationError(steps: RebaseTodoStep[]): string | null {
  const surviving = steps.find((step) => step.action.kind !== "drop");
  if (!surviving) return "rebase.todo.errors.allDropped";
  if (surviving.action.kind === "fixup" || surviving.action.kind === "squash") return "rebase.todo.errors.firstIsFixupOrSquash";
  if (steps.some((step) => (step.action.kind === "reword" || step.action.kind === "squash") && !messageOf(step.action).trim())) {
    return "rebase.todo.errors.emptyMessage";
  }
  return null;
}

export function InteractiveRebaseDialog({ repoId, onto, currentBranch, pending, executionError, progress,
  onConfirm, onCancel, onClose }: {
  repoId: string; onto: MergeSource; currentBranch: string; pending: boolean;
  executionError: string | null; progress?: string | null;
  onConfirm: (preflight: RebasePreflight, steps: RebaseTodoStep[], policy: MergeDirtyPolicy) => void;
  onCancel: () => void; onClose: () => void;
}) {
  const { t } = useTranslation("workspace");
  const ref = useRef<HTMLDivElement>(null);
  const { todo, loading, error, errorCode } = useInteractiveRebase(repoId, onto);
  const [steps, setSteps] = useState<RebaseTodoStep[] | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const close = () => { if (!pending) onClose(); };
  useDialogFocusTrap(ref, close);

  useEffect(() => {
    if (todo && steps === null) setSteps(todo.steps);
  }, [todo, steps]);

  const values = { current: todo?.preflight.currentBranch ?? currentBranch, onto: todo?.preflight.ontoLabel ?? mergeSourceLabel(onto) };
  const blockers = todo?.preflight.blockers ?? [];
  const hard = blockers.some((code) => code !== "index_has_staged_changes" && code !== "would_overwrite");
  const stash = Boolean(todo && (todo.preflight.dirty.staged || todo.preflight.dirty.modified || todo.preflight.dirty.wouldOverwrite.length));
  const problem = steps ? validationError(steps) : null;

  function updateStep(index: number, patch: Partial<RebaseTodoStep>) {
    setSteps((current) => current ? current.map((step, i) => (i === index ? { ...step, ...patch } : step)) : current);
  }

  function moveStepTo(draggedCommitId: string, targetCommitId: string) {
    setSteps((current) => {
      if (!current || draggedCommitId === targetCommitId) return current;
      const from = current.findIndex((step) => step.commit === draggedCommitId);
      const to = current.findIndex((step) => step.commit === targetCommitId);
      if (from === -1 || to === -1) return current;
      const next = current.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }

  return <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4" onMouseDown={close}>
    <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t("rebase.todo.title", values)} aria-busy={pending || loading}
      className="desktop-popover flex max-h-[85vh] w-full max-w-2xl flex-col rounded-lg border p-4"
      style={{ background: "var(--paper)", borderColor: "var(--hairline-strong)" }} onMouseDown={(event) => event.stopPropagation()}>
      <h2 className="text-sm font-semibold">{t("rebase.todo.title", values)}</h2>
      <div className="mt-2 space-y-2 text-[13px]" aria-live="polite">
        {loading ? <p>{t("merge.loading")}</p> : null}
        {error ? <p role="alert">{t(rebaseErrorKey(errorCode), values)}</p> : null}
        {executionError ? <p role="alert">{executionError}</p> : null}
        {todo?.preflight.publishedRewrite ? <p className="rounded-md p-2" style={{ background: "var(--amber-tint)" }}>
          {t("rebase.published", { count: todo.preflight.publishedRewrite.commits })}
        </p> : null}
        {blockers.map((code) => <p key={code} role="alert">{t(`rebase.blocked.${code}`, values)}</p>)}
        {stash ? <p>{t("rebase.stashExplanation")}</p> : null}
        {problem ? <p role="alert">{t(problem)}</p> : null}
      </div>
      {steps ? <ul className="mt-3 min-h-0 flex-1 space-y-1 overflow-auto" aria-label={t("rebase.todo.stepsLabel")}>
        {steps.map((step, index) => {
          const dragging = draggedId === step.commit;
          const dropTarget = dropTargetId === step.commit;
          const showMessage = step.action.kind === "reword" || step.action.kind === "squash";
          return <li key={step.commit}
            draggable={!pending}
            onDragStart={(event) => { setDraggedId(step.commit); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", step.commit); }}
            onDragOver={(event) => { if (!draggedId || draggedId === step.commit) return; event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDropTargetId(step.commit); }}
            onDragLeave={() => setDropTargetId((current) => (current === step.commit ? null : current))}
            onDrop={(event) => { event.preventDefault(); const dragged = draggedId ?? event.dataTransfer.getData("text/plain"); setDraggedId(null); setDropTargetId(null); if (dragged) moveStepTo(dragged, step.commit); }}
            onDragEnd={() => { setDraggedId(null); setDropTargetId(null); }}
            className="rounded-md border p-2"
            style={{ borderColor: dropTarget ? "var(--fjord)" : "var(--hairline)", opacity: dragging ? 0.55 : 1 }}>
            <div className="flex items-center gap-2">
              <span aria-hidden="true" className="cursor-grab select-none opacity-60" title={t("rebase.todo.dragHandle")}>::</span>
              <code className="opacity-70">{step.shortId}</code>
              <span className="min-w-0 flex-1 truncate">{step.subject}</span>
              <Select aria-label={t("rebase.todo.actionLabel", { subject: step.subject })} disabled={pending}
                value={step.action.kind}
                onChange={(event) => updateStep(index, { action: actionFor(event.target.value as ActionKind, messageOf(step.action)) })}>
                {ACTION_KINDS.map((kind) => <option key={kind} value={kind}>{t(`rebase.todo.action.${kind}`)}</option>)}
              </Select>
            </div>
            {showMessage ? <Textarea className="mt-2 w-full" rows={2} disabled={pending}
              placeholder={t("rebase.todo.messagePlaceholder")}
              aria-label={t("rebase.todo.messageLabel", { subject: step.subject })}
              value={messageOf(step.action)}
              onChange={(event) => updateStep(index, { action: actionFor(step.action.kind as "reword" | "squash", event.target.value) })} /> : null}
          </li>;
        })}
      </ul> : null}
      {pending ? <p role="status" className="mt-2 text-[13px]">{progress || t("rebase.running")}</p> : null}
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={pending ? onCancel : onClose}>{pending ? t("rebase.cancelOperation") : t("merge.cancel")}</Button>
        <Button variant="primary" disabled={!todo || !steps || loading || Boolean(error) || hard || Boolean(problem) || pending}
          onClick={() => todo && steps && onConfirm(todo.preflight, steps, stash ? "stashFirst" : "refuse")}>
          {pending ? t("rebase.running") : stash ? t("rebase.todo.stashAndStart") : t("rebase.todo.start")}
        </Button>
      </div>
    </div>
  </div>;
}
