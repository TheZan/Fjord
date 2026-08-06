import { useTranslation } from "react-i18next";
import { useFileDiff, type DiffSource } from "@/application/useFileDiff";
import { CHANGE_TYPE_COLOR } from "@/presentation/diffFormatting";
import type { DiffLineKind } from "@/domain/git";

const LINE_BG: Record<DiffLineKind, string | undefined> = {
  addition: "var(--moss-tint)",
  deletion: "var(--rust-tint)",
  context: undefined,
};

const LINE_COLOR: Record<DiffLineKind, string> = {
  addition: "var(--moss-ink)",
  deletion: "var(--rust-ink)",
  context: "var(--ink)",
};

const LINE_PREFIX: Record<DiffLineKind, string> = {
  addition: "+",
  deletion: "-",
  context: " ",
};

/**
 * Full-detail diff for one file, meant to take over the center column when a
 * file is selected (see RepoDetailView) — GitKraken's diff view replaces the
 * commit graph rather than squeezing into a narrow side panel.
 */
export function FileDiffView({
  repoId,
  path,
  source,
  onBack,
}: {
  repoId: string;
  path: string;
  source: DiffSource;
  onBack?: () => void;
}) {
  const { t } = useTranslation("workspace");
  const { diff, loading, error } = useFileDiff(repoId, path, source);

  return (
    <div
      className="flex h-full min-h-0 w-full flex-col rounded-lg border text-sm"
      style={{ borderColor: "var(--hairline)", background: "var(--paper)" }}
    >
      <div
        className="flex items-center gap-3 border-b px-3 py-2"
        style={{ borderColor: "var(--hairline)" }}
      >
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="interactive-control shrink-0 rounded px-1.5 py-0.5 text-[11px]"
            style={{ color: "var(--slate)" }}
          >
            ← {t("diff.back")}
          </button>
        )}
        {diff && (
          <span
            className="w-4 shrink-0 text-center font-mono text-xs font-semibold"
            style={{ color: CHANGE_TYPE_COLOR[diff.changeType] }}
            title={t(`commitInspector.changeType.${diff.changeType}`)}
          >
            {t(`commitInspector.changeTypeMark.${diff.changeType}`)}
          </span>
        )}
        <code className="min-w-0 flex-1 truncate font-mono text-xs" style={{ color: "var(--ink)" }}>
          {path}
        </code>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {loading && (
          <p className="p-3 text-xs" style={{ color: "var(--mist)" }}>
            {t("commits.loading")}
          </p>
        )}
        {error && (
          <p className="p-3 text-xs" style={{ color: "var(--rust-ink)" }}>
            {error}
          </p>
        )}
        {!loading && !error && diff?.isBinary && (
          <p className="p-3 text-xs" style={{ color: "var(--slate)" }}>
            {t("diff.binary")}
          </p>
        )}
        {!loading && !error && diff && !diff.isBinary && diff.hunks.length === 0 && (
          <p className="p-3 text-xs" style={{ color: "var(--slate)" }}>
            {t("diff.empty")}
          </p>
        )}
        {diff && !diff.isBinary && diff.hunks.length > 0 && (
          // `w-max` sizes this to the longest line rather than to the visible
          // area, so each row's background spans the full scrollable width —
          // at 100% the added/removed tint stopped dead at the right edge of
          // the pane as soon as you scrolled sideways. `min-w-full` keeps
          // short diffs filling the pane.
          <div className="selectable-text w-max min-w-full font-mono text-xs">
            {diff.hunks.map((hunk, hunkIndex) => (
              <div key={hunkIndex}>
                <div className="px-3 py-1" style={{ background: "var(--fjord-tint)", color: "var(--fjord-ink)" }}>
                  @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
                </div>
                {hunk.lines.map((line, lineIndex) => (
                  <div
                    key={lineIndex}
                    className="flex"
                    style={{ background: LINE_BG[line.kind], color: LINE_COLOR[line.kind] }}
                  >
                    <span className="w-10 shrink-0 select-none px-1 text-right" style={{ color: "var(--mist)" }}>
                      {line.oldLineno ?? ""}
                    </span>
                    <span className="w-10 shrink-0 select-none px-1 text-right" style={{ color: "var(--mist)" }}>
                      {line.newLineno ?? ""}
                    </span>
                    <span className="whitespace-pre px-2">
                      {LINE_PREFIX[line.kind]}
                      {line.content}
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
