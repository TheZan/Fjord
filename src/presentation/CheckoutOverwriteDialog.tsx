import { useId, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/presentation/ui";
import { useDialogFocusTrap } from "@/presentation/useDialogFocusTrap";

const PATH_SAMPLE_LIMIT = 8;

export function CheckoutOverwriteDialog({
  branch,
  paths,
  pending,
  onCancel,
  onStash,
  onDiscard,
}: {
  branch: string;
  paths: string[];
  pending: boolean;
  onCancel: () => void;
  onStash: () => void;
  onDiscard: () => void;
}) {
  const { t } = useTranslation("workspace");
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useDialogFocusTrap(dialogRef, pending ? () => undefined : onCancel);
  const sample = paths.slice(0, PATH_SAMPLE_LIMIT);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4"
      onMouseDown={() => {
        if (!pending) onCancel();
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
          {t("checkoutOverwrite.title")}
        </h2>
        <p id={descriptionId} className="mt-1 text-[13px]" style={{ color: "var(--slate)" }}>
          {t("checkoutOverwrite.description", { branch, count: paths.length })}
        </p>
        {sample.length ? (
          <ul
            className="mt-3 max-h-40 list-disc overflow-auto pl-5 font-mono text-[11px]"
            aria-label={t("checkoutOverwrite.files")}
          >
            {sample.map((path) => <li key={path}>{path}</li>)}
          </ul>
        ) : null}
        {paths.length > sample.length ? (
          <p className="mt-2 text-[11px]" style={{ color: "var(--mist)" }}>
            {t("checkoutOverwrite.moreFiles", { count: paths.length - sample.length })}
          </p>
        ) : null}
        <p className="mt-3 text-[13px]" style={{ color: "var(--slate)" }}>
          {t("checkoutOverwrite.stashExplanation")}
        </p>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button onClick={onCancel} disabled={pending}>{t("context.cancel")}</Button>
          <Button variant="danger" onClick={onDiscard} disabled={pending}>
            {t("checkoutOverwrite.discard")}
          </Button>
          <Button variant="primary" onClick={onStash} disabled={pending}>
            {pending ? t("checkoutOverwrite.stashing") : t("checkoutOverwrite.stash")}
          </Button>
        </div>
      </div>
    </div>
  );
}
