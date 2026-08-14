import { useId, useRef } from "react";
import { useTranslation } from "react-i18next";
import { updateCoordinator } from "@/application/update/UpdateCoordinator";
import { isDialogPhase } from "@/application/update/updateModel";
import { useUpdateState } from "@/application/update/useUpdateState";
import { Button, Muted } from "@/presentation/ui";
import { useDialogFocusTrap } from "@/presentation/useDialogFocusTrap";

/**
 * The one global update dialog — startup and manual checks both drive it
 * through the shared `updateCoordinator`, so there is never more than one of
 * these on screen (docs/releasing.md's runtime-update-check contract). Not
 * rendered for `up-to-date`/`check-failed`/idle/checking: those show inline
 * in Settings instead (see `SettingsDialog.tsx`'s About section).
 */
export function UpdateDialog() {
  const { t } = useTranslation("workspace");
  const snapshot = useUpdateState();
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  const dismissible =
    snapshot.phase === "available" || snapshot.phase === "update-failed" || snapshot.phase === "relaunch-failed";
  useDialogFocusTrap(dialogRef, dismissible ? () => updateCoordinator.close() : () => undefined);

  if (!isDialogPhase(snapshot.phase)) return null;

  const progress = snapshot.progress;
  const totalBytes = progress?.totalBytes ?? null;
  const downloadedBytes = progress?.downloadedBytes ?? 0;
  const ratio = totalBytes && totalBytes > 0 ? Math.min(1, downloadedBytes / totalBytes) : null;
  const relaunchOnly = snapshot.phase === "relaunch-failed";

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/30 p-4"
      onMouseDown={() => {
        if (dismissible) updateCoordinator.close();
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="desktop-popover w-full max-w-md rounded-lg border p-4"
        style={{ background: "var(--paper)", borderColor: "var(--hairline-strong)" }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {snapshot.phase === "available" && snapshot.info && (
          <>
            <h2 id={titleId} className="text-sm font-semibold" style={{ color: "var(--ink)" }}>
              {t("update.available.title")}
            </h2>
            <p id={descriptionId} className="mt-1 text-[13px]" style={{ color: "var(--slate)" }}>
              {t("update.available.description", {
                version: snapshot.info.version,
                currentVersion: snapshot.info.currentVersion,
              })}
            </p>
            {snapshot.info.notes && (
              <p
                className="mt-3 max-h-32 overflow-auto whitespace-pre-wrap text-[12px]"
                style={{ color: "var(--slate)" }}
              >
                {snapshot.info.notes}
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <Button onClick={() => updateCoordinator.later()}>{t("update.available.later")}</Button>
              <Button variant="primary" onClick={() => void updateCoordinator.updateAndRestart()}>
                {t("update.available.updateAndRestart")}
              </Button>
            </div>
          </>
        )}

        {snapshot.phase === "downloading" && (
          <>
            <h2 id={titleId} className="text-sm font-semibold" style={{ color: "var(--ink)" }}>
              {t("update.downloading.title")}
            </h2>
            <p id={descriptionId} className="mt-1 text-[13px]" style={{ color: "var(--slate)" }}>
              {totalBytes
                ? t("update.downloading.progressKnown", {
                    downloaded: formatMegabytes(downloadedBytes),
                    total: formatMegabytes(totalBytes),
                  })
                : t("update.downloading.progressUnknown", { downloaded: formatMegabytes(downloadedBytes) })}
            </p>
            <div
              className="mt-3 h-1.5 w-full overflow-hidden rounded-full"
              style={{ background: "var(--hairline)" }}
              role="progressbar"
              aria-label={t("update.downloading.title")}
              aria-valuenow={ratio === null ? undefined : Math.round(ratio * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className="h-full rounded-full transition-[width]"
                style={{ background: "var(--fjord)", width: ratio === null ? "35%" : `${Math.round(ratio * 100)}%` }}
              />
            </div>
            <Muted className="mt-3 block text-[11px]">{t("update.downloading.noCancel")}</Muted>
          </>
        )}

        {snapshot.phase === "relaunching" && (
          <>
            <h2 id={titleId} className="text-sm font-semibold" style={{ color: "var(--ink)" }}>
              {t("update.relaunching.title")}
            </h2>
            <p id={descriptionId} className="mt-1 text-[13px]" style={{ color: "var(--slate)" }}>
              {t("update.relaunching.description")}
            </p>
          </>
        )}

        {(snapshot.phase === "update-failed" || snapshot.phase === "relaunch-failed") && (
          <>
            <h2 id={titleId} className="text-sm font-semibold" style={{ color: "var(--rust-ink)" }}>
              {t("update.failed.title")}
            </h2>
            <p id={descriptionId} className="mt-1 text-[13px]" style={{ color: "var(--slate)" }}>
              {relaunchOnly ? t("update.failed.relaunchDescription") : t("update.failed.description")}
            </p>
            {snapshot.error && <Muted className="mt-2 block break-all text-[11px]">{snapshot.error}</Muted>}
            <div className="mt-4 flex justify-end gap-2">
              <Button onClick={() => updateCoordinator.close()}>{t("update.failed.close")}</Button>
              {!relaunchOnly && (
                <Button variant="primary" onClick={() => updateCoordinator.retry()}>
                  {t("update.failed.tryAgain")}
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
