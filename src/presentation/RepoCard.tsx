import { useTranslation } from "react-i18next";
import { primaryRepoCondition } from "@/application/repoHealth";
import { Card, Pill } from "@/presentation/ui";
import type { RepoCondition, RepoHealth, RepositoryEntry, RepoStatusSummary } from "@/domain/workspace";

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
  health,
  selected,
  onSelect,
  onWarm,
  onRemove,
}: {
  repo: RepositoryEntry;
  status: RepoStatusSummary["status"] | undefined;
  health: RepoHealth | undefined;
  selected: boolean;
  onSelect: () => void;
  onWarm?: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation("workspace");

  const ahead = status?.ahead ?? 0;
  const behind = status?.behind ?? 0;
  const dirty = status?.dirtyCount ?? 0;

  const primary = primaryRepoCondition(health);
  const state = conditionPresentation(primary, t);

  return (
    <Card selected={selected} className="interactive-card group relative h-full">
      <button
        type="button"
        onClick={onSelect}
        onPointerEnter={onWarm}
        onFocus={onWarm}
        data-selected={selected}
        data-health-condition={primary?.kind ?? "unknown"}
        data-needs-attention={health?.needsAttention ?? false}
        className="interactive-row flex h-full w-full flex-col gap-2 p-3 text-left"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-[13px] font-medium">{repo.name}</span>
          <Pill tone={state.tone}><span aria-hidden="true">{state.glyph}</span>{state.label}</Pill>
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
          {dirty > 0 && <span aria-label={t("cardStatus.changes", { count: dirty })} style={{ color: "var(--amber-ink)" }}>●{dirty}</span>}
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

function conditionPresentation(
  condition: RepoCondition | undefined,
  t: (key: string) => string,
) {
  switch (condition?.kind) {
    case "conflict":
      return { tone: "rust" as const, glyph: "⚠", label: t("cardStatus.conflict") };
    case "operationInProgress":
      return { tone: "rust" as const, glyph: "◆", label: t("cardStatus.operation") };
    case "unreadable":
      return { tone: "rust" as const, glyph: "!", label: t("cardStatus.unreadable") };
    case "wrongBranch":
      return { tone: "amber" as const, glyph: "↯", label: t("cardStatus.wrongBranch") };
    case "diverged":
      return { tone: "rust" as const, glyph: "↕", label: t("cardStatus.diverged") };
    case "behind":
      return { tone: "amber" as const, glyph: "↓", label: t("cardStatus.behind") };
    case "ahead":
      return { tone: "fjord" as const, glyph: "↑", label: t("cardStatus.ahead") };
    case "dirty":
      return { tone: "amber" as const, glyph: "●", label: t("cardStatus.dirty") };
    case "clean":
      return { tone: "moss" as const, glyph: "✓", label: t("cardStatus.synced") };
    default:
      return { tone: "neutral" as const, glyph: "·", label: t("dashboard.unknown") };
  }
}
