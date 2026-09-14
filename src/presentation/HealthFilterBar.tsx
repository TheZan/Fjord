import { useTranslation } from "react-i18next";
import type { UiOverviewFilter } from "@/domain/generated";
import { HEALTH_FILTER_ORDER } from "@/application/repoHealth";

interface HealthFilterBarProps {
  filters: ReadonlySet<UiOverviewFilter>;
  onToggle: (filter: UiOverviewFilter) => void;
  onClear: () => void;
}

const LABEL_KEYS: Record<UiOverviewFilter, string> = {
  attention: "filters.attention",
  dirty: "filters.dirty",
  ahead: "filters.ahead",
  behind: "filters.behind",
  conflicts: "filters.conflicts",
  wrongBranch: "filters.wrongBranch",
};

/** Pure shared presentation for Overview and All Repositories. */
export function HealthFilterBar({ filters, onToggle, onClear }: HealthFilterBarProps) {
  const { t } = useTranslation("workspace");

  return (
    <div
      role="group"
      aria-label={t("filters.label")}
      className="flex min-w-0 flex-wrap items-center gap-1.5"
    >
      {HEALTH_FILTER_ORDER.map((filter) => {
        const active = filters.has(filter);
        return (
          <button
            key={filter}
            type="button"
            aria-pressed={active}
            onClick={() => onToggle(filter)}
            className="interactive-control inline-flex min-h-7 max-w-full items-center rounded-full border px-2.5 py-1 text-[11px] font-medium leading-4 transition-colors"
            style={{
              background: active ? "var(--fjord-tint)" : "var(--paper)",
              borderColor: active ? "var(--fjord)" : "var(--hairline-strong)",
              borderWidth: "0.5px",
              color: active ? "var(--fjord-ink)" : "var(--slate)",
            }}
          >
            {t(LABEL_KEYS[filter])}
          </button>
        );
      })}
      {filters.size > 0 ? (
        <button
          type="button"
          onClick={onClear}
          className="interactive-control min-h-7 rounded px-1.5 py-1 text-[11px] font-medium"
          style={{ color: "var(--slate)" }}
        >
          {t("filters.clear")}
        </button>
      ) : null}
    </div>
  );
}
