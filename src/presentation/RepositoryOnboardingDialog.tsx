import { useId, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/presentation/ui";
import { useDialogFocusTrap } from "@/presentation/useDialogFocusTrap";

interface RepositoryOnboardingDialogProps {
  onOpenExisting: () => void;
  onScanFolder: () => void;
  onClone?: () => void;
  onCreate?: () => void;
  onClose: () => void;
}

export function RepositoryOnboardingDialog({
  onOpenExisting,
  onScanFolder,
  onClone,
  onCreate,
  onClose,
}: RepositoryOnboardingDialogProps) {
  const { t } = useTranslation("workspace");
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const actionIdPrefix = useId();
  useDialogFocusTrap(dialogRef, onClose);

  const actions = [
    { id: "openExisting", onSelect: onOpenExisting },
    { id: "scanFolder", onSelect: onScanFolder },
    { id: "clone", onSelect: onClone },
    { id: "create", onSelect: onCreate },
  ] as const;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4"
      onMouseDown={onClose}
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
          {t("repositoryOnboarding.title")}
        </h2>
        <p id={descriptionId} className="mt-1 text-[13px]" style={{ color: "var(--slate)" }}>
          {t("repositoryOnboarding.description")}
        </p>

        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {actions.map((action) => {
            const actionDescriptionId = `${actionIdPrefix}-${action.id}-description`;
            const unavailableId = `${actionIdPrefix}-${action.id}-unavailable`;
            const available = Boolean(action.onSelect);
            return (
              <button
                key={action.id}
                type="button"
                disabled={!available}
                aria-label={t(`repositoryOnboarding.actions.${action.id}.label`)}
                aria-describedby={`${actionDescriptionId}${available ? "" : ` ${unavailableId}`}`}
                onClick={() => {
                  onClose();
                  action.onSelect?.();
                }}
                className="interactive-control flex min-h-24 flex-col items-start rounded-lg border p-3 text-left transition-colors disabled:opacity-60"
                style={{
                  borderWidth: "0.5px",
                  borderColor: "var(--hairline-strong)",
                  background: "var(--page-bg)",
                  color: "var(--ink)",
                }}
              >
                <span className="text-[13px] font-medium">
                  {t(`repositoryOnboarding.actions.${action.id}.label`)}
                </span>
                <span
                  id={actionDescriptionId}
                  className="mt-1 text-[11px] leading-relaxed"
                  style={{ color: "var(--slate)" }}
                >
                  {t(`repositoryOnboarding.actions.${action.id}.description`)}
                </span>
                {!available ? (
                  <span
                    id={unavailableId}
                    className="mt-2 text-[10px] font-medium"
                    style={{ color: "var(--mist)" }}
                  >
                    {t("repositoryOnboarding.unavailable")}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>

        <div className="mt-4 flex justify-end">
          <Button onClick={onClose}>{t("context.cancel")}</Button>
        </div>
      </div>
    </div>
  );
}
