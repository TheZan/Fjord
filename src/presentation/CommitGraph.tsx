import { useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
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
  currentBranch,
  selectedCommitId,
  onSelectCommit,
  workingFileCount = 0,
  workingSelected = false,
  onSelectWorking,
}: {
  repoId: string;
  currentBranch?: string | null;
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
  const parentRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

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
      ref={parentRef}
      className="h-full w-full overflow-auto rounded-lg border text-sm"
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
      <div
        style={{
          height: `${rowVirtualizer.getTotalSize()}px`,
          position: "relative",
          width: "100%",
        }}
      >
        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
          const row = rows[virtualRow.index];

          return (
            <div
              key={row.commit.id}
              style={{
                height: `${virtualRow.size}px`,
                left: 0,
                position: "absolute",
                top: 0,
                transform: `translateY(${virtualRow.start}px)`,
                width: "100%",
              }}
            >
              <CommitRow
                row={row}
                gutterWidth={gutterWidth}
                locale={i18n.language}
                currentBranch={currentBranch ?? null}
                selected={row.commit.id === selectedCommitId}
                onSelect={onSelectCommit}
              />
            </div>
          );
        })}
      </div>
      <div className="p-2 text-center">
        {hasMore ? (
          <button
            type="button"
            onClick={loadMore}
            disabled={loading}
            className="interactive-control rounded px-2 py-1 text-xs"
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
      data-selected={selected}
      className="interactive-row grid w-full cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b pr-2 text-left"
      style={{
        borderColor: "var(--hairline)",
        height: ROW_HEIGHT,
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
  currentBranch,
  selected,
  onSelect,
}: {
  row: GraphRow;
  gutterWidth: number;
  locale: string;
  currentBranch: string | null;
  selected: boolean;
  onSelect?: (commit: CommitSummary) => void;
}) {
  const { commit, lane } = row;
  const midY = ROW_HEIGHT / 2;
  const cx = laneX(lane);
  const laneVisible = lane < MAX_VISIBLE_LANES;
  const refs = visibleCommitRefs(commit.refs, currentBranch);

  return (
    <button
      type="button"
      disabled={!onSelect}
      onClick={onSelect ? () => onSelect(commit) : undefined}
      data-selected={selected}
      className="interactive-row grid w-full grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-3 border-b pr-2 text-left last:border-b-0 disabled:cursor-default"
      style={{
        borderColor: "var(--hairline)",
        height: ROW_HEIGHT,
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

      <span className="flex min-w-0 items-center gap-2">
        {refs.length > 0 && (
          <span className="flex min-w-0 shrink-0 items-center gap-1">
            {refs.slice(0, 3).map((ref) => (
              <RefBadge key={ref.original} label={ref.label} active={ref.active} />
            ))}
            {refs.length > 3 && (
              <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px]" style={{ color: "var(--mist)" }}>
                +{refs.length - 3}
              </span>
            )}
          </span>
        )}
        <span className="min-w-0 truncate" style={{ color: "var(--ink)" }}>
          {commit.message.split("\n")[0]}
        </span>
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

function RefBadge({ label, active }: { label: string; active: boolean }) {
  return (
    <span
      className="inline-flex h-[18px] max-w-36 shrink-0 items-center gap-1 rounded px-1.5 text-[10px] font-medium"
      style={{
        background: active ? "var(--fjord)" : "var(--fjord-tint)",
        color: active ? "white" : "var(--fjord-ink)",
      }}
      title={label}
    >
      {active && <span aria-hidden="true">✓</span>}
      <span className="truncate">{label}</span>
    </span>
  );
}

function visibleCommitRefs(refs: string[], currentBranch: string | null) {
  const byLabel = new Map<string, { original: string; label: string; active: boolean }>();
  for (const ref of refs) {
    const label = displayRefName(ref);
    if (label === null) continue;
    const active = currentBranch !== null && ref === currentBranch;
    const existing = byLabel.get(label);
    if (!existing || active || existing.original.startsWith("origin/")) {
      byLabel.set(label, { original: ref, label, active });
    }
  }
  return [...byLabel.values()].sort((a, b) => Number(b.active) - Number(a.active));
}

function displayRefName(ref: string) {
  if (ref === "origin/HEAD") return null;
  if (ref.startsWith("origin/")) {
    const local = ref.slice("origin/".length);
    return local === "HEAD" || local.trim() === "" ? null : local;
  }
  return ref;
}
