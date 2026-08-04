import { useTranslation } from "react-i18next";
import { useCommitLog } from "@/application/useCommitLog";
import { computeGraphLayout, type GraphRow } from "@/presentation/graphLayout";
import type { CommitSummary } from "@/domain/git";

const LANE_COLORS = ["var(--fjord)", "var(--moss)", "var(--amber)", "var(--rust)"];
const LANE_PITCH = 18;
const ROW_HEIGHT = 32;
const GUTTER_PAD = 10;

function laneColor(lane: number): string {
  return LANE_COLORS[lane % LANE_COLORS.length];
}

function laneX(lane: number): number {
  return GUTTER_PAD + lane * LANE_PITCH;
}

export function CommitGraph({
  repoId,
  selectedCommitId,
  onSelectCommit,
}: {
  repoId: string;
  selectedCommitId?: string | null;
  onSelectCommit?: (commit: CommitSummary) => void;
}) {
  const { t } = useTranslation("workspace");
  const { commits, loading, error, hasMore, loadMore } = useCommitLog(repoId);
  const { rows, laneCount } = computeGraphLayout(commits);
  const gutterWidth = GUTTER_PAD * 2 + Math.max(laneCount - 1, 0) * LANE_PITCH;

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
      className="w-full max-w-lg rounded-lg border text-sm"
      style={{ borderColor: "var(--hairline)", background: "var(--paper)" }}
    >
      {rows.map((row) => (
        <CommitRow
          key={row.commit.id}
          row={row}
          gutterWidth={gutterWidth}
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

function CommitRow({
  row,
  gutterWidth,
  selected,
  onSelect,
}: {
  row: GraphRow;
  gutterWidth: number;
  selected: boolean;
  onSelect?: (commit: CommitSummary) => void;
}) {
  const { commit, lane } = row;
  const midY = ROW_HEIGHT / 2;
  const cx = laneX(lane);

  return (
    <button
      type="button"
      disabled={!onSelect}
      onClick={onSelect ? () => onSelect(commit) : undefined}
      className="flex w-full items-center gap-2 border-b px-2 text-left last:border-b-0 disabled:cursor-default"
      style={{
        borderColor: "var(--hairline)",
        height: ROW_HEIGHT,
        background: selected ? "var(--fjord-tint)" : undefined,
        cursor: onSelect ? "pointer" : undefined,
      }}
    >
      <svg width={gutterWidth} height={ROW_HEIGHT} style={{ flexShrink: 0 }}>
        {row.passthroughLanes.map((l) => (
          <line
            key={`pass-${l}`}
            x1={laneX(l)}
            y1={0}
            x2={laneX(l)}
            y2={ROW_HEIGHT}
            stroke={laneColor(l)}
            strokeWidth={2}
          />
        ))}
        {row.hasLineAbove && (
          <line x1={cx} y1={0} x2={cx} y2={midY} stroke={laneColor(lane)} strokeWidth={2} />
        )}
        {row.hasLineBelow && (
          <line x1={cx} y1={midY} x2={cx} y2={ROW_HEIGHT} stroke={laneColor(lane)} strokeWidth={2} />
        )}
        {row.convergingLanes.map((l) => (
          <path
            key={`conv-${l}`}
            d={`M${laneX(l)} 0 C ${laneX(l)} ${midY / 2}, ${cx} ${midY / 2}, ${cx} ${midY}`}
            stroke={laneColor(lane)}
            strokeWidth={2}
            fill="none"
          />
        ))}
        {row.divergingLanes.map((l) => (
          <path
            key={`div-${l}`}
            d={`M${cx} ${midY} C ${cx} ${(midY + ROW_HEIGHT) / 2}, ${laneX(l)} ${(midY + ROW_HEIGHT) / 2}, ${laneX(l)} ${ROW_HEIGHT}`}
            stroke={laneColor(l)}
            strokeWidth={2}
            fill="none"
          />
        ))}
        <circle cx={cx} cy={midY} r={4} fill="var(--paper)" />
        <circle cx={cx} cy={midY} r={3} fill={laneColor(lane)} />
      </svg>
      <span className="truncate" style={{ color: "var(--ink)" }}>
        {commit.message.split("\n")[0]}
      </span>
      <span className="ml-auto shrink-0 font-mono text-xs" style={{ color: "var(--mist)" }}>
        {commit.id.slice(0, 7)}
      </span>
    </button>
  );
}
