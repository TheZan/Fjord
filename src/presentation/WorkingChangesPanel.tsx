import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CHANGE_TYPE_COLOR } from "@/presentation/diffFormatting";
import { Button, Input, Textarea } from "@/presentation/ui";
import type { WorkingChanges, WorkingFile } from "@/domain/git";

export interface SelectedWorkingFile {
  path: string;
  staged: boolean;
}

/**
 * The commit panel: what's staged, what isn't, and the message that will turn
 * the staged half into a commit. Mirrors GitKraken's right-hand pane — the
 * previous UI could stage and commit through the backend but had no screen
 * that ever showed uncommitted work.
 */
export function WorkingChangesPanel({
  changes,
  loading,
  error,
  busy,
  selectedFile,
  onSelectFile,
  onStage,
  onUnstage,
  onCommit,
}: {
  changes: WorkingChanges;
  loading: boolean;
  error: string | null;
  busy: boolean;
  selectedFile: SelectedWorkingFile | null;
  onSelectFile: (file: SelectedWorkingFile) => void;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  onCommit: (message: string) => Promise<boolean>;
}) {
  const { t } = useTranslation("workspace");
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");

  const total = changes.staged.length + changes.unstaged.length;
  const canCommit = changes.staged.length > 0 && summary.trim().length > 0 && !busy;

  async function commit() {
    if (!canCommit) return;
    const message = description.trim() ? `${summary.trim()}\n\n${description.trim()}` : summary.trim();
    if (await onCommit(message)) {
      setSummary("");
      setDescription("");
    }
  }

  return (
    <div
      className="flex h-full min-h-0 w-full flex-col rounded-lg border text-sm"
      style={{ borderColor: "var(--hairline)", background: "var(--paper)" }}
    >
      <div className="border-b px-3 py-2" style={{ borderColor: "var(--hairline)" }}>
        <p className="text-[13px] font-medium">{t("working.title")}</p>
        <p className="text-[11px]" style={{ color: "var(--mist)" }}>
          {t("working.fileCount", { count: total })}
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && (
          <p className="p-3 text-xs" style={{ color: "var(--rust-ink)" }}>
            {error}
          </p>
        )}
        {!error && loading && total === 0 && (
          <p className="p-3 text-xs" style={{ color: "var(--mist)" }}>
            {t("commits.loading")}
          </p>
        )}
        {!error && !loading && total === 0 && (
          <p className="p-3 text-xs" style={{ color: "var(--slate)" }}>
            {t("working.clean")}
          </p>
        )}

        <FileSection
          label={t("working.unstaged")}
          files={changes.unstaged}
          staged={false}
          actionLabel={t("working.stage")}
          bulkLabel={t("working.stageAll")}
          busy={busy}
          selectedFile={selectedFile}
          onSelectFile={onSelectFile}
          onAct={onStage}
        />
        <FileSection
          label={t("working.staged")}
          files={changes.staged}
          staged
          actionLabel={t("working.unstage")}
          bulkLabel={t("working.unstageAll")}
          busy={busy}
          selectedFile={selectedFile}
          onSelectFile={onSelectFile}
          onAct={onUnstage}
        />
      </div>

      <div className="border-t p-2" style={{ borderColor: "var(--hairline)" }}>
        <Input
          value={summary}
          onChange={(event) => setSummary(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void commit();
          }}
          placeholder={t("working.summaryPlaceholder")}
          className="w-full"
        />
        <Textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void commit();
          }}
          placeholder={t("working.descriptionPlaceholder")}
          rows={3}
          className="mt-1.5 w-full"
        />
        <Button
          variant="primary"
          disabled={!canCommit}
          onClick={() => void commit()}
          className="mt-1.5 w-full"
        >
          {t("working.commit", { count: changes.staged.length })}
        </Button>
      </div>
    </div>
  );
}

function FileSection({
  label,
  files,
  staged,
  actionLabel,
  bulkLabel,
  busy,
  selectedFile,
  onSelectFile,
  onAct,
}: {
  label: string;
  files: WorkingFile[];
  staged: boolean;
  actionLabel: string;
  bulkLabel: string;
  busy: boolean;
  selectedFile: SelectedWorkingFile | null;
  onSelectFile: (file: SelectedWorkingFile) => void;
  onAct: (paths: string[]) => void;
}) {
  const { t } = useTranslation("workspace");
  if (files.length === 0) return null;

  return (
    <div className="p-2">
      <div className="mb-1 flex items-center justify-between gap-2 px-1">
        <span className="text-[11px] font-medium uppercase tracking-wide" style={{ color: "var(--mist)" }}>
          {label} ({files.length})
        </span>
        <button
          type="button"
          disabled={busy}
          onClick={() => onAct(files.map((file) => file.path))}
          className="text-[11px] disabled:opacity-40"
          style={{ color: "var(--fjord-ink)" }}
        >
          {bulkLabel}
        </button>
      </div>

      <ul className="flex flex-col gap-0.5">
        {files.map((file) => {
          const selected = selectedFile?.path === file.path && selectedFile.staged === staged;
          return (
            <li key={`${staged}:${file.path}`} className="group relative">
              <button
                type="button"
                onClick={() => onSelectFile({ path: file.path, staged })}
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left"
                style={{
                  background: selected ? "var(--fjord-tint)" : "transparent",
                  color: selected ? "var(--fjord-ink)" : "var(--ink)",
                }}
              >
                <span
                  className="w-4 shrink-0 text-center font-mono text-xs font-semibold"
                  style={{ color: CHANGE_TYPE_COLOR[file.changeType] }}
                  title={t(`commitInspector.changeType.${file.changeType}`)}
                >
                  {t(`commitInspector.changeTypeMark.${file.changeType}`)}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{file.path}</span>
                {file.conflicted && (
                  <span className="shrink-0 text-[10px]" style={{ color: "var(--rust-ink)" }}>
                    {t("working.conflicted")}
                  </span>
                )}
              </button>

              <button
                type="button"
                disabled={busy}
                onClick={() => onAct([file.path])}
                className="absolute right-1 top-1/2 hidden -translate-y-1/2 rounded px-1.5 py-0.5 text-[10px] group-hover:block disabled:opacity-40"
                style={{ background: "var(--page-bg)", color: "var(--fjord-ink)" }}
              >
                {actionLabel}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
