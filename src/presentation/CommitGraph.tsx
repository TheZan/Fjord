import { useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useTranslation } from "react-i18next";
import { useBranches } from "@/application/useBranches";
import { useCommitLog } from "@/application/useCommitLog";
import { useTags } from "@/application/useTags";
import { computeGraphLayout, type GraphRow } from "@/presentation/graphLayout";
import type { CommitSummary } from "@/domain/git";

const LANE_COLORS = ["var(--fjord)", "var(--moss)", "var(--amber)", "var(--rust)"];
const LANE_PITCH = 14;
const ROW_HEIGHT = 30;
const HEADER_HEIGHT = 28;
const GUTTER_PAD = 9;
const REF_COLUMN_WIDTH = "11.5rem";
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
  onCheckout,
  workingFileCount = 0,
  workingSelected = false,
  onSelectWorking,
}: {
  repoId: string;
  currentBranch?: string | null;
  selectedCommitId?: string | null;
  onSelectCommit?: (commit: CommitSummary) => void;
  onCheckout?: (branch: string) => void;
  /** Uncommitted files; when non-zero a WIP row is pinned above the history. */
  workingFileCount?: number;
  workingSelected?: boolean;
  onSelectWorking?: () => void;
}) {
  const { t, i18n } = useTranslation("workspace");
  const { commits, loading, error, hasMore, loadMore } = useCommitLog(repoId);
  const { branches } = useBranches(repoId);
  const { tags } = useTags(repoId);
  // Lane assignment is O(commits × lanes) — memoized so unrelated state
  // changes (selection, loading flags) don't recompute the whole layout.
  const { rows, laneCount } = useMemo(() => computeGraphLayout(commits), [commits]);
  const branchByName = useMemo(() => new Map(branches.map((branch) => [branch.name, branch])), [branches]);
  const tagNames = useMemo(() => new Set(tags.map((tag) => tag.name)), [tags]);
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
      <GraphHeader gutterWidth={gutterWidth} />
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
                branchByName={branchByName}
                tagNames={tagNames}
                selected={row.commit.id === selectedCommitId}
                onSelect={onSelectCommit}
                onCheckout={onCheckout}
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

function GraphHeader({ gutterWidth }: { gutterWidth: number }) {
  const { t } = useTranslation("workspace");

  return (
    <div
      className="sticky top-0 z-10 grid items-center gap-3 border-b px-2 text-[10px] font-medium uppercase tracking-[0.08em]"
      style={{
        background: "var(--paper)",
        borderColor: "var(--hairline)",
        color: "var(--mist)",
        gridTemplateColumns: `${REF_COLUMN_WIDTH} ${gutterWidth}px minmax(0, 1fr) 8rem 9rem`,
        height: HEADER_HEIGHT,
      }}
    >
      <span>{t("commits.branchTag")}</span>
      <span>{t("commits.graph")}</span>
      <span>{t("commits.message")}</span>
      <span />
      <span />
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
      className="interactive-row grid w-full cursor-pointer items-center gap-3 border-b px-2 text-left"
      style={{
        borderColor: "var(--hairline)",
        gridTemplateColumns: `${REF_COLUMN_WIDTH} ${gutterWidth}px minmax(0, 1fr) 8rem 9rem`,
        height: ROW_HEIGHT,
      }}
    >
      <span />
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
      <span />
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
  branchByName,
  tagNames,
  selected,
  onSelect,
  onCheckout,
}: {
  row: GraphRow;
  gutterWidth: number;
  locale: string;
  currentBranch: string | null;
  branchByName: Map<string, { isRemote: boolean }>;
  tagNames: Set<string>;
  selected: boolean;
  onSelect?: (commit: CommitSummary) => void;
  onCheckout?: (branch: string) => void;
}) {
  const { commit, lane } = row;
  const midY = ROW_HEIGHT / 2;
  const cx = laneX(lane);
  const laneVisible = lane < MAX_VISIBLE_LANES;
  const refs = visibleCommitRefs(commit.refs, currentBranch, branchByName, tagNames);

  return (
    <div
      role={onSelect ? "button" : undefined}
      tabIndex={onSelect ? 0 : undefined}
      onClick={onSelect ? () => onSelect(commit) : undefined}
      onKeyDown={(event) => {
        if (!onSelect) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(commit);
        }
      }}
      data-selected={selected}
      className="interactive-row grid w-full items-center gap-3 border-b px-2 text-left last:border-b-0"
      style={{
        borderColor: "var(--hairline)",
        gridTemplateColumns: `${REF_COLUMN_WIDTH} ${gutterWidth}px minmax(0, 1fr) 8rem 9rem`,
        height: ROW_HEIGHT,
        cursor: onSelect ? "pointer" : undefined,
      }}
    >
      <span className="flex min-w-0 items-center gap-1">
        {refs.slice(0, 3).map((ref) => (
          <RefBadge key={ref.original} refInfo={ref} onCheckout={onCheckout} />
        ))}
        {refs.length > 3 && (
          <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px]" style={{ color: "var(--mist)" }}>
            +{refs.length - 3}
          </span>
        )}
      </span>

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

      <span className="min-w-0 truncate" style={{ color: "var(--ink)" }}>
        {commit.message.split("\n")[0]}
      </span>
      <span className="shrink-0 truncate text-xs" style={{ color: "var(--slate)", maxWidth: "8rem" }}>
        {commit.authorName}
      </span>
      <span className="shrink-0 font-mono text-xs tabular-nums" style={{ color: "var(--mist)" }}>
        {formatAuthoredAt(commit.authoredAt, locale)} · {commit.id.slice(0, 7)}
      </span>
    </div>
  );
}

