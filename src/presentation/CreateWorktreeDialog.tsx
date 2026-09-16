import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { BranchInfo, WorktreeBranch } from "@/domain/git";
import { Button, Input } from "@/presentation/ui";
import { useDialogFocusTrap } from "@/presentation/useDialogFocusTrap";

export interface CreateWorktreeRequest {
  name: string;
  path: string;
  branch: WorktreeBranch;
}

export function CreateWorktreeDialog({
  repoPath,
  branches,
  onConfirm,
  onClose,
}: {
  repoPath: string;
  branches: BranchInfo[];
  onConfirm: (request: CreateWorktreeRequest) => Promise<boolean>;
  onClose: () => void;
}) {
  const { t } = useTranslation("workspace");
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const localBranches = branches.filter((branch) => !branch.isRemote);
  const current = localBranches.find((branch) => branch.isCurrent)?.name ?? "HEAD";
  const initialExisting = localBranches.find((branch) => !branch.isCurrent)?.name
    ?? localBranches[0]?.name
    ?? "";
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [existingBranch, setExistingBranch] = useState(initialExisting);
  const [newBranch, setNewBranch] = useState("");
  const [startPoint, setStartPoint] = useState(current);
  const initialName = suggestedName(repoPath, initialExisting || "worktree");
  const [name, setName] = useState(initialName);
  const [path, setPath] = useState(siblingPath(repoPath, initialName));
  const [pending, setPending] = useState(false);
  useDialogFocusTrap(dialogRef, onClose);

  const branch = mode === "existing"
    ? { kind: "existing" as const, name: existingBranch.trim() }
    : { kind: "new" as const, name: newBranch.trim(), startPoint: startPoint.trim() };
  const valid = name.trim().length > 0
    && path.trim().length > 0
    && branch.name.length > 0
    && (branch.kind === "existing" || branch.startPoint.length > 0);

  async function submit() {
    if (!valid || pending) return;
    setPending(true);
    try {
      if (await onConfirm({ name: name.trim(), path: path.trim(), branch })) onClose();
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4" onMouseDown={() => !pending && onClose()}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="desktop-popover w-full max-w-lg rounded-lg border p-4"
        style={{ background: "var(--paper)", borderColor: "var(--hairline-strong)" }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id={titleId} className="text-sm font-semibold">{t("worktrees.createTitle")}</h2>
        <p className="mt-1 text-[13px]" style={{ color: "var(--slate)" }}>
          {t("worktrees.createDescription")}
        </p>

        <div className="mt-4 flex flex-col gap-3 text-[13px]">
          <label className="flex flex-col gap-1">
            <span>{t("worktrees.name")}</span>
            <Input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
          </label>
          <label className="flex flex-col gap-1">
            <span>{t("worktrees.path")}</span>
            <Input value={path} onChange={(event) => setPath(event.target.value)} />
          </label>
          <fieldset className="flex gap-4">
            <legend className="mb-1">{t("worktrees.branch")}</legend>
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={mode === "existing"} onChange={() => setMode("existing")} />
              {t("worktrees.existingBranch")}
            </label>
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={mode === "new"} onChange={() => setMode("new")} />
              {t("worktrees.newBranch")}
            </label>
          </fieldset>
          {mode === "existing" ? (
            <label className="flex flex-col gap-1">
              <span>{t("worktrees.existingBranch")}</span>
              <select
                value={existingBranch}
                onChange={(event) => setExistingBranch(event.target.value)}
                className="rounded-md border px-2 py-1.5"
                style={{ background: "var(--paper)", borderColor: "var(--hairline-strong)" }}
              >
                {localBranches.map((branch) => <option key={branch.name} value={branch.name}>{branch.name}</option>)}
              </select>
            </label>
          ) : (
            <>
              <label className="flex flex-col gap-1">
                <span>{t("worktrees.newBranchName")}</span>
                <Input value={newBranch} onChange={(event) => setNewBranch(event.target.value)} />
              </label>
              <label className="flex flex-col gap-1">
                <span>{t("worktrees.startPoint")}</span>
                <Input value={startPoint} onChange={(event) => setStartPoint(event.target.value)} />
              </label>
            </>
          )}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={onClose} disabled={pending}>{t("context.cancel")}</Button>
          <Button onClick={() => void submit()} disabled={!valid || pending}>
            {pending ? t("worktrees.creating") : t("worktrees.create")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function suggestedName(repoPath: string, branch: string) {
  const repository = repoPath.split(/[\\/]/).filter(Boolean).at(-1) ?? "repo";
  const suffix = branch.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "worktree";
  return `${repository}-${suffix}`;
}

function siblingPath(repoPath: string, name: string) {
  const separator = repoPath.includes("\\") ? "\\" : "/";
  const normalized = repoPath.replace(/[\\/]+$/, "");
  const last = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return last >= 0 ? `${normalized.slice(0, last)}${separator}${name}` : name;
}
