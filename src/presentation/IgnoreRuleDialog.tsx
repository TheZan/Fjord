import { useRef } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { userErrorMessage } from "@/application/errorMessage";
import type { IgnoreRuleState } from "@/application/useWorkingFileActions";
import { invokeErrorCode } from "@/infrastructure/tauriClient";
import { Button } from "@/presentation/ui";
import { useDialogFocusTrap } from "@/presentation/useDialogFocusTrap";

export function IgnoreRuleDialog({
  state,
  onConfirm,
  onClose,
}: {
  state: IgnoreRuleState;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("workspace");
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocusTrap(dialogRef, state.pending ? () => undefined : onClose);
  const alreadyPresent = state.preview?.alreadyPresent || state.outcome === "alreadyPresent";
  const completed = state.outcome !== null;
  const error = ignoreError(state.error, t);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={t("workingFile.ignore.title")}
        className="desktop-popover w-full max-w-md rounded-lg border p-4"
        style={{ background: "var(--paper)", borderColor: "var(--hairline-strong)" }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 className="text-sm font-semibold" style={{ color: "var(--ink)" }}>
          {t("workingFile.ignore.title")}
        </h2>
        <p className="mt-1 text-[13px]" style={{ color: "var(--slate)" }}>
          {t("workingFile.ignore.description", { path: state.target.path })}
        </p>
        <div className="mt-4 flex flex-col gap-3 text-[13px]">
          {state.loading ? <p aria-live="polite">{t("workingFile.ignore.loading")}</p> : null}
          {state.preview ? (
            <div>
              <div style={{ color: "var(--slate)" }}>{t("workingFile.ignore.rulePreview")}</div>
              <code className="mt-1 block rounded border px-2 py-1.5" style={{ borderColor: "var(--hairline-strong)" }}>
                {state.preview.rule}
              </code>
            </div>
          ) : null}
          {alreadyPresent ? (
            <p role="status" style={{ color: "var(--slate)" }}>{t("workingFile.ignore.alreadyPresent")}</p>
          ) : null}
          {state.outcome === "added" ? (
            <p role="status" style={{ color: "var(--success)" }}>{t("workingFile.ignore.added")}</p>
          ) : null}
          {error ? <p role="alert" style={{ color: "var(--danger)" }}>{error}</p> : null}
          <div className="flex justify-end gap-2">
            <Button disabled={state.pending} onClick={onClose}>
              {completed || alreadyPresent ? t("workingFile.ignore.close") : t("context.cancel")}
            </Button>
            {!completed && !alreadyPresent ? (
              <Button
                variant="primary"
                disabled={state.loading || state.pending || !state.preview || Boolean(error)}
                onClick={onConfirm}
              >
                {state.pending ? t("workingFile.ignore.adding") : t("workingFile.ignore.confirm")}
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function ignoreError(error: unknown, t: TFunction<"workspace">): string | null {
  if (!error) return null;
  const code = invokeErrorCode(error);
  if (code === "ignore_file_encoding_unsupported") return t("workingFile.ignore.encodingUnsupported");
  if (code === "ignore_rule_unsupported_for_tracked_file") return t("workingFile.ignore.trackedFile");
  return userErrorMessage(error);
}
