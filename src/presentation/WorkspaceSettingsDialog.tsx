import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { userErrorMessage } from "@/application/errorMessage";
import type { Workspace } from "@/domain/workspace";
import { Button, Input } from "@/presentation/ui";
import { useDialogFocusTrap } from "@/presentation/useDialogFocusTrap";

/**
 * Per-workspace settings. Deliberately one field: expected branch belongs to a
 * specific workspace, not to global application Settings, and P10-09 is not the
 * place to grow a settings subsystem (docs/specs/workspace-workflows.md §5).
 *
 * Nothing here touches Git. Saving changes Fjord workspace metadata and the
 * derived health projection follows; no branch is ever checked out.
 */
export function WorkspaceSettingsDialog({
  workspace,
  onSave,
  onClose,
}: {
  workspace: Workspace;
  onSave: (expectedBranch: string | null) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation("workspace");
  const dialogRef = useRef<HTMLDivElement>(null);
  const expectedBranchId = useId();
  const [expectedBranch, setExpectedBranch] = useState(workspace.expectedBranch ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useDialogFocusTrap(dialogRef, pending ? () => undefined : onClose);

  async function submit() {
    if (pending) return;
    // The backend normalizes too — this mirrors it so an unchanged value never
    // becomes a pointless mutation and health invalidation.
    const normalized = expectedBranch.trim() || null;
    if (normalized === (workspace.expectedBranch ?? null)) {
      onClose();
      return;
    }

    setError(null);
    setPending(true);
    try {
      await onSave(normalized);
      onClose();
    } catch (reason) {
      setError(userErrorMessage(reason));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4">
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={t("workspaceSettings.title")}
        className="desktop-popover w-full max-w-md rounded-lg border p-4"
        style={{ background: "var(--paper)", borderColor: "var(--hairline-strong)" }}
      >
        <h2 className="text-sm font-semibold">{t("workspaceSettings.title")}</h2>
        <p className="mt-1 truncate text-[13px]" style={{ color: "var(--slate)" }}>
          {t("workspaceSettings.forWorkspace", { workspace: workspace.name })}
        </p>
        <div className="mt-4 flex flex-col gap-1">
          <label className="text-[12px]" htmlFor={expectedBranchId}>
            {t("workspaceSettings.expectedBranch")}
          </label>
          <Input
            id={expectedBranchId}
            autoFocus
            disabled={pending}
            value={expectedBranch}
            onChange={(event) => setExpectedBranch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submit();
            }}
            placeholder={t("workspaceSettings.expectedBranchPlaceholder")}
          />
          <p className="mt-1 text-[12px]" style={{ color: "var(--slate)" }}>
            {t("workspaceSettings.expectedBranchDescription")}
          </p>
          <p className="text-[12px]" style={{ color: "var(--slate)" }}>
            {t("workspaceSettings.expectedBranchEmpty")}
          </p>
        </div>
        {error ? (
          <p role="alert" className="mt-3 text-[12px]" style={{ color: "var(--rust-ink)" }}>
            {error}
          </p>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <Button disabled={pending} onClick={onClose}>
            {t("workspaces.cancel")}
          </Button>
          <Button variant="primary" disabled={pending} onClick={() => void submit()}>
            {t("workspaces.save")}
          </Button>
        </div>
      </div>
    </div>
  );
}
