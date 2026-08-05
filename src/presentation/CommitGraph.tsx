import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useCommitLog } from "@/application/useCommitLog";
import { computeGraphLayout, type GraphRow } from "@/presentation/graphLayout";
import type { CommitSummary } from "@/domain/git";

const LANE_COLORS = ["var(--fjord)", "var(--moss)", "var(--amber)", "var(--rust)"];
const LANE_PITCH = 14;
const ROW_HEIGHT = 30;
const GUTTER_PAD = 9;
/**
 * How many lanes the graph column is allowed to show. A busy repository can
 * produce dozens; rendering them all made the SVG wider than the pane and
 * pushed the commit message clean off screen, leaving nothing but a column of
 * SHAs. The graph is an orientation aid, not the payload — past this depth it
 * gets clipped so the message column always keeps its space.
 */
const MAX_VISIBLE_LANES = 12;

function laneColor(lane: number): string {
  return LANE_COLORS[lane % LANE_COLORS.length];
}

function laneX(lane: number): number {
  return GUTTER_PAD + lane * LANE_PITCH;
}

function formatAuthoredAt(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale, { dateStyle: "short" }).format(date);
}

export function CommitGraph({
  repoId,
  selectedCommitId,
  onSelectCommit,
  workingFileCount = 0,
  workingSelected = false,
  onSelectWorking,
}: {
  repoId: string;
  selectedCommitId?: string | null;
  onSelectCommit?: (commit: CommitSummary) => void;
  /** Uncommitted files; when non-zero a WIP row is pinned above the history. */
  workingFileCount?: number;
  workingSelected?: boolean;
  onSelectWorking?: () => void;
}) {
  const { t, i18n } = useTranslation("workspace");
  const { commits, loading, error, hasMore, loadMore } = useCommitLog(repoId);
  // Lane assignment is O(commits × lanes) — memoized so unrelated state
  // changes (selection, loading flags) don't recompute the whole layout.
  const { rows, laneCount } = useMemo(() => computeGraphLayout(commits), [commits]);
  const visibleLanes = Math.min(laneCount, MAX_VISIBLE_LANES);
  const gutterWidth = GUTTER_PAD * 2 + Math.max(visibleLanes - 1, 0) * LANE_PITCH;

  if (error) {
    return (
      <p className="text-sm" style={{ color: "var(--rust-ink)" }}>
        {error}
      </p>
    );
  }
  if (commits.length === 0 && !loading) {
    return (
      <p className="text-sm" style={{ color: "var(--slate)" }}>
        {t("commits.empty")}
      </p>
    );
  }

  return (
    <div
      className="w-full overflow-hidden rounded-lg border text-sm"
      style={{ borderColor: "var(--hairline)", background: "var(--paper)" }}
    >
      {workingFileCount > 0 && onSelectWorking && (
        <WorkingRow
          gutterWidth={gutterWidth}
          fileCount={workingFileCount}
          selected={workingSelected}
          onSelect={onSelectWorking}
        />
      )}
      {rows.map((row) => (
        <CommitRow
          key={row.commit.id}
          row={row}
          gutterWidth={gutterWidth}
          locale={i18n.language}
          selected={row.commit.id === selectedCommitId}
          onSelect={onSelectCommit}
        />
      ))}
      <div className="p-2 text-center">
        {hasMore ? (
          <button
            type="button"
            onClick={loadMore}
            disabled={loading}
            className="text-xs"
            style={{ color: "var(--mist)" }}
          >
            {loading ? t("commits.loading") : t("commits.loadEarlier")}
          </button>
        ) : (
          !loading && (
            <span className="text-xs" style={{ color: "var(--mist)" }}>
              {t("commits.end")}
            </span>
          )
        )}
      </div>
    </div>
  );
}

/**
 * The uncommitted-work row pinned above history — GitKraken's "// WIP" entry.
 * Drawn with a hollow dot on the first lane to read as "not a commit yet".
 */
