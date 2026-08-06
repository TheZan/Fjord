import { useEffect, useMemo, useRef, useState, type MouseEvent, type RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useTranslation } from "react-i18next";
import { useBranches } from "@/application/useBranches";
import { useCommitLog } from "@/application/useCommitLog";
import { useCommitSearch } from "@/application/useCommitSearch";
import { useTags } from "@/application/useTags";
import { computeGraphLayout, type GraphRow } from "@/presentation/graphLayout";
import { ContextMenu, type ContextMenuItem } from "@/presentation/GitContextMenu";
import type { BranchInfo, CommitSummary, TagInfo } from "@/domain/git";

const LANE_COLORS = [
  "var(--graph-lane-1)",
  "var(--graph-lane-2)",
  "var(--graph-lane-3)",
  "var(--graph-lane-4)",
  "var(--graph-lane-5)",
  "var(--graph-lane-6)",
];
const LANE_PITCH = 14;
const ROW_HEIGHT = 30;
const HEADER_HEIGHT = 28;
const GUTTER_PAD = 9;
const REF_COLUMN_WIDTH = "11.5rem";
const AUTO_LOAD_THRESHOLD_PX = ROW_HEIGHT * 14;
const SEARCH_DEBOUNCE_MS = 180;
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
  scrollToBranch,
  selectedCommitId,
  onSelectCommit,
  onRevealCommit,
  onCheckout,
  onCommitContextAction,
  workingFileCount = 0,
  workingSelected = false,
  onSelectWorking,
}: {
  repoId: string;
  currentBranch?: string | null;
  scrollToBranch?: BranchGraphScrollRequest | null;
  selectedCommitId?: string | null;
  onSelectCommit?: (commit: CommitSummary) => void;
  onRevealCommit?: (commit: CommitSummary) => void;
  onCheckout?: (branch: string) => void;
  onCommitContextAction?: (action: CommitContextAction, commit: CommitSummary) => void;
  /** Uncommitted files; when non-zero a WIP row is pinned above the history. */
  workingFileCount?: number;
  workingSelected?: boolean;
  onSelectWorking?: () => void;
}) {
  const { t, i18n } = useTranslation("workspace");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [menu, setMenu] = useState<{ commit: CommitSummary; x: number; y: number } | null>(null);
  const debouncedSearchQuery = useDebouncedValue(searchQuery, SEARCH_DEBOUNCE_MS);
  const effectiveSearchQuery = searchOpen ? debouncedSearchQuery : "";
  const { commits, loading, error, hasMore, loadMore, loadingUntilCommitId, loadUntilCommit } =
    useCommitLog(repoId);
  const search = useCommitSearch(repoId, effectiveSearchQuery);
  const { branches } = useBranches(repoId);
  const { tags } = useTags(repoId);
  const searchActive = effectiveSearchQuery.trim().length > 0;
  const visibleCommits = searchActive ? search.commits : commits;
  const visibleLoading = searchActive ? search.loading : loading;
  const visibleError = searchActive ? search.error : error;
  // Lane assignment is O(commits × lanes) — memoized so unrelated state
  // changes (selection, loading flags) don't recompute the whole layout.
  const { rows, laneCount } = useMemo(() => computeGraphLayout(visibleCommits), [visibleCommits]);
  const selectedPath = useMemo(
    () => firstParentPath(visibleCommits, selectedCommitId ?? null),
    [selectedCommitId, visibleCommits],
  );
  const branchByName = useMemo(() => {
    const byName = new Map<string, BranchInfo>();
    for (const branch of branches) {
      byName.set(branch.name, branch);
      byName.set(fullBranchRefName(branch), branch);
    }
    return byName;
  }, [branches]);
  const branchesByCommit = useMemo(() => groupBranchesByCommit(branches), [branches]);
  const tagNames = useMemo(() => new Set(tags.map((tag) => tag.name)), [tags]);
  const tagsByCommit = useMemo(() => groupTagsByCommit(tags), [tags]);
  const visibleLanes = Math.min(laneCount, MAX_VISIBLE_LANES);
  const gutterWidth = GUTTER_PAD * 2 + Math.max(visibleLanes - 1, 0) * LANE_PITCH;
  const parentRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const fulfilledBranchScrollId = useRef<number | null>(null);
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  useEffect(() => {
    parentRef.current?.scrollTo({ top: 0 });
  }, [effectiveSearchQuery]);

  useEffect(() => {
    if (!scrollToBranch) return;
    setSearchOpen(false);
    setSearchQuery("");
  }, [scrollToBranch]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const wantsFind = (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "f";
      if (wantsFind) {
        event.preventDefault();
        setSearchOpen(true);
        window.requestAnimationFrame(() => {
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
        });
        return;
      }

      if (event.key === "Escape" && searchOpen) {
        event.preventDefault();
        setSearchOpen(false);
        setSearchQuery("");
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [searchOpen]);

  useEffect(() => {
    if (!searchOpen) return;
    window.requestAnimationFrame(() => searchInputRef.current?.focus());
  }, [searchOpen]);

  useEffect(() => {
    if (searchActive || !hasMore) return;
    const element = parentRef.current;
    if (!element) return;

    const maybeLoadMore = () => {
      const remaining = element.scrollHeight - element.scrollTop - element.clientHeight;
      if (remaining <= AUTO_LOAD_THRESHOLD_PX) loadMore();
    };

    maybeLoadMore();
    element.addEventListener("scroll", maybeLoadMore, { passive: true });
    return () => element.removeEventListener("scroll", maybeLoadMore);
  }, [hasMore, loadMore, rows.length, searchActive]);

  useEffect(() => {
    if (!scrollToBranch || searchActive || fulfilledBranchScrollId.current === scrollToBranch.id) return;

    const branch =
      branchByName.get(scrollToBranch.branch) ?? branchByName.get(normalizeRefName(scrollToBranch.branch));
    if (!branch) return;

    const rowIndex = rows.findIndex((row) => row.commit.id === branch.targetCommitId);
    if (rowIndex !== -1) {
      fulfilledBranchScrollId.current = scrollToBranch.id;
      onRevealCommit?.(rows[rowIndex].commit);
      const currentIndex = Math.round((parentRef.current?.scrollTop ?? 0) / ROW_HEIGHT);
      rowVirtualizer.scrollToIndex(rowIndex, {
        align: "center",
        behavior: Math.abs(rowIndex - currentIndex) > 40 ? "auto" : "smooth",
      });
      return;
    }

    if (loadingUntilCommitId !== branch.targetCommitId) {
      void loadUntilCommit(branch.targetCommitId);
    }
  }, [
    branchByName,
    loadUntilCommit,
    loadingUntilCommitId,
    onRevealCommit,
    rowVirtualizer,
    rows,
    scrollToBranch,
    searchActive,
  ]);

  if (visibleError) {
    return (
      <p className="text-sm" style={{ color: "var(--rust-ink)" }}>
        {visibleError}
      </p>
    );
  }
  if (commits.length === 0 && !loading && !searchActive) {
    return (
      <p className="text-sm" style={{ color: "var(--slate)" }}>
        {t("commits.empty")}
      </p>
    );
  }

  const searchResultLabel =
    visibleLoading && searchActive
      ? t("commits.loading")
      : t("commits.searchCount", { count: searchActive ? rows.length : 0 });
  const seekingBranch = scrollToBranch
    ? (branchByName.get(scrollToBranch.branch) ?? branchByName.get(normalizeRefName(scrollToBranch.branch)))
    : null;
  const seekingBranchLabel =
    seekingBranch &&
    loadingUntilCommitId === seekingBranch.targetCommitId &&
    !rows.some((row) => row.commit.id === seekingBranch.targetCommitId)
      ? displayRefName(normalizeRefName(seekingBranch.name), seekingBranch.isRemote)
      : null;

  function navigateToCommit(currentCommit: CommitSummary, target: "previous" | "next" | "first" | "last") {
    const currentIndex = rows.findIndex((row) => row.commit.id === currentCommit.id);
    if (currentIndex === -1 || rows.length === 0) return;
    const targetIndex =
      target === "first"
        ? 0
        : target === "last"
          ? rows.length - 1
          : Math.min(Math.max(currentIndex + (target === "next" ? 1 : -1), 0), rows.length - 1);
    const commit = rows[targetIndex].commit;
    onSelectCommit?.(commit);
    rowVirtualizer.scrollToIndex(targetIndex, { align: "auto" });
    focusCommitRow(parentRef, commit.id);
  }

  return (
    <div
      className="relative h-full w-full overflow-hidden rounded-lg border text-sm"
      style={{ borderColor: "var(--hairline)", background: "var(--paper)" }}
    >
      {searchOpen && (
        <GraphSearchBar
          inputRef={searchInputRef}
          searchQuery={searchQuery}
          resultLabel={searchResultLabel}
          onSearchQueryChange={setSearchQuery}
          onClose={() => {
            setSearchOpen(false);
            setSearchQuery("");
          }}
        />
      )}
      {seekingBranchLabel && <BranchSeekStatus label={t("commits.locatingBranch", { branch: seekingBranchLabel })} />}
      <div ref={parentRef} className="h-full w-full overflow-auto">
        <GraphHeader gutterWidth={gutterWidth} />
        {workingFileCount > 0 && onSelectWorking && (
          <WorkingRow
            gutterWidth={gutterWidth}
            fileCount={workingFileCount}
            selected={workingSelected}
            onSelect={onSelectWorking}
          />
        )}
        {visibleLoading && rows.length === 0 ? <GraphSkeleton gutterWidth={gutterWidth} /> : null}
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
                  branchesByCommit={branchesByCommit}
                  tagNames={tagNames}
                  tagsByCommit={tagsByCommit}
                  selected={row.commit.id === selectedCommitId}
                  pathHighlighted={selectedPath.has(row.commit.id)}
                  pathDimmed={selectedPath.size > 0 && !selectedPath.has(row.commit.id)}
                  focusable={
                    row.commit.id === selectedCommitId ||
                    (selectedCommitId == null && virtualRow.index === 0)
                  }
                  onSelect={onSelectCommit}
                  onNavigate={navigateToCommit}
                  ariaLabel={t("commits.rowLabel", {
                    message: row.commit.message.split("\n")[0],
                    author: row.commit.authorName,
                    sha: row.commit.id.slice(0, 7),
                  })}
                  onCheckout={onCheckout}
                  onContextMenu={(event, commit) => setMenu({ commit, x: event.clientX, y: event.clientY })}
                />
              </div>
            );
          })}
        </div>
        <div className="p-2 text-center">
          {searchActive ? (
            <span className="text-xs" style={{ color: "var(--mist)" }}>
              {visibleLoading
                ? t("commits.loading")
                : rows.length === 0
                  ? t("commits.searchEmpty")
                  : t("commits.searchCount", { count: rows.length })}
            </span>
          ) : hasMore ? (
            loading && (
              <span className="text-xs" style={{ color: "var(--mist)" }}>
                {t("commits.loading")}
              </span>
            )
          ) : (
            !loading && (
              <span className="text-xs" style={{ color: "var(--mist)" }}>
                {t("commits.end")}
              </span>
            )
          )}
        </div>
      </div>
      {menu && (
        <ContextMenu
          position={menu}
          items={commitMenuItems(t)}
          onClose={() => setMenu(null)}
          onSelect={(action) => {
            const commit = menu.commit;
            setMenu(null);
            onCommitContextAction?.(action as CommitContextAction, commit);
          }}
        />
      )}
    </div>
  );
}

