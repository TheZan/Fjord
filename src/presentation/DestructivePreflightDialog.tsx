import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  Consequence,
  DestructiveAction,
  DestructivePreflight,
  GenerationSet,
  PatchSelection,
} from "@/domain/generated";
import { preflightDestructiveAction } from "@/infrastructure/tauriClient";
import { Button } from "@/presentation/ui";
import { useDialogFocusTrap } from "@/presentation/useDialogFocusTrap";

type PreflightLoader = (
  repoId: string,
  action: DestructiveAction,
  patchSelection: PatchSelection,
) => Promise<DestructivePreflight>;

export function DestructivePreflightDialog({
  repoId,
  action,
  patchSelection,
  onConfirm,
  onClose,
  loadPreflight = preflightDestructiveAction,
}: {
  repoId: string;
  action: DestructiveAction;
  patchSelection: PatchSelection;
  onConfirm: (generations: GenerationSet, confirmationToken: string) => Promise<void> | void;
  onClose: () => void;
  loadPreflight?: PreflightLoader;
}) {
  const { t } = useTranslation("workspace");
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const blockerId = useId();
  const [preflight, setPreflight] = useState<DestructivePreflight | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const [changed, setChanged] = useState(false);
  useDialogFocusTrap(dialogRef, onClose);

  useEffect(() => {
    let active = true;
    setError(false);
    void loadPreflight(repoId, action, patchSelection)
      .then((result) => {
        if (active) setPreflight(result);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [action, loadPreflight, patchSelection, repoId]);

  const actionName = action.kind === "discard" ? "discard" : "forceWithLease";
  const blocked = Boolean(preflight?.blockers.length);

  async function confirm() {
    if (!preflight || !preflight.confirmationToken || blocked || pending) return;
    setPending(true);
    setError(false);
    try {
      const fresh = await loadPreflight(repoId, action, patchSelection);
      if (!samePreflight(preflight, fresh)) {
        setPreflight(fresh);
        setChanged(true);
        return;
      }
      if (!fresh.confirmationToken) throw new Error("preflight did not issue a confirmation");
      await onConfirm(fresh.generations, fresh.confirmationToken);
    } catch {
      setError(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4"
      onMouseDown={() => {
        if (!pending) onClose();
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="desktop-popover w-full max-w-lg rounded-lg border p-4"
        style={{ background: "var(--paper)", borderColor: "var(--hairline-strong)" }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id={titleId} className="text-sm font-semibold" style={{ color: "var(--ink)" }}>
          {t(`preflight.${actionName}.title`)}
        </h2>
        <p id={descriptionId} className="mt-1 text-[13px]" style={{ color: "var(--slate)" }}>
          {t("preflight.description")}
        </p>

        {!preflight && !error ? (
          <p className="mt-4 text-[13px]" role="status">
            {t("preflight.loading")}
          </p>
        ) : null}

        {preflight ? (
          <div className="mt-4 flex flex-col gap-3 text-[13px]">
            <ul className="flex list-disc flex-col gap-2 pl-5">
              {preflight.consequences.map((consequence, index) => (
                <ConsequenceItem key={`${consequence.kind}-${index}`} consequence={consequence} />
              ))}
            </ul>

            {action.kind === "forceWithLease" ? (
              <p className="font-mono text-[11px]" style={{ color: "var(--mist)" }}>
                {t("preflight.forceWithLease.expectedOid", { oid: action.expectedOid })}
              </p>
            ) : null}

            <p style={{ color: "var(--slate)" }}>
              {t(`preflight.recoverability.${preflight.recoverable}`)}
            </p>

            {preflight.blockers.length ? (
              <div id={blockerId} role="alert" className="rounded-md border p-3" style={{ borderColor: "var(--rust)" }}>
                <p className="font-medium">{t("preflight.blocked")}</p>
                <ul className="mt-1 list-disc pl-5">
                  {preflight.blockers.map((blocker) => (
                    <li key={blocker}>{t(`preflight.blockers.${blocker}`)}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {changed ? <p role="alert">{t("preflight.changed")}</p> : null}
          </div>
        ) : null}

        {error ? <p className="mt-4 text-[13px]" role="alert">{t("preflight.error")}</p> : null}

        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={onClose} disabled={pending}>{t("context.cancel")}</Button>
          <Button
            variant="danger"
            disabled={!preflight?.confirmationToken || blocked || pending || error}
            aria-describedby={blocked ? blockerId : undefined}
            onClick={() => void confirm()}
          >
            {pending ? t("preflight.revalidating") : t(`preflight.${actionName}.confirm`)}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ConsequenceItem({ consequence }: { consequence: Consequence }) {
  const { t } = useTranslation("workspace");
  switch (consequence.kind) {
    case "modifiedFilesDiscarded":
      return <li>{t("preflight.consequences.modifiedFilesDiscarded", consequence)}</li>;
    case "modifiedLinesDiscarded":
      return <li>{t("preflight.consequences.modifiedLinesDiscarded", consequence)}</li>;
    case "untrackedFilesDeleted":
      return <li>{t("preflight.consequences.untrackedFilesDeleted", consequence)}</li>;
    case "stagedChangesDiscarded":
      return <li>{t("preflight.consequences.stagedChangesDiscarded", consequence)}</li>;
    case "commitsUnreachable":
      return (
        <li>
          {t("preflight.consequences.commitsUnreachable", consequence)}
          {consequence.sample.length ? (
            <ul className="mt-1 list-disc pl-5" aria-label={t("preflight.commitSample")}>
              {consequence.sample.map((commit) => (
                <li key={commit.id}>{commit.message.split("\n", 1)[0]}</li>
              ))}
            </ul>
          ) : null}
        </li>
      );
    case "branchDeleted":
      return <li>{t("preflight.consequences.branchDeleted", consequence)}</li>;
    case "stashEntryConsumed":
      return <li>{t("preflight.consequences.stashEntryConsumed", consequence)}</li>;
    case "remoteRefUpdated":
      return <li>{t("preflight.consequences.remoteRefUpdated", consequence)}</li>;
  }
}

function samePreflight(left: DestructivePreflight, right: DestructivePreflight) {
  const { confirmationToken: _leftToken, ...leftFacts } = left;
  const { confirmationToken: _rightToken, ...rightFacts } = right;
  return JSON.stringify(leftFacts) === JSON.stringify(rightFacts);
}
