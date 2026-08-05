import { useTranslation } from "react-i18next";
import { Card, Pill } from "@/presentation/ui";
import type { RepositoryEntry, RepoStatusSummary } from "@/domain/workspace";

/**
 * One repository at a glance. The previous card printed a 2×2
 * label/value grid (Branch, Dirty, Behind, Ahead) whether or not any of it
 * was non-zero, so a clean repo looked as busy as a broken one. Here the
 * state reads from a single pill, and counters only appear when they're
 * not zero.
 */
export function RepoCard({
  repo,
  status,
  selected,
  onSelect,
  onRemove,
}: {
  repo: RepositoryEntry;
  status: RepoStatusSummary["status"] | undefined;
  selected: boolean;
  onSelect: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation("workspace");

  const ahead = status?.ahead ?? 0;
  const behind = status?.behind ?? 0;
  const dirty = status?.dirtyCount ?? 0;

  const state = status?.hasConflict
    ? { tone: "rust" as const, label: t("cardStatus.conflict") }
    : dirty > 0
      ? { tone: "amber" as const, label: t("cardStatus.dirty") }
      : ahead > 0
        ? { tone: "fjord" as const, label: t("cardStatus.ahead") }
        : behind > 0
          ? { tone: "amber" as const, label: t("cardStatus.behind") }
          : { tone: "moss" as const, label: t("cardStatus.synced") };

  return (
    <Card selected={selected} className="interactive-card group relative h-full">
      <button
        type="button"
        onClick={onSelect}
        data-selected={selected}
        className="interactive-row flex h-full w-full flex-col gap-2 p-3 text-left"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-[13px] font-medium">{repo.name}</span>
          <Pill tone={state.tone}>{state.label}</Pill>
        </div>

        <span
          className="block truncate font-mono text-[11px]"
          style={{ color: "var(--slate)" }}
          title={repo.path}
        >
          {status?.branch ?? t("dashboard.unknown")}
        </span>

        <div className="flex items-center gap-2.5 text-[11px] tabular-nums" style={{ color: "var(--mist)" }}>
          {ahead > 0 && <span>↑{ahead}</span>}
          {behind > 0 && <span>↓{behind}</span>}
          {dirty > 0 && <span style={{ color: "var(--amber-ink)" }}>{t("cardStatus.changes", { count: dirty })}</span>}
          {ahead === 0 && behind === 0 && dirty === 0 && <span>{t("cardStatus.upToDate")}</span>}
        </div>
      </button>

      <button
        type="button"
        onClick={onRemove}
        className="interactive-control absolute bottom-2 right-2 hidden rounded px-1.5 py-0.5 text-[10px] group-hover:block"
        style={{ background: "var(--page-bg)", color: "var(--slate)" }}
      >
        {t("repositories.removeButton")}
      </button>
    </Card>
  );
}