export interface BranchGraphScrollRequest {
  branch: string;
  id: number;
}

function BranchSeekStatus({ label }: { label: string }) {
  return (
    <div
      className="pointer-events-none absolute left-1/2 top-10 z-30 flex -translate-x-1/2 items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs font-medium shadow-lg"
      style={{
        background: "color-mix(in srgb, var(--paper) 92%, var(--fjord-tint))",
        borderColor: "var(--hairline-strong)",
        color: "var(--fjord-ink)",
      }}
    >
      <span
        className="h-2 w-2 rounded-full"
        style={{
          animation: "fjord-pulse 900ms ease-in-out infinite",
          background: "var(--fjord)",
        }}
      />
      <span>{label}</span>
    </div>
  );
}

function useDebouncedValue<T>(value: T, delayMs: number) {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const handle = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(handle);
  }, [delayMs, value]);

  return debounced;
}

function GraphHeader({ gutterWidth }: { gutterWidth: number }) {
  const { t } = useTranslation("workspace");

  return (
    <div
      className="sticky top-0 z-20 grid items-center gap-3 border-b px-2 text-[10px] font-medium uppercase tracking-[0.08em]"
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

function GraphSearchBar({
  inputRef,
  searchQuery,
  resultLabel,
  onSearchQueryChange,
  onClose,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  searchQuery: string;
  resultLabel: string;
  onSearchQueryChange: (query: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("workspace");

  return (
    <div
      className="absolute right-3 top-3 z-30 flex w-[min(46rem,calc(100%-1.5rem))] items-center gap-2 rounded-md border px-2 py-1.5 shadow-lg"
      style={{
        background: "color-mix(in srgb, var(--fjord) 78%, var(--paper))",
        borderColor: "color-mix(in srgb, var(--fjord) 70%, white)",
        color: "white",
      }}
    >
      <SearchIcon />
      <input
        ref={inputRef}
        type="search"
        value={searchQuery}
        onChange={(event) => onSearchQueryChange(event.target.value)}
        placeholder={t("commits.searchPlaceholder")}
        aria-label={t("commits.searchPlaceholder")}
        className="h-8 min-w-0 flex-1 rounded-md border px-2.5 text-[13px] outline-none placeholder:text-[var(--mist)] focus:border-white"
        style={{
          borderWidth: "1px",
          borderColor: "color-mix(in srgb, white 38%, transparent)",
          background: "color-mix(in srgb, var(--page-bg) 75%, var(--fjord))",
          color: "var(--ink)",
        }}
      />
      <span className="shrink-0 whitespace-nowrap text-sm font-medium tabular-nums">{resultLabel}</span>
      <button
        type="button"
        onClick={onClose}
        className="interactive-control inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-lg font-semibold leading-none"
        style={{ color: "white" }}
        aria-label={t("commits.closeSearch")}
        title={t("commits.closeSearch")}
      >
        x
      </button>
    </div>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4 shrink-0" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path d="m10.4 10.4 3.1 3.1" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7" />
    </svg>
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
  branchesByCommit,
  tagNames,
  tagsByCommit,
  selected,
  pathHighlighted,
  pathDimmed,
  focusable,
  onSelect,
  onNavigate,
  ariaLabel,
  onCheckout,
  onContextMenu,
}: {
  row: GraphRow;
  gutterWidth: number;
  locale: string;
  currentBranch: string | null;
  branchByName: Map<string, BranchInfo>;
  branchesByCommit: Map<string, BranchInfo[]>;
  tagNames: Set<string>;
  tagsByCommit: Map<string, TagInfo[]>;
  selected: boolean;
  pathHighlighted: boolean;
  pathDimmed: boolean;
  focusable: boolean;
  onSelect?: (commit: CommitSummary) => void;
  onNavigate?: (
    commit: CommitSummary,
    target: "previous" | "next" | "first" | "last",
  ) => void;
  ariaLabel: string;
  onCheckout?: (branch: string) => void;
  onContextMenu?: (event: MouseEvent<HTMLDivElement>, commit: CommitSummary) => void;
}) {
  const { commit, lane } = row;
  const midY = ROW_HEIGHT / 2;
  const cx = laneX(lane);
  const laneVisible = lane < MAX_VISIBLE_LANES;
  const refs = visibleCommitRefs(
    commitRefs(commit, branchesByCommit.get(commit.id), tagsByCommit.get(commit.id)),
    currentBranch,
    branchByName,
    tagNames,
  );

  return (
    <div
      role={onSelect ? "button" : undefined}
      aria-label={onSelect ? ariaLabel : undefined}
      aria-current={selected ? "true" : undefined}
      tabIndex={onSelect ? (focusable ? 0 : -1) : undefined}
      data-commit-id={commit.id}
      onClick={onSelect ? () => onSelect(commit) : undefined}
      onContextMenu={(event) => {
        if (!onContextMenu) return;
        event.preventDefault();
        onContextMenu(event, commit);
      }}
      onKeyDown={(event) => {
        if (!onSelect) return;
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
          event.preventDefault();
          void navigator.clipboard?.writeText(commit.id);
          return;
        }
        if (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Home" || event.key === "End") {
          event.preventDefault();
          onNavigate?.(
            commit,
            event.key === "ArrowUp"
              ? "previous"
              : event.key === "ArrowDown"
                ? "next"
                : event.key === "Home"
                  ? "first"
                  : "last",
          );
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(commit);
        }
      }}
      data-selected={selected}
      data-path-highlighted={pathHighlighted}
      className="interactive-row grid w-full items-center gap-3 border-b px-2 text-left last:border-b-0"
      style={{
        borderColor: "var(--hairline)",
        gridTemplateColumns: `${REF_COLUMN_WIDTH} ${gutterWidth}px minmax(0, 1fr) 8rem 9rem`,
        height: ROW_HEIGHT,
        cursor: onSelect ? "pointer" : undefined,
      }}
    >
      <span className="flex min-w-0 items-center gap-1" style={{ opacity: pathDimmed ? 0.72 : 1 }}>
        {refs.slice(0, 3).map((ref) => (
          <RefBadge key={ref.original} refInfo={ref} onCheckout={onCheckout} />
        ))}
        {refs.length > 3 && (
          <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px]" style={{ color: "var(--mist)" }}>
            +{refs.length - 3}
          </span>
        )}
      </span>

      <svg
        width={gutterWidth}
        height={ROW_HEIGHT}
        aria-hidden="true"
        style={{
          flexShrink: 0,
          overflow: "hidden",
          opacity: pathDimmed ? 0.3 : 1,
          transition: "opacity 120ms ease",
        }}
      >
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
              strokeWidth={pathHighlighted ? 2 : 1.35}
            />
          ))}
        {laneVisible && row.hasLineAbove && (
          <line x1={cx} y1={0} x2={cx} y2={midY} stroke={laneColor(lane)} strokeWidth={pathHighlighted ? 2 : 1.35} />
        )}
        {laneVisible && row.hasLineBelow && (
          <line x1={cx} y1={midY} x2={cx} y2={ROW_HEIGHT} stroke={laneColor(lane)} strokeWidth={pathHighlighted ? 2 : 1.35} />
        )}
        {laneVisible &&
          row.convergingLanes
            .filter((l) => l < MAX_VISIBLE_LANES)
            .map((l) => (
              <path
                key={`conv-${l}`}
                d={`M${laneX(l)} 0 C ${laneX(l)} ${midY / 2}, ${cx} ${midY / 2}, ${cx} ${midY}`}
                stroke={laneColor(lane)}
                strokeWidth={pathHighlighted ? 2 : 1.35}
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
                strokeWidth={pathHighlighted ? 2 : 1.35}
                fill="none"
              />
            ))}
        {laneVisible ? (
          <LaneNode lane={lane} cx={cx} cy={midY} selected={selected} highlighted={pathHighlighted} />
        ) : null}
      </svg>

      <span className="min-w-0 truncate" style={{ color: "var(--ink)", opacity: pathDimmed ? 0.72 : 1 }}>
        {commit.message.split("\n")[0]}
      </span>
      <span className="shrink-0 truncate text-xs" style={{ color: "var(--slate)", maxWidth: "8rem", opacity: pathDimmed ? 0.68 : 1 }}>
        {commit.authorName}
      </span>
      <span className="shrink-0 font-mono text-xs tabular-nums" style={{ color: "var(--mist)", opacity: pathDimmed ? 0.68 : 1 }}>
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
  branchByName: Map<string, BranchInfo>,
  tagNames: Set<string>,
) {
  const byLabel = new Map<string, CommitRef>();
  const activeBranch = currentBranch ? normalizeRefName(currentBranch) : null;
  for (const ref of refs) {
    const normalizedRef = normalizeRefName(ref);
    const branch = branchByName.get(ref) ?? branchByName.get(normalizedRef);
    const isBranch = branch !== undefined;
    const isTag = tagNames.has(normalizedRef) && !isBranch;
    const remote = branch?.isRemote ?? false;
    const label = displayRefName(normalizedRef, remote);
    if (label === null) continue;
    const active = activeBranch !== null && normalizedRef === activeBranch;
    const checkoutTarget = branch?.name ?? (isBranch ? normalizedRef : null);
    const existing = byLabel.get(label);
    if (!existing || active || (existing.remote && isBranch) || (!existing.active && isBranch && existing.kind === "tag")) {
      byLabel.set(label, {
        original: normalizedRef,
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

function LaneNode({
  lane,
  cx,
  cy,
  selected,
  highlighted,
}: {
  lane: number;
  cx: number;
  cy: number;
  selected: boolean;
  highlighted: boolean;
}) {
  const color = laneColor(lane);
  const size = highlighted ? 3.5 : 3;
  const shape = lane % 4;

  return (
    <g>
      {selected ? <circle cx={cx} cy={cy} r={6} fill="none" stroke={color} strokeWidth={1.5} /> : null}
      {shape === 0 ? <circle cx={cx} cy={cy} r={size} fill={color} /> : null}
      {shape === 1 ? <rect x={cx - size} y={cy - size} width={size * 2} height={size * 2} rx={0.8} fill={color} /> : null}
      {shape === 2 ? (
        <path d={`M${cx} ${cy - size - 0.5} ${cx + size + 0.5} ${cy} ${cx} ${cy + size + 0.5} ${cx - size - 0.5} ${cy}Z`} fill={color} />
      ) : null}
      {shape === 3 ? <circle cx={cx} cy={cy} r={size} fill="var(--paper)" stroke={color} strokeWidth={2} /> : null}
    </g>
  );
}

export type CommitContextAction = "createBranch" | "createTag" | "cherryPick" | "revert" | "reset" | "copySha";

function commitMenuItems(t: (key: string) => string): ContextMenuItem[] {
  return [
    { id: "createBranch", label: t("context.createBranchHere"), icon: "branch" },
    { id: "createTag", label: t("context.createTagHere"), icon: "tag" },
    { id: "cherryPick", label: t("context.cherryPick"), icon: "checkout", separatorBefore: true },
    { id: "revert", label: t("context.revertCommit"), icon: "revert" },
    { id: "reset", label: t("context.resetToCommit"), icon: "reset", danger: true },
    { id: "copySha", label: t("context.copyCommitSha"), icon: "copy", shortcut: "Ctrl+C", separatorBefore: true },
  ];
}

function focusCommitRow(parentRef: RefObject<HTMLDivElement | null>, commitId: string) {
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      parentRef.current?.querySelector<HTMLElement>(`[data-commit-id="${commitId}"]`)?.focus();
    });
  });
}

function GraphSkeleton({ gutterWidth }: { gutterWidth: number }) {
  return (
    <div aria-hidden="true">
      {Array.from({ length: 12 }, (_, index) => (
        <div
          key={index}
          className="grid items-center gap-3 border-b px-2"
          style={{
            borderColor: "var(--hairline)",
            gridTemplateColumns: `${REF_COLUMN_WIDTH} ${gutterWidth}px minmax(0, 1fr) 8rem 9rem`,
            height: ROW_HEIGHT,
          }}
        >
          <div className="skeleton h-4 rounded" style={{ width: `${54 + (index % 3) * 12}%` }} />
          <div className="skeleton mx-auto h-3 w-3 rounded-full" />
          <div className="skeleton h-3.5 rounded" style={{ width: `${58 + (index % 4) * 9}%` }} />
          <div className="skeleton h-3 rounded" />
          <div className="skeleton h-3 rounded" />
        </div>
      ))}
    </div>
  );
}

function commitRefs(commit: CommitSummary, branches: BranchInfo[] = [], tags: TagInfo[] = []) {
  const refs = new Set(commit.refs.map(normalizeRefName));
  for (const branch of branches) refs.add(branch.name);
  for (const tag of tags) refs.add(tag.name);
  return [...refs];
}

function groupBranchesByCommit(branches: BranchInfo[]) {
  const byCommit = new Map<string, BranchInfo[]>();
  for (const branch of branches) {
    const list = byCommit.get(branch.targetCommitId) ?? [];
    list.push(branch);
    byCommit.set(branch.targetCommitId, list);
  }
  return byCommit;
}

function groupTagsByCommit(tags: TagInfo[]) {
  const byCommit = new Map<string, TagInfo[]>();
  for (const tag of tags) {
    const list = byCommit.get(tag.targetCommitId) ?? [];
    list.push(tag);
    byCommit.set(tag.targetCommitId, list);
  }
  return byCommit;
}

function firstParentPath(commits: CommitSummary[], selectedCommitId: string | null) {
  const path = new Set<string>();
  if (!selectedCommitId) return path;
  const commitsById = new Map(commits.map((commit) => [commit.id, commit]));
  let current = commitsById.get(selectedCommitId);
  while (current && !path.has(current.id)) {
    path.add(current.id);
    current = current.parentIds[0] ? commitsById.get(current.parentIds[0]) : undefined;
  }
  return path;
}

function normalizeRefName(ref: string) {
  return ref
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/remotes\//, "")
    .replace(/^refs\/tags\//, "");
}

function fullBranchRefName(branch: BranchInfo) {
  return branch.isRemote ? `refs/remotes/${branch.name}` : `refs/heads/${branch.name}`;
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