function WorkingRow({
  gutterWidth,
  fileCount,
  selected,
  onSelect,
}: {
  gutterWidth: number;
  fileCount: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation("workspace");
  const midY = ROW_HEIGHT / 2;
  const cx = laneX(0);

  return (
    <button
      type="button"
      onClick={onSelect}
      className="grid w-full cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b pr-2 text-left"
      style={{
        borderColor: "var(--hairline)",
        height: ROW_HEIGHT,
        background: selected ? "var(--fjord-tint)" : undefined,
      }}
    >
      <svg width={gutterWidth} height={ROW_HEIGHT} style={{ flexShrink: 0, overflow: "hidden" }}>
        <line x1={cx} y1={midY} x2={cx} y2={ROW_HEIGHT} stroke={laneColor(0)} strokeWidth={1.5} />
        <circle
          cx={cx}
          cy={midY}
          r={4}
          fill="var(--paper)"
          stroke={laneColor(0)}
          strokeWidth={1.5}
          strokeDasharray="2 1.5"
        />
      </svg>
      <span className="truncate font-medium" style={{ color: "var(--fjord-ink)" }}>
        {t("working.title")}
      </span>
      <span className="shrink-0 text-xs tabular-nums" style={{ color: "var(--mist)" }}>
        {t("working.fileCount", { count: fileCount })}
      </span>
    </button>
  );
}

function CommitRow({
  row,
  gutterWidth,
  locale,
  selected,
  onSelect,
}: {
  row: GraphRow;
  gutterWidth: number;
  locale: string;
  selected: boolean;
  onSelect?: (commit: CommitSummary) => void;
}) {
  const { commit, lane } = row;
  const midY = ROW_HEIGHT / 2;
  const cx = laneX(lane);
  const laneVisible = lane < MAX_VISIBLE_LANES;

  return (
    <button
      type="button"
      disabled={!onSelect}
      onClick={onSelect ? () => onSelect(commit) : undefined}
      className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-3 border-b pr-2 text-left last:border-b-0 disabled:cursor-default"
      style={{
        borderColor: "var(--hairline)",
        height: ROW_HEIGHT,
        background: selected ? "var(--fjord-tint)" : undefined,
        cursor: onSelect ? "pointer" : undefined,
      }}
    >
      <svg width={gutterWidth} height={ROW_HEIGHT} style={{ flexShrink: 0, overflow: "hidden" }}>
        {row.passthroughLanes
          .filter((l) => l < MAX_VISIBLE_LANES)
          .map((l) => (
            <line
              key={`pass-${l}`}
              x1={laneX(l)}
              y1={0}
              x2={laneX(l)}
              y2={ROW_HEIGHT}
              stroke={laneColor(l)}
              strokeWidth={1.5}
            />
          ))}
        {laneVisible && row.hasLineAbove && (
          <line x1={cx} y1={0} x2={cx} y2={midY} stroke={laneColor(lane)} strokeWidth={1.5} />
        )}
        {laneVisible && row.hasLineBelow && (
          <line x1={cx} y1={midY} x2={cx} y2={ROW_HEIGHT} stroke={laneColor(lane)} strokeWidth={1.5} />
        )}
        {laneVisible &&
          row.convergingLanes
            .filter((l) => l < MAX_VISIBLE_LANES)
            .map((l) => (
              <path
                key={`conv-${l}`}
                d={`M${laneX(l)} 0 C ${laneX(l)} ${midY / 2}, ${cx} ${midY / 2}, ${cx} ${midY}`}
                stroke={laneColor(lane)}
                strokeWidth={1.5}
                fill="none"
              />
            ))}
        {laneVisible &&
          row.divergingLanes
            .filter((l) => l < MAX_VISIBLE_LANES)
            .map((l) => (
              <path
                key={`div-${l}`}
                d={`M${cx} ${midY} C ${cx} ${(midY + ROW_HEIGHT) / 2}, ${laneX(l)} ${(midY + ROW_HEIGHT) / 2}, ${laneX(l)} ${ROW_HEIGHT}`}
                stroke={laneColor(l)}
                strokeWidth={1.5}
                fill="none"
              />
            ))}
        {laneVisible && (
          <>
            <circle cx={cx} cy={midY} r={4} fill="var(--paper)" />
            <circle cx={cx} cy={midY} r={3} fill={laneColor(lane)} />
          </>
        )}
      </svg>

      <span className="truncate" style={{ color: "var(--ink)" }}>
        {commit.message.split("\n")[0]}
      </span>
      <span className="shrink-0 truncate text-xs" style={{ color: "var(--slate)", maxWidth: "8rem" }}>
        {commit.authorName}
      </span>
      <span className="shrink-0 font-mono text-xs tabular-nums" style={{ color: "var(--mist)" }}>
        {formatAuthoredAt(commit.authoredAt, locale)} · {commit.id.slice(0, 7)}
      </span>
    </button>
  );
}