function RefBadge({
  refInfo,
  onCheckout,
}: {
  refInfo: CommitRef;
  onCheckout?: (branch: string) => void;
}) {
  const clickable = Boolean(refInfo.checkoutTarget && onCheckout && !refInfo.active);
  const Icon = refInfo.kind === "tag" ? TagIcon : refInfo.remote ? CloudIcon : BranchIcon;

  return (
    <span
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => {
        event.stopPropagation();
        if (refInfo.checkoutTarget) onCheckout?.(refInfo.checkoutTarget);
      }}
      onKeyDown={(event) => {
        if (!clickable || event.key !== "Enter") return;
        event.preventDefault();
        event.stopPropagation();
        if (refInfo.checkoutTarget) onCheckout?.(refInfo.checkoutTarget);
      }}
      data-active={refInfo.active}
      className="commit-ref-badge interactive-control inline-flex h-[22px] max-w-full shrink-0 items-center gap-1 rounded px-1.5 text-[11px] font-medium"
      style={{
        background: refInfo.active
          ? "var(--fjord)"
          : refInfo.kind === "tag"
            ? "var(--amber-tint)"
            : "var(--fjord-tint)",
        color: refInfo.active
          ? "white"
          : refInfo.kind === "tag"
            ? "var(--amber-ink)"
            : "var(--fjord-ink)",
        cursor: clickable ? "pointer" : undefined,
      }}
      title={refInfo.label}
    >
      {refInfo.active && <span aria-hidden="true">✓</span>}
      <Icon />
      <span className="truncate">{refInfo.label}</span>
    </span>
  );
}

interface CommitRef {
  original: string;
  label: string;
  active: boolean;
  kind: "branch" | "tag";
  remote: boolean;
  checkoutTarget: string | null;
}

function visibleCommitRefs(
  refs: string[],
  currentBranch: string | null,
  branchByName: Map<string, { isRemote: boolean }>,
  tagNames: Set<string>,
) {
  const byLabel = new Map<string, CommitRef>();
  for (const ref of refs) {
    const branch = branchByName.get(ref);
    const isBranch = branch !== undefined;
    const isTag = tagNames.has(ref) && !isBranch;
    const remote = branch?.isRemote ?? false;
    const label = displayRefName(ref, remote);
    if (label === null) continue;
    const active = currentBranch !== null && ref === currentBranch;
    const checkoutTarget = isBranch ? ref : null;
    const existing = byLabel.get(label);
    if (!existing || active || (existing.remote && isBranch) || (!existing.active && isBranch && existing.kind === "tag")) {
      byLabel.set(label, {
        original: ref,
        label,
        active,
        kind: isTag ? "tag" : "branch",
        remote,
        checkoutTarget,
      });
    }
  }
  return [...byLabel.values()].sort((a, b) => Number(b.active) - Number(a.active) || Number(a.remote) - Number(b.remote));
}

function displayRefName(ref: string, remote: boolean) {
  if (remote) {
    const slash = ref.indexOf("/");
    const local = slash === -1 ? ref : ref.slice(slash + 1);
    return local === "HEAD" || local.trim() === "" ? null : local;
  }
  return ref;
}

function BranchIcon() {
  return (
    <svg viewBox="0 0 12 12" className="h-3 w-3 shrink-0" aria-hidden="true">
      <path d="M3 2v8M3 4h4.5A1.5 1.5 0 1 0 6 2.5" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.2" />
    </svg>
  );
}

function CloudIcon() {
  return (
    <svg viewBox="0 0 14 12" className="h-3.5 w-3.5 shrink-0" aria-hidden="true">
      <path
        d="M4.4 9.5h5.2a2.2 2.2 0 0 0 .2-4.4A3.2 3.2 0 0 0 3.7 4a2.75 2.75 0 0 0 .7 5.5Z"
        fill="none"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.2"
      />
    </svg>
  );
}

function TagIcon() {
  return (
    <svg viewBox="0 0 12 12" className="h-3 w-3 shrink-0" aria-hidden="true">
      <path
        d="M2 2h4.2L10 5.8 5.8 10 2 6.2V2Z"
        fill="none"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.2"
      />
      <circle cx="4.1" cy="4.1" r=".7" fill="currentColor" />
    </svg>
  );
}
