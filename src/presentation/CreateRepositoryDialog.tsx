import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { userErrorMessage } from "@/application/errorMessage";
import type { CreateRepositoryRequest, CreateRepositoryResult } from "@/domain/workspace";
import { pickFolder } from "@/infrastructure/dialog";
import { Button, Input } from "@/presentation/ui";
import { useDialogFocusTrap } from "@/presentation/useDialogFocusTrap";

function validDirectoryName(name: string): boolean {
  return name.length > 0 && name !== "." && name !== ".." && !/[\\/\0]/.test(name);
}

function validInitialBranch(name: string): boolean {
  return (
    name.length > 0 &&
    !/[\s~^:?*[\\\0]/.test(name) &&
    !name.startsWith(".") &&
    !name.startsWith("/") &&
    !name.endsWith(".") &&
    !name.endsWith("/") &&
    !name.endsWith(".lock") &&
    !name.includes("..") &&
    !name.includes("@{") &&
    !name.includes("//")
  );
}

export function CreateRepositoryDialog({
  workspaceId,
  onCreate,
  onSuccess,
  onBack,
}: {
  workspaceId: string;
  onCreate: (request: CreateRepositoryRequest) => Promise<CreateRepositoryResult>;
  onSuccess: (result: CreateRepositoryResult) => void;
  onBack: () => void;
}) {
  const { t } = useTranslation("workspace");
  const dialogRef = useRef<HTMLDivElement>(null);
  const [directoryName, setDirectoryName] = useState("");
  const [destinationParent, setDestinationParent] = useState("");
  const [initialBranch, setInitialBranch] = useState("main");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useDialogFocusTrap(dialogRef, pending ? () => undefined : onBack);

  const validation = useMemo(() => {
    if (!validDirectoryName(directoryName.trim())) return t("createRepository.validation.name");
    if (!destinationParent) return t("createRepository.validation.destination");
    if (!validInitialBranch(initialBranch.trim())) return t("createRepository.validation.branch");
    return null;
  }, [destinationParent, directoryName, initialBranch, t]);

  async function submit() {
    if (validation || pending) return;
    setError(null);
    setPending(true);
    try {
      onSuccess(
        await onCreate({
          workspaceId,
          destinationParent,
          directoryName: directoryName.trim(),
          initialBranch: initialBranch.trim(),
        }),
      );
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
        aria-label={t("createRepository.title")}
        className="desktop-popover w-full max-w-md rounded-lg border p-4"
        style={{ background: "var(--paper)", borderColor: "var(--hairline-strong)" }}
      >
        <h2 className="text-sm font-semibold">{t("createRepository.title")}</h2>
        <p className="mt-1 text-[13px]" style={{ color: "var(--slate)" }}>
          {t("createRepository.description")}
        </p>
        <div className="mt-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-[12px]">
            {t("createRepository.name")}
            <Input
              autoFocus
              disabled={pending}
              value={directoryName}
              onChange={(event) => setDirectoryName(event.target.value)}
              placeholder={t("createRepository.namePlaceholder")}
            />
          </label>
          <label className="flex flex-col gap-1 text-[12px]">
            {t("createRepository.destination")}
            <div className="flex gap-2">
              <Input className="min-w-0 flex-1" readOnly value={destinationParent} />
              <Button
                disabled={pending}
                onClick={() => void pickFolder().then((path) => path && setDestinationParent(path))}
              >
                {t("createRepository.choose")}
              </Button>
            </div>
          </label>
          <label className="flex flex-col gap-1 text-[12px]">
            {t("createRepository.initialBranch")}
            <Input
              disabled={pending}
              value={initialBranch}
              onChange={(event) => setInitialBranch(event.target.value)}
            />
          </label>
        </div>
        {error ? (
          <p role="alert" className="mt-3 text-[12px]" style={{ color: "var(--rust-ink)" }}>
            {error}
          </p>
        ) : validation ? (
          <p className="mt-3 text-[11px]" style={{ color: "var(--slate)" }}>
            {validation}
          </p>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <Button disabled={pending} onClick={onBack}>
            {t("createRepository.back")}
          </Button>
          <Button
            variant="primary"
            disabled={pending || Boolean(validation)}
            onClick={() => void submit()}
          >
            {pending ? t("createRepository.creating") : t("createRepository.submit")}
          </Button>
        </div>
      </div>
    </div>
  );
}
