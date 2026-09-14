import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { StashEntry } from "@/domain/git";
import { Button } from "@/presentation/ui";
import { useDialogFocusTrap } from "@/presentation/useDialogFocusTrap";

export function StashApplyOptionsDialog({
  action,
  stash,
  pending = false,
  onClose,
  onConfirm,
}: {
  action: "apply" | "pop";
  stash: StashEntry;
  pending?: boolean;
  onClose: () => void;
  onConfirm: (restoreIndex: boolean) => void;
}) {
  const { t } = useTranslation("workspace");
  const dialogRef = useRef<HTMLDivElement>(null);
  const [restoreIndex, setRestoreIndex] = useState(false);
  useDialogFocusTrap(dialogRef, onClose);
  const unavailableReason = stash.hasIndexState
    ? undefined
    : t("stash.options.restoreIndexUnavailable");

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
        aria-label={t(`stash.options.${action}Title`)}
        className="desktop-popover w-full max-w-md rounded-lg border p-4"
        style={{ background: "var(--paper)", borderColor: "var(--hairline-strong)" }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 className="text-sm font-semibold" style={{ color: "var(--ink)" }}>
          {t(`stash.options.${action}Title`)}
        </h2>
        <p className="mt-2 text-[13px]" style={{ color: "var(--slate)" }}>
          {t(`stash.options.${action}Description`, { title: stash.title })}
        </p>
        <label
          className="mt-4 flex items-start gap-2 text-[13px]"
          title={unavailableReason}
          style={{ color: unavailableReason ? "var(--mist)" : "var(--slate)" }}
        >
          <input
            type="checkbox"
            checked={restoreIndex}
            disabled={pending || !stash.hasIndexState}
            onChange={(event) => setRestoreIndex(event.target.checked)}
          />
          <span>
            {t("stash.options.restoreIndex")}
            {unavailableReason ? <span className="mt-1 block text-[11px]">{unavailableReason}</span> : null}
          </span>
        </label>
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={onClose} disabled={pending}>{t("stash.options.cancel")}</Button>
          <Button variant="primary" disabled={pending} onClick={() => onConfirm(restoreIndex)}>
            {t(`stash.options.${action}Confirm`)}
          </Button>
        </div>
      </div>
    </div>
  );
}
