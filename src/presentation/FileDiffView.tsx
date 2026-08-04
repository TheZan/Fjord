import { useTranslation } from "react-i18next";
import { useFileDiff } from "@/application/useFileDiff";
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

export function FileDiffView({ repoId, commitId, path }: { repoId: string; commitId: string; path: string }) {
  const { t } = useTranslation("workspace");
  const { diff, loading, error } = useFileDiff(repoId, commitId, path);

  if (loading) {
    return (
      <p className="text-xs" style={{ color: "var(--mist)" }}>
        {t("commits.loading")}
      </p>
    );
  }
  if (error) {
    return (
      <p className="text-xs" style={{ color: "var(--rust-ink)" }}>
        {error}
      </p>
    );
  }
  if (!diff) return null;

  if (diff.isBinary) {
    return (
      <p className="text-xs" style={{ color: "var(--slate)" }}>
        {t("diff.binary")}
      </p>
    );
  }

  if (diff.hunks.length === 0) {
    return (
      <p className="text-xs" style={{ color: "var(--slate)" }}>
        {t("diff.empty")}
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded border font-mono text-xs" style={{ borderColor: "var(--hairline)" }}>
      {diff.hunks.map((hunk, hunkIndex) => (
        <div key={hunkIndex}>
          <div className="px-2 py-1" style={{ background: "var(--fjord-tint)", color: "var(--fjord-ink)" }}>
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
  );
}
