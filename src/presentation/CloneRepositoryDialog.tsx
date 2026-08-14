import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { userErrorMessage } from "@/application/errorMessage";
import type { CloneRepositoryRequest, CloneRepositoryResult } from "@/domain/workspace";
import { pickFolder } from "@/infrastructure/dialog";
import {
  invokeErrorCode,
  type OperationProgressEvent,
  type OperationTask,
} from "@/infrastructure/tauriClient";
import { Button, Input } from "@/presentation/ui";
import { useDialogFocusTrap } from "@/presentation/useDialogFocusTrap";

export function inferCloneDirectoryName(url: string): string {
  const withoutSuffix = url.trim().split(/[?#]/, 1)[0].replace(/[\\/]+$/, "");
  const leaf = withoutSuffix.split(/[\\/:]/).at(-1) ?? "";
  return leaf.endsWith(".git") ? leaf.slice(0, -4) : leaf;
}

function validDirectoryName(name: string): boolean {
  return name.length > 0 && name !== "." && name !== ".." && !/[\\/\0]/.test(name);
}

export function CloneRepositoryDialog({
  workspaceId,
  operations,
  onClone,
  onCancelOperation,
  onSuccess,
  onBack,
}: {
  workspaceId: string;
  operations: Record<string, OperationProgressEvent>;
  onClone: (request: CloneRepositoryRequest) => OperationTask<CloneRepositoryResult>;
  onCancelOperation: (operationId: string) => void;
  onSuccess: (result: CloneRepositoryResult) => void;
  onBack: () => void;
}) {
  const { t } = useTranslation("workspace");
  const dialogRef = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState("");
  const [destinationParent, setDestinationParent] = useState("");
  const [directoryName, setDirectoryName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [operationId, setOperationId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = operationId !== null;
  useDialogFocusTrap(dialogRef, pending ? () => undefined : onBack);
  const progress = operationId ? operations[operationId] : null;
  const progressPercent = progress?.total
    ? Math.min(100, Math.round((progress.completed / progress.total) * 100))
    : 0;
  const validation = useMemo(() => {
    if (!url.trim()) return t("clone.validation.url");
    if (!destinationParent) return t("clone.validation.destination");
    if (!validDirectoryName(directoryName.trim())) return t("clone.validation.name");
    return null;
  }, [destinationParent, directoryName, t, url]);

  async function submit() {
    if (validation || pending) return;
    setError(null);
    const started = onClone({
      workspaceId,
      url: url.trim(),
      destinationParent,
      directoryName: directoryName.trim(),
      branch: null,
    });
    setOperationId(started.operationId);
    try {
      onSuccess(await started.promise);
    } catch (reason) {
      if (invokeErrorCode(reason) !== "operation_cancelled") setError(userErrorMessage(reason));
    } finally {
      setOperationId(null);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4">
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={t("clone.title")}
        className="desktop-popover w-full max-w-md rounded-lg border p-4"
        style={{ background: "var(--paper)", borderColor: "var(--hairline-strong)" }}
      >
        <h2 className="text-sm font-semibold">{t("clone.title")}</h2>
        <p className="mt-1 text-[13px]" style={{ color: "var(--slate)" }}>
          {t("clone.description")}
        </p>
        <div className="mt-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-[12px]">
            {t("clone.url")}
            <Input
              autoFocus
              disabled={pending}
              value={url}
              onChange={(event) => {
                const next = event.target.value;
                setUrl(next);
                if (!nameEdited) setDirectoryName(inferCloneDirectoryName(next));
              }}
              placeholder={t("clone.urlPlaceholder")}
            />
          </label>
          <label className="flex flex-col gap-1 text-[12px]">
            {t("clone.destination")}
            <div className="flex gap-2">
              <Input className="min-w-0 flex-1" readOnly value={destinationParent} />
              <Button
                disabled={pending}
                onClick={() => void pickFolder().then((path) => path && setDestinationParent(path))}
              >
                {t("clone.choose")}
              </Button>
            </div>
          </label>
          <label className="flex flex-col gap-1 text-[12px]">
            {t("clone.directoryName")}
            <Input
              disabled={pending}
              value={directoryName}
              onChange={(event) => {
                setNameEdited(true);
                setDirectoryName(event.target.value);
              }}
            />
          </label>
        </div>
        {error ? (
          <p role="alert" className="mt-3 text-[12px]" style={{ color: "var(--rust-ink)" }}>
            {error}
          </p>
        ) : null}
        {pending ? (
          <div className="mt-3 flex items-center gap-2" role="status">
            <div
              role="progressbar"
              aria-label={t("clone.progress")}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress?.total ? progressPercent : undefined}
              className="h-1.5 w-24 overflow-hidden rounded-full"
              style={{ background: "var(--page-bg)" }}
            >
              <div
                className="h-full rounded-full"
                style={{ background: "var(--fjord)", width: `${progressPercent}%` }}
              />
            </div>
            <span className="flex-1 text-[12px]" style={{ color: "var(--slate)" }}>
              {progress?.message ?? t("clone.running")}
            </span>
            <Button size="sm" onClick={() => operationId && onCancelOperation(operationId)}>
              {t("operations.cancel")}
            </Button>
          </div>
        ) : validation ? (
          <p className="mt-3 text-[11px]" style={{ color: "var(--slate)" }}>
            {validation}
          </p>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <Button disabled={pending} onClick={onBack}>
            {t("clone.back")}
          </Button>
          <Button
            variant="primary"
            disabled={pending || Boolean(validation)}
            onClick={() => void submit()}
          >
            {pending ? t("clone.cloning") : t("clone.submit")}
          </Button>
        </div>
      </div>
    </div>
  );
}
