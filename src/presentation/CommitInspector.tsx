import { useTranslation } from "react-i18next";
import { useCommitDiff } from "@/application/useCommitDiff";
import { CHANGE_TYPE_COLOR } from "@/presentation/diffFormatting";
import type { CommitSummary } from "@/domain/git";

function formatAuthoredAt(value: string, locale: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function CommitInspector({
  repoId,
  commit,
  selectedFilePath,
  onSelectFile,
}: {
  repoId: string;
  commit: CommitSummary;
  selectedFilePath: string | null;
  onSelectFile: (path: string) => void;
}) {
  const { t, i18n } = useTranslation("workspace");
  const { files, loading, error } = useCommitDiff(repoId, commit.id);

  const authoredAt = formatAuthoredAt(commit.authoredAt, i18n.language);

  return (
    <div
      className="w-full max-w-lg rounded-lg border text-sm"
      style={{ borderColor: "var(--hairline)", background: "var(--paper)" }}
    >
      <div className="border-b p-3" style={{ borderColor: "var(--hairline)" }}>
        <p className="whitespace-pre-wrap font-medium" style={{ color: "var(--ink)" }}>
          {commit.message}
        </p>
        <div
          className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"
          style={{ color: "var(--mist)" }}
        >
          <span>
            {commit.authorName} &lt;{commit.authorEmail}&gt;
          </span>
          <span>{authoredAt}</span>
          <code className="font-mono">{commit.id}</code>
        </div>
      </div>

      <div className="p-3">
        {loading && (
          <p className="text-xs" style={{ color: "var(--mist)" }}>
            {t("commits.loading")}
          </p>
        )}
        {error && (
          <p className="text-xs" style={{ color: "var(--rust-ink)" }}>
            {error}
          </p>
        )}
        {!loading && !error && files.length === 0 && (
          <p className="text-xs" style={{ color: "var(--slate)" }}>
            {t("commitInspector.empty")}
          </p>
        )}
        {files.length > 0 && (
          <ul className="flex flex-col gap-0.5">
            {files.map((file) => (
              <li key={file.path}>
                <button
                  type="button"
                  onClick={() => onSelectFile(file.path)}
                  className="flex w-full items-center gap-2 rounded px-2 py-1 text-left"
                  style={{
                    background: file.path === selectedFilePath ? "var(--fjord-tint)" : "transparent",
                    color: file.path === selectedFilePath ? "var(--fjord-ink)" : "var(--ink)",
                  }}
                >
                  <span
                    className="w-4 shrink-0 text-center font-mono text-xs font-semibold"
                    style={{ color: CHANGE_TYPE_COLOR[file.changeType] }}
                    title={t(`commitInspector.changeType.${file.changeType}`)}
                  >
                    {t(`commitInspector.changeTypeMark.${file.changeType}`)}
                  </span>
                  <span className="truncate font-mono text-xs">{file.path}</span>
                  <span className="ml-auto shrink-0 text-xs" style={{ color: "var(--mist)" }}>
                    +{file.additions} -{file.deletions}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
