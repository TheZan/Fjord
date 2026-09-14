import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode, type UIEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useTranslation } from "react-i18next";
import { useFileDiff, type DiffSource } from "@/application/useFileDiff";
import { CHANGE_TYPE_COLOR } from "@/presentation/diffFormatting";
import { DestructivePreflightDialog } from "@/presentation/DestructivePreflightDialog";
import { Select, Surface } from "@/presentation/ui";
import { loadUiState, saveRepoModes } from "@/infrastructure/uiState";
import { useDiffHighlight } from "@/presentation/useDiffHighlight";
import type { HighlightLineInput, HighlightToken, HighlightTokenKind, TextRange } from "@/presentation/diffHighlight";
import type { DestructiveAction, DiffLineKind, DiffWhitespaceMode, DiscardSelection, GenerationSet, PatchSelection } from "@/domain/git";
import type { DiffHunk, DiffLine } from "@/domain/git";
import type { UiDiffMode } from "@/domain/generated";

const DIFF_LINE_HEIGHT = 20;
const HUNK_HEADER_HEIGHT = 24;

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
 * Bare-text `interactive-control` buttons only reveal themselves on hover,
 * so a disabled "stage selected lines" and an actionable one look identical
 * at rest. These give diff actions real button chrome (border + fill) so
 * enabled/disabled and stage/discard read at a glance without hovering.
 */
const DIFF_ACTION_BUTTON_CLASS =
  "interactive-control shrink-0 whitespace-nowrap rounded border px-2 py-0.5 text-[11px] font-medium disabled:cursor-not-allowed disabled:opacity-45";

function toolbarActionStyle(tone: "stage" | "discard"): CSSProperties {
  return {
    borderWidth: "0.5px",
    ...(tone === "stage"
      ? { background: "var(--fjord-tint)", borderColor: "var(--fjord)", color: "var(--fjord-ink)" }
      : { background: "transparent", borderColor: "var(--hairline-strong)", color: "var(--rust-ink)" }),
  };
}

function hunkActionStyle(tone: "stage" | "discard"): CSSProperties {
  return {
    borderWidth: "0.5px",
    background: "var(--paper)",
    ...(tone === "stage"
      ? { borderColor: "var(--fjord)", color: "var(--fjord-ink)" }
      : { borderColor: "var(--hairline-strong)", color: "var(--rust-ink)" }),
  };
}

/**
 * Full-detail diff for one file, meant to take over the center column when a
 * file is selected (see RepoDetailView): the diff replaces the commit graph
 * rather than squeezing into a narrow side panel.
 */
export function FileDiffView({
  repoId,
  path,
  source,
  onBack,
  actionDisabled = false,
  onApplyFile,
  onApplyHunk,
  onDiscardPatch,
  onWhitespaceModeChange,
}: {
  repoId: string;
  path: string;
  source: DiffSource;
  onBack?: () => void;
  actionDisabled?: boolean;
  onApplyFile?: () => void;
  onApplyHunk?: (selection: PatchSelection, expectedGenerations: GenerationSet) => Promise<boolean>;
  onDiscardPatch?: (
    action: DestructiveAction,
    selection: PatchSelection,
    expectedGenerations: GenerationSet,
    confirmationToken: string,
  ) => Promise<boolean>;
  /** Reports the active whitespace mode for the open working-file diff, so a
   * context menu elsewhere can disable patch export while it hides real
   * content — never called for a commit diff. */
  onWhitespaceModeChange?: (target: { path: string; source: DiffSource } | null, mode: DiffWhitespaceMode) => void;
}) {
  const { t } = useTranslation("workspace");
  const [whitespace, setWhitespace] = useState<DiffWhitespaceMode>("show");

  // `source` is a fresh object literal on every render of the caller
  // (RepoDetailView builds it inline), so depending on it directly made this
  // effect refire on every unrelated re-render — each run notified the
  // parent, which re-rendered and recreated `source`, forming a loop that
  // tripped React's "Maximum update depth exceeded". Key on its primitive
  // fields instead so the effect only reruns when the source actually
  // changes.
  const sourceKey = diffSourceKey(source);
  useEffect(() => {
    onWhitespaceModeChange?.(source.kind === "working" ? { path, source } : null, whitespace);
    return () => onWhitespaceModeChange?.(null, "show");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, sourceKey, whitespace, onWhitespaceModeChange]);
  const [wordDiff, setWordDiff] = useState(true);
  const [loadAnyway, setLoadAnyway] = useState(false);
  const { diff, loading, loadingMore, hasMore, loadMore, error, generations, snapshotInvalid } = useFileDiff(
    repoId,
    path,
    source,
    whitespace,
    loadAnyway,
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const leftSplitScrollRef = useRef<HTMLDivElement>(null);
  const rightSplitScrollRef = useRef<HTMLDivElement>(null);
  const suppressLeftSplitScroll = useRef(false);
  const suppressRightSplitScroll = useRef(false);
  const pendingModeAnchor = useRef<DiffRowAnchor | null>(null);
  const [diffMode, setDiffMode] = useState<UiDiffMode>("unified");
  const [viewportHeight, setViewportHeight] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [lineSelection, setLineSelection] = useState<LineSelection | null>(null);
  const [selectionPending, setSelectionPending] = useState(false);
  const [pendingDiscard, setPendingDiscard] = useState<PendingDiscard | null>(null);
  const sourceIdentity = diffSourceKey(source);
  const rows = useMemo(() => buildDiffRows(diff?.hunks ?? [], diffMode), [diff?.hunks, diffMode]);
  const actionsDisabled = actionDisabled || snapshotInvalid;
  const snapshotKey = `${repoId}\0${path}\0${sourceIdentity}\0${whitespace}\0${diff?.baseDigest ?? ""}\0${generationKey(generations)}`;
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => estimateDiffRowSize(rows[index]),
    overscan: 20,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const lastVisibleIndex = virtualRows.at(-1)?.index ?? -1;
  const visibleRowKey = virtualRows.map((row) => row.index).join(",");
  const wordPairKeys = useMemo(() => buildWordPairKeys(diff?.hunks ?? []), [diff?.hunks]);
  const visibleHighlightLines = useMemo(
    () => collectHighlightLines(rows, virtualRows.map((row) => row.index), wordPairKeys),
    // The serialized indexes make the input stable while the virtualizer
    // returns an equivalent array on unrelated renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, visibleRowKey, wordPairKeys],
  );
  const enhancements = useDiffHighlight(path, visibleHighlightLines, wordDiff);
  const loadedLines = diff?.hunks.reduce(
    (count, hunk) => count + hunk.lines.length,
    0,
  ) ?? 0;
  const modeOnly = Boolean(
    diff
    && !diff.isBinary
    && !diff.tooLarge
    && diff.hunks.length === 0
    && diff.oldMode !== diff.newMode,
  );

  useEffect(() => {
    setLoadAnyway(false);
  }, [repoId, path, sourceIdentity]);

  useEffect(() => {
    void loadUiState()
      .then((state) => setDiffMode(state.repo.diffMode))
      .catch(() => undefined);
  }, []);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    setViewportHeight(element.clientHeight);
    const observer = new ResizeObserver((entries) => setViewportHeight(entries[0].contentRect.height));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    rowVirtualizer.measure();
    const anchor = pendingModeAnchor.current;
    pendingModeAnchor.current = null;
    if (!anchor) return;
    const anchorIndex = rows.findIndex((row) => rowContainsAnchor(row, anchor));
    if (anchorIndex >= 0) rowVirtualizer.scrollToIndex(anchorIndex, { align: "start" });
    // This effect is intentionally keyed only by presentation mode. Incoming
    // diff windows should not force a full virtualizer remeasurement.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diffMode]);

  useEffect(() => {
    if (hasMore && !loadingMore && lastVisibleIndex >= rows.length - 100) loadMore();
  }, [hasMore, lastVisibleIndex, loadMore, loadingMore, rows.length]);

  useEffect(() => {
    setLineSelection(null);
    setSelectionPending(false);
    setPendingDiscard(null);
  }, [snapshotKey]);

  useEffect(() => {
    if (!snapshotInvalid) return;
    setLineSelection(null);
    setSelectionPending(false);
    setPendingDiscard(null);
  }, [snapshotInvalid]);

  function selectLine(hunkIndex: number, lineIndex: number, event: MouseEvent<HTMLButtonElement>) {
    if (snapshotInvalid || selectionPending || pendingDiscard || source.kind !== "working" || !diff) return;
    setLineSelection((current) => {
      if (event.shiftKey && current?.hunkIndex === hunkIndex) {
        return rangeSelection(diff.hunks[hunkIndex], hunkIndex, current.anchorIndex, lineIndex);
      }
      const lineIndices = current?.hunkIndex === hunkIndex
        ? new Set(current.lineIndices)
        : new Set<number>();
      if (lineIndices.has(lineIndex)) lineIndices.delete(lineIndex);
      else lineIndices.add(lineIndex);
      return lineIndices.size > 0 ? { hunkIndex, lineIndices, anchorIndex: lineIndex } : null;
    });
  }

  function extendLineSelection(hunkIndex: number, lineIndex: number, direction: -1 | 1) {
    if (snapshotInvalid || selectionPending || pendingDiscard || source.kind !== "working" || !diff) return;
    const hunk = diff.hunks[hunkIndex];
    const targetIndex = nextChangedLineIndex(hunk, lineIndex, direction);
    if (targetIndex === null) return;
    setLineSelection((current) => {
      const anchorIndex = current?.hunkIndex === hunkIndex ? current.anchorIndex : lineIndex;
      return rangeSelection(hunk, hunkIndex, anchorIndex, targetIndex);
    });
    queueMicrotask(() => {
      document.querySelector<HTMLButtonElement>(`[data-diff-line="${hunkIndex}:${targetIndex}"]`)?.focus();
    });
  }

  async function applySelectedLines(hunkIndex: number, hunk: DiffHunk) {
    if (
      snapshotInvalid ||
      selectionPending ||
      !onApplyHunk ||
      !diff?.baseDigest ||
      !generations ||
      lineSelection?.hunkIndex !== hunkIndex ||
      lineSelection.lineIndices.size === 0
    ) return;
    const selection = selectedLinesSelection(path, source, hunk, diff.baseDigest, lineSelection.lineIndices);
    const expectedGenerations = generations;
    setSelectionPending(true);
    try {
      await onApplyHunk(selection, expectedGenerations);
    } finally {
      setLineSelection(null);
      setSelectionPending(false);
    }
  }

  function requestDiscard(selection: PatchSelection, discardSelection: DiscardSelection) {
    if (snapshotInvalid || selectionPending || pendingDiscard || !onDiscardPatch) return;
    setPendingDiscard({
      selection,
      action: { kind: "discard", selection: discardSelection },
      snapshotKey,
    });
  }

  function discardSelectedLines(hunkIndex: number, hunk: DiffHunk) {
    if (
      !diff?.baseDigest ||
      !generations ||
      lineSelection?.hunkIndex !== hunkIndex ||
      lineSelection.lineIndices.size === 0
    ) return;
    const selection = selectedLinesSelection(path, source, hunk, diff.baseDigest, lineSelection.lineIndices);
    requestDiscard(selection, linesDiscardSelection(path, hunk, lineSelection.lineIndices));
  }

  const canDiscard = source.kind === "working" && !source.staged && Boolean(onDiscardPatch);

  function handleLeftSplitScroll(event: UIEvent<HTMLDivElement>) {
    if (suppressLeftSplitScroll.current) {
      suppressLeftSplitScroll.current = false;
      return;
    }
    const target = rightSplitScrollRef.current;
    const nextScrollLeft = event.currentTarget.scrollLeft;
    if (!target || target.scrollLeft === nextScrollLeft) return;
    suppressRightSplitScroll.current = true;
    target.scrollLeft = nextScrollLeft;
  }

  function handleRightSplitScroll(event: UIEvent<HTMLDivElement>) {
    if (suppressRightSplitScroll.current) {
      suppressRightSplitScroll.current = false;
      return;
    }
    const target = leftSplitScrollRef.current;
    const nextScrollLeft = event.currentTarget.scrollLeft;
    if (!target || target.scrollLeft === nextScrollLeft) return;
    suppressLeftSplitScroll.current = true;
    target.scrollLeft = nextScrollLeft;
  }

  function changeDiffMode(mode: UiDiffMode) {
    if (mode === diffMode) return;
    const scrollTop = scrollRef.current?.scrollTop ?? 0;
    const firstVisibleItem = virtualRows.find((row) => row.start + row.size > scrollTop) ?? virtualRows[0];
    const firstVisibleRow = rows[firstVisibleItem?.index ?? -1];
    pendingModeAnchor.current = firstVisibleRow ? anchorForRow(firstVisibleRow) : null;
    setDiffMode(mode);
    void saveRepoModes(mode, null).catch(() => undefined);
  }

  return <>
    <Surface className="flex h-full min-h-0 w-full flex-col text-sm" style={{ background: "var(--paper)" }}>
      <div
        className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-3 py-2"
        style={{ borderColor: "var(--hairline)" }}
      >
        <div className="flex min-w-40 flex-1 items-center gap-3">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="interactive-control shrink-0 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px]"
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
        <div
          className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2"
          data-testid="file-diff-header-actions"
        >
          <div
            role="radiogroup"
            aria-label={t("diff.viewMode")}
            className="flex shrink-0 items-center rounded border p-0.5"
            style={{ borderColor: "var(--hairline)", background: "var(--canvas)" }}
          >
            {(["unified", "split"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={diffMode === mode}
                data-diff-mode={mode}
                className="interactive-control shrink-0 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px]"
                style={{
                  background: diffMode === mode ? "var(--paper)" : "transparent",
                  color: diffMode === mode ? "var(--ink)" : "var(--slate)",
                }}
                onClick={() => changeDiffMode(mode)}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                  event.preventDefault();
                  const nextMode = mode === "unified" ? "split" : "unified";
                  changeDiffMode(nextMode);
                  queueMicrotask(() => document.querySelector<HTMLButtonElement>(`[data-diff-mode="${nextMode}"]`)?.focus());
                }}
              >
                {t(`diff.${mode}`)}
              </button>
            ))}
          </div>
          <Select
            aria-label={t("diff.whitespace.label")}
            className="h-6 w-auto shrink-0 px-1.5 py-0 text-[11px]"
            value={whitespace}
            onChange={(event) => setWhitespace(event.target.value as DiffWhitespaceMode)}
          >
            <option value="show">{t("diff.whitespace.show")}</option>
            <option value="ignoreTrailing">{t("diff.whitespace.ignoreTrailing")}</option>
            <option value="ignoreAll">{t("diff.whitespace.ignoreAll")}</option>
          </Select>
          <button
            type="button"
            role="switch"
            aria-checked={wordDiff}
            className="interactive-control shrink-0 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px]"
            style={{ color: wordDiff ? "var(--fjord-ink)" : "var(--slate)" }}
            onClick={() => setWordDiff((enabled) => !enabled)}
          >
            {t("diff.wordDiff")}
          </button>
          {source.kind === "working" && onApplyFile ? (
            <button
              type="button"
              className={DIFF_ACTION_BUTTON_CLASS}
              style={toolbarActionStyle("stage")}
              disabled={actionsDisabled || selectionPending || Boolean(pendingDiscard)}
              onClick={onApplyFile}
            >
              {t(source.staged ? "diff.unstageFile" : "diff.stageFile")}
            </button>
          ) : null}
          {canDiscard && diff?.baseDigest && generations && diff.hunks.length > 0 ? (
            <button
              type="button"
              className={DIFF_ACTION_BUTTON_CLASS}
              style={toolbarActionStyle("discard")}
              disabled={actionsDisabled || whitespace !== "show" || selectionPending || Boolean(pendingDiscard) || hasMore || loadingMore}
              title={
                whitespace !== "show"
                  ? t("diff.whitespace.partialActionsDisabled")
                  : hasMore || loadingMore ? t("diff.discardFileIncomplete") : undefined
              }
              onClick={() => requestDiscard(
                wholeFileSelection(path, diff.hunks, diff.baseDigest!),
                { kind: "file", path },
              )}
            >
              {t("diff.discardFile")}
            </button>
          ) : null}
        </div>
      </div>

      {diff ? (
        <div
          className="flex items-center gap-3 border-b px-3 py-1 text-[11px]"
          style={{ borderColor: "var(--hairline)", color: "var(--mist)" }}
        >
          <span>{t("diff.counts", { hunks: diff.totalHunks, lines: diff.totalLines })}</span>
          {!diff.isBinary && !diff.tooLarge && (hasMore || loadingMore) ? (
            <span>{t("diff.loaded", { loaded: loadedLines, total: diff.totalLines })}</span>
          ) : null}
        </div>
      ) : null}

      <div
        ref={scrollRef}
        className={`min-h-0 flex-1 ${diffMode === "split" ? "overflow-y-auto overflow-x-hidden" : "overflow-auto"}`}
        onScroll={diffMode === "split" ? (event) => setScrollTop(event.currentTarget.scrollTop) : undefined}
      >
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
        {!loading && !error && diff?.tooLarge && !diff.isBinary && (
          <div className="p-3 text-xs" style={{ color: "var(--slate)" }}>
            <p>{t("diff.tooLarge", { size: formatFileBytes(diff.fileBytes) })}</p>
            <button
              type="button"
              className="interactive-control mt-2 rounded px-2 py-1 text-[11px]"
              style={{ color: "var(--fjord-ink)" }}
              onClick={() => setLoadAnyway(true)}
            >
              {t("diff.loadAnyway")}
            </button>
          </div>
        )}
        {!loading && !error && modeOnly && diff && (
          <p className="p-3 text-xs" style={{ color: "var(--slate)" }}>
            {t("diff.modeOnly", {
              oldMode: formatFileMode(diff.oldMode),
              newMode: formatFileMode(diff.newMode),
            })}
          </p>
        )}
        {!loading && !error && diff && !diff.isBinary && !diff.tooLarge && !modeOnly && diff.hunks.length === 0 && (
          <p className="p-3 text-xs" style={{ color: "var(--slate)" }}>
            {t("diff.empty")}
          </p>
        )}
        {diff && !diff.isBinary && !diff.tooLarge && rows.length > 0 && (
          diffMode === "split" ? (
            <div
              className="selectable-text relative w-full font-mono text-xs"
              style={{ height: rowVirtualizer.getTotalSize() }}
            >
              {/*
                The columns are pinned to the visible viewport (not the full
                virtualized height) so their native horizontal scrollbar sits
                at the bottom of the screen instead of the bottom of the
                entire (mostly off-screen) row list. Row offsets inside them
                are translated relative to the current scrollTop instead of
                the list top, since the pinned box no longer scrolls with it.
              */}
              <div className="sticky top-0 flex w-full" style={{ height: viewportHeight || undefined }}>
                <div
                  ref={leftSplitScrollRef}
                  data-testid="split-scroll-old"
                  className="h-full w-1/2 overflow-x-auto overflow-y-hidden border-r"
                  style={{ borderColor: "var(--hairline)" }}
                  onScroll={handleLeftSplitScroll}
                >
                  <div className="relative w-max min-w-full" style={{ height: viewportHeight }}>
                    {virtualRows.map((virtualRow) => {
                      const row = rows[virtualRow.index];
                      if (row.kind !== "split") return null;
                      return (
                        <div
                          key={row.key}
                          className="absolute left-0 top-0 min-w-full"
                          style={{ height: virtualRow.size, transform: `translateY(${virtualRow.start - scrollTop}px)` }}
                        >
                          <SplitDiffCell
                            {...splitCellProps(
                              "old",
                              row.left,
                              row.hunkIndex,
                              whitespace === "show" && source.kind === "working" && !actionsDisabled && !selectionPending && !pendingDiscard,
                              lineSelection?.hunkIndex === row.hunkIndex ? lineSelection.lineIndices : null,
                              enhancements.tokens,
                              enhancements.wordChanges,
                              selectLine,
                              extendLineSelection,
                            )}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
                <div
                  ref={rightSplitScrollRef}
                  data-testid="split-scroll-new"
                  className="h-full w-1/2 overflow-x-auto overflow-y-hidden"
                  onScroll={handleRightSplitScroll}
                >
                  <div className="relative w-max min-w-full" style={{ height: viewportHeight }}>
                    {virtualRows.map((virtualRow) => {
                      const row = rows[virtualRow.index];
                      if (row.kind !== "split") return null;
                      return (
                        <div
                          key={row.key}
                          className="absolute left-0 top-0 min-w-full"
                          style={{ height: virtualRow.size, transform: `translateY(${virtualRow.start - scrollTop}px)` }}
                        >
                          <SplitDiffCell
                            {...splitCellProps(
                              "new",
                              row.right,
                              row.hunkIndex,
                              whitespace === "show" && source.kind === "working" && !actionsDisabled && !selectionPending && !pendingDiscard,
                              lineSelection?.hunkIndex === row.hunkIndex ? lineSelection.lineIndices : null,
                              enhancements.tokens,
                              enhancements.wordChanges,
                              selectLine,
                              extendLineSelection,
                            )}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
              {virtualRows.map((virtualRow) => {
                const row = rows[virtualRow.index];
                if (row.kind !== "hunk") return null;
                return (
                  <div
                    key={row.key}
                    className="absolute left-0 top-0 w-full"
                    style={{ height: virtualRow.size, transform: `translateY(${virtualRow.start}px)` }}
                  >
                    <HunkRow
                      hunk={row.hunk}
                      source={source}
                      partialApplyUnsupported={
                        whitespace !== "show"
                        || (source.kind === "working" && source.staged && diff.changeType === "deleted")
                      }
                      partialApplyUnsupportedReason={
                        whitespace !== "show"
                          ? t("diff.whitespace.partialActionsDisabled")
                          : t("diff.partialDeletedUnstageUnsupported")
                      }
                      disabled={actionsDisabled || selectionPending || Boolean(pendingDiscard) || !diff.baseDigest || !generations}
                      selectedLineCount={lineSelection?.hunkIndex === row.hunkIndex ? lineSelection.lineIndices.size : 0}
                      selectionPending={selectionPending && lineSelection?.hunkIndex === row.hunkIndex}
                      onApply={
                        diff.baseDigest && generations && onApplyHunk
                          ? () => onApplyHunk(wholeHunkSelection(path, source, row.hunk, diff.baseDigest!), generations)
                          : undefined
                      }
                      onApplySelected={onApplyHunk ? () => applySelectedLines(row.hunkIndex, row.hunk) : undefined}
                      onDiscard={
                        canDiscard && diff.baseDigest
                          ? () => requestDiscard(
                            wholeHunkSelection(path, source, row.hunk, diff.baseDigest!),
                            hunkDiscardSelection(path, row.hunk),
                          )
                          : undefined
                      }
                      onDiscardSelected={canDiscard ? () => discardSelectedLines(row.hunkIndex, row.hunk) : undefined}
                    />
                  </div>
                );
              })}
            </div>
          ) : (
            <div
              className="selectable-text relative w-max min-w-full font-mono text-xs"
              style={{ height: rowVirtualizer.getTotalSize() }}
            >
              {virtualRows.map((virtualRow) => {
                const row = rows[virtualRow.index];
                return (
                  <div
                    key={row.key}
                    className="absolute left-0 top-0 min-w-full"
                    style={{
                      height: virtualRow.size,
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    {row.kind === "hunk" ? (
                      <HunkRow
                        hunk={row.hunk}
                        source={source}
                        partialApplyUnsupported={
                          whitespace !== "show"
                          || (source.kind === "working" && source.staged && diff.changeType === "deleted")
                        }
                        partialApplyUnsupportedReason={
                          whitespace !== "show"
                            ? t("diff.whitespace.partialActionsDisabled")
                            : t("diff.partialDeletedUnstageUnsupported")
                        }
                        disabled={actionsDisabled || selectionPending || Boolean(pendingDiscard) || !diff.baseDigest || !generations}
                        selectedLineCount={lineSelection?.hunkIndex === row.hunkIndex ? lineSelection.lineIndices.size : 0}
                        selectionPending={selectionPending && lineSelection?.hunkIndex === row.hunkIndex}
                        onApply={
                          diff.baseDigest && generations && onApplyHunk
                            ? () => onApplyHunk(wholeHunkSelection(path, source, row.hunk, diff.baseDigest!), generations)
                            : undefined
                        }
                        onApplySelected={onApplyHunk ? () => applySelectedLines(row.hunkIndex, row.hunk) : undefined}
                        onDiscard={
                          canDiscard && diff.baseDigest
                            ? () => requestDiscard(
                              wholeHunkSelection(path, source, row.hunk, diff.baseDigest!),
                              hunkDiscardSelection(path, row.hunk),
                            )
                            : undefined
                        }
                        onDiscardSelected={canDiscard ? () => discardSelectedLines(row.hunkIndex, row.hunk) : undefined}
                      />
                    ) : row.kind === "line" ? (
                      <DiffLineRow
                        line={row.line}
                        hunkIndex={row.hunkIndex}
                        lineIndex={row.lineIndex}
                        interactive={whitespace === "show" && source.kind === "working" && !actionsDisabled && !selectionPending && !pendingDiscard}
                        selected={lineSelection?.hunkIndex === row.hunkIndex && lineSelection.lineIndices.has(row.lineIndex)}
                        tokens={enhancements.tokens.get(diffLineKey(row.hunkIndex, row.lineIndex))}
                        wordChanges={enhancements.wordChanges.get(diffLineKey(row.hunkIndex, row.lineIndex))}
                        onSelect={selectLine}
                        onExtendSelection={extendLineSelection}
                      />
                    ) : null}
                  </div>
                );
              })}
            </div>
          )
        )}
        {loadingMore && (
          <p className="p-2 text-center text-xs" style={{ color: "var(--mist)" }}>
            {t("diff.loadingMore")}
          </p>
        )}
      </div>
    </Surface>
    {pendingDiscard?.snapshotKey === snapshotKey && diff?.baseDigest && generations ? (
      <DestructivePreflightDialog
        repoId={repoId}
        action={pendingDiscard.action}
        patchSelections={[pendingDiscard.selection]}
        onClose={() => setPendingDiscard(null)}
        onConfirm={async (confirmedGenerations, confirmationToken) => {
          const request = pendingDiscard;
          const succeeded = await onDiscardPatch?.(
            request.action,
            request.selection,
            confirmedGenerations,
            confirmationToken,
          ) ?? false;
          setPendingDiscard(null);
          setLineSelection(null);
          if (succeeded) setSelectionPending(false);
        }}
      />
    ) : null}
  </>;
}

function formatFileBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatFileMode(mode: number | null): string {
  return mode === null ? "—" : mode.toString(8).padStart(6, "0");
}

type DiffLineRef = { line: DiffLine; lineIndex: number };

type FlatDiffRow =
  | { kind: "hunk"; key: string; hunk: DiffHunk; hunkIndex: number }
  | { kind: "line"; key: string; line: DiffLine; hunkIndex: number; lineIndex: number }
  | { kind: "split"; key: string; left: DiffLineRef | null; right: DiffLineRef | null; hunkIndex: number };

export function buildDiffRows(hunks: DiffHunk[], mode: UiDiffMode): FlatDiffRow[] {
  return mode === "unified" ? buildUnifiedRows(hunks) : buildSplitRows(hunks);
}

function buildUnifiedRows(hunks: DiffHunk[]): FlatDiffRow[] {
  return hunks.flatMap((hunk, hunkIndex) => [
    { kind: "hunk" as const, key: `hunk-${hunkIndex}`, hunk, hunkIndex },
    ...hunk.lines.map((line, lineIndex) => ({
      kind: "line" as const,
      key: `line-${hunkIndex}-${lineIndex}`,
      line,
      hunkIndex,
      lineIndex,
    })),
  ]);
}

function buildSplitRows(hunks: DiffHunk[]): FlatDiffRow[] {
  return hunks.flatMap((hunk, hunkIndex) => {
    const rows: FlatDiffRow[] = [{ kind: "hunk", key: `hunk-${hunkIndex}`, hunk, hunkIndex }];
    let lineIndex = 0;
    while (lineIndex < hunk.lines.length) {
      const line = hunk.lines[lineIndex];
      if (line.kind === "context") {
        const reference = { line, lineIndex };
        rows.push({ kind: "split", key: `split-${hunkIndex}-${lineIndex}`, left: reference, right: reference, hunkIndex });
        lineIndex += 1;
        continue;
      }

      const deletions: DiffLineRef[] = [];
      const additions: DiffLineRef[] = [];
      while (lineIndex < hunk.lines.length && hunk.lines[lineIndex].kind !== "context") {
        const changed = hunk.lines[lineIndex];
        (changed.kind === "deletion" ? deletions : additions).push({ line: changed, lineIndex });
        lineIndex += 1;
      }
      const pairCount = Math.max(deletions.length, additions.length);
      for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
        const left = deletions[pairIndex] ?? null;
        const right = additions[pairIndex] ?? null;
        rows.push({
          kind: "split",
          key: `split-${hunkIndex}-${left?.lineIndex ?? "pad"}-${right?.lineIndex ?? "pad"}`,
          left,
          right,
          hunkIndex,
        });
      }
    }
    return rows;
  });
}

function estimateDiffRowSize(row: FlatDiffRow): number {
  return row.kind === "hunk" ? HUNK_HEADER_HEIGHT : DIFF_LINE_HEIGHT;
}

function diffLineKey(hunkIndex: number, lineIndex: number): string {
  return `${hunkIndex}:${lineIndex}`;
}

function collectHighlightLines(
  rows: FlatDiffRow[],
  indexes: number[],
  wordPairKeys: ReadonlyMap<string, string>,
): HighlightLineInput[] {
  const visible = new Map<string, HighlightLineInput>();
  for (const index of indexes) {
    const row = rows[index];
    if (!row || row.kind === "hunk") continue;
    const references = row.kind === "line"
      ? [{ line: row.line, lineIndex: row.lineIndex }]
      : [row.left, row.right].filter((reference): reference is DiffLineRef => reference !== null);
    for (const reference of references) {
      const key = diffLineKey(row.hunkIndex, reference.lineIndex);
      visible.set(key, {
        key,
        content: reference.line.content,
        pairKey: wordPairKeys.get(key),
        kind: reference.line.kind,
      });
    }
  }
  return [...visible.values()];
}

function buildWordPairKeys(hunks: DiffHunk[]): Map<string, string> {
  const pairs = new Map<string, string>();
  hunks.forEach((hunk, hunkIndex) => {
    let lineIndex = 0;
    let pairIndex = 0;
    while (lineIndex < hunk.lines.length) {
      if (hunk.lines[lineIndex].kind === "context") {
        lineIndex += 1;
        continue;
      }
      const deletions: number[] = [];
      const additions: number[] = [];
      while (lineIndex < hunk.lines.length && hunk.lines[lineIndex].kind !== "context") {
        (hunk.lines[lineIndex].kind === "deletion" ? deletions : additions).push(lineIndex);
        lineIndex += 1;
      }
      const count = Math.min(deletions.length, additions.length);
      for (let index = 0; index < count; index += 1) {
        const pairKey = `${hunkIndex}:${pairIndex}`;
        pairs.set(diffLineKey(hunkIndex, deletions[index]), pairKey);
        pairs.set(diffLineKey(hunkIndex, additions[index]), pairKey);
        pairIndex += 1;
      }
    }
  });
  return pairs;
}

type DiffRowAnchor = { hunkIndex: number; lineIndex: number | null };

function anchorForRow(row: FlatDiffRow): DiffRowAnchor {
  if (row.kind === "hunk") return { hunkIndex: row.hunkIndex, lineIndex: null };
  if (row.kind === "line") return { hunkIndex: row.hunkIndex, lineIndex: row.lineIndex };
  return { hunkIndex: row.hunkIndex, lineIndex: row.left?.lineIndex ?? row.right?.lineIndex ?? null };
}

function rowContainsAnchor(row: FlatDiffRow, anchor: DiffRowAnchor): boolean {
  if (row.hunkIndex !== anchor.hunkIndex) return false;
  if (anchor.lineIndex === null) return row.kind === "hunk";
  if (row.kind === "line") return row.lineIndex === anchor.lineIndex;
  if (row.kind === "split") return row.left?.lineIndex === anchor.lineIndex || row.right?.lineIndex === anchor.lineIndex;
  return false;
}

interface LineSelection {
  hunkIndex: number;
  lineIndices: Set<number>;
  anchorIndex: number;
}

interface PendingDiscard {
  selection: PatchSelection;
  action: DestructiveAction;
  snapshotKey: string;
}

function diffSourceKey(source: DiffSource) {
  if (source.kind === "commit") return `commit:${source.commitId}`;
  if (source.kind === "stash") return `stash:${source.stashId}:${source.group}`;
  return `working:${source.staged}`;
}

function generationKey(generations: GenerationSet | null) {
  return generations
    ? `${generations.workingTree}:${generations.refs}:${generations.history}:${generations.stash}:${generations.config}`
    : "";
}

function isChangedLine(line: DiffLine | undefined) {
  return line?.kind === "addition" || line?.kind === "deletion";
}

function rangeSelection(hunk: DiffHunk, hunkIndex: number, anchorIndex: number, lineIndex: number): LineSelection {
  const start = Math.min(anchorIndex, lineIndex);
  const end = Math.max(anchorIndex, lineIndex);
  const lineIndices = new Set<number>();
  for (let index = start; index <= end; index += 1) {
    if (isChangedLine(hunk.lines[index])) lineIndices.add(index);
  }
  return { hunkIndex, lineIndices, anchorIndex };
}

function nextChangedLineIndex(hunk: DiffHunk, lineIndex: number, direction: -1 | 1): number | null {
  for (let index = lineIndex + direction; index >= 0 && index < hunk.lines.length; index += direction) {
    if (isChangedLine(hunk.lines[index])) return index;
  }
  return null;
}

function wholeHunkSelection(path: string, source: DiffSource, hunk: DiffHunk, baseDigest: string): PatchSelection {
  return {
    path,
    source: source.kind === "working" && source.staged ? "index" : "worktree",
    baseDigest,
    hunks: [{ oldStart: hunk.oldStart, oldLines: hunk.oldLines, newStart: hunk.newStart, newLines: hunk.newLines, lines: [] }],
  };
}

function selectedLinesSelection(
  path: string,
  source: DiffSource,
  hunk: DiffHunk,
  baseDigest: string,
  lineIndices: Set<number>,
): PatchSelection {
  return {
    path,
    source: source.kind === "working" && source.staged ? "index" : "worktree",
    baseDigest,
    hunks: [{
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines,
      lines: [...lineIndices].sort((left, right) => left - right),
    }],
  };
}

function wholeFileSelection(path: string, hunks: DiffHunk[], baseDigest: string): PatchSelection {
  return {
    path,
    source: "worktree",
    baseDigest,
    hunks: hunks.map((hunk) => ({
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines,
      lines: [],
    })),
  };
}

function hunkDiscardSelection(path: string, hunk: DiffHunk): DiscardSelection {
  return {
    kind: "hunk",
    path,
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
  };
}

function linesDiscardSelection(path: string, hunk: DiffHunk, lineIndices: Set<number>): DiscardSelection {
  return {
    kind: "lines",
    path,
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    lines: [...lineIndices].sort((left, right) => left - right),
  };
}

function HunkRow({
  hunk,
  source,
  partialApplyUnsupported,
  partialApplyUnsupportedReason,
  disabled,
  selectedLineCount,
  selectionPending,
  onApply,
  onApplySelected,
  onDiscard,
  onDiscardSelected,
}: {
  hunk: DiffHunk;
  source: DiffSource;
  partialApplyUnsupported: boolean;
  partialApplyUnsupportedReason: string;
  disabled: boolean;
  selectedLineCount: number;
  selectionPending: boolean;
  onApply?: () => Promise<boolean>;
  onApplySelected?: () => Promise<void>;
  onDiscard?: () => void;
  onDiscardSelected?: () => void;
}) {
  const { t } = useTranslation("workspace");
  const [pending, setPending] = useState(false);
  const staged = source.kind === "working" && source.staged;
  if (source.kind !== "working") {
    return <HunkHeader hunk={hunk} />;
  }

  const actionLabel = pending
    ? t(staged ? "diff.unstagingHunk" : "diff.stagingHunk")
    : t(staged ? "diff.unstageHunk" : "diff.stageHunk");
  return (
    <div className="flex h-full items-center gap-2 whitespace-nowrap px-3 py-1" style={{ background: "var(--fjord-tint)", color: "var(--fjord-ink)" }}>
      <HunkCoordinates hunk={hunk} />
      <button
        type="button"
        className={`${DIFF_ACTION_BUTTON_CLASS} ml-auto`}
        style={hunkActionStyle("stage")}
        disabled={disabled || partialApplyUnsupported || selectedLineCount === 0 || !onApplySelected}
        title={partialApplyUnsupported ? partialApplyUnsupportedReason : undefined}
        aria-label={t(staged ? "diff.unstageSelectedLines" : "diff.stageSelectedLines")}
        onClick={() => void onApplySelected?.()}
      >
        {selectionPending
          ? t(staged ? "diff.unstagingSelectedLines" : "diff.stagingSelectedLines")
          : t(staged ? "diff.unstageSelectedLines" : "diff.stageSelectedLines")}
      </button>
      {!staged && onDiscardSelected ? (
        <button
          type="button"
          className={DIFF_ACTION_BUTTON_CLASS}
          style={hunkActionStyle("discard")}
          disabled={disabled || partialApplyUnsupported || selectedLineCount === 0}
          title={partialApplyUnsupported ? partialApplyUnsupportedReason : undefined}
          aria-label={t("diff.discardSelectedLines")}
          onClick={onDiscardSelected}
        >
          {t("diff.discardSelectedLines")}
        </button>
      ) : null}
      <button
        type="button"
        className={DIFF_ACTION_BUTTON_CLASS}
        style={hunkActionStyle("stage")}
        disabled={disabled || partialApplyUnsupported || pending || !onApply}
        title={partialApplyUnsupported ? partialApplyUnsupportedReason : undefined}
        aria-label={actionLabel}
        onClick={() => {
          if (pending || !onApply) return;
          setPending(true);
          void onApply().finally(() => setPending(false));
        }}
      >
        {actionLabel}
      </button>
      {!staged && onDiscard ? (
        <button
          type="button"
          className={DIFF_ACTION_BUTTON_CLASS}
          style={hunkActionStyle("discard")}
          disabled={disabled || partialApplyUnsupported}
          title={partialApplyUnsupported ? partialApplyUnsupportedReason : undefined}
          aria-label={t("diff.discardHunk")}
          onClick={onDiscard}
        >
          {t("diff.discardHunk")}
        </button>
      ) : null}
    </div>
  );
}

function HunkHeader({ hunk }: { hunk: DiffHunk }) {
  return (
    <div
      className="h-full whitespace-nowrap px-3 py-1"
      style={{ background: "var(--fjord-tint)", color: "var(--fjord-ink)" }}
    >
      <HunkCoordinates hunk={hunk} />
    </div>
  );
}

function HunkCoordinates({ hunk }: { hunk: DiffHunk }) {
  return <>@@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@</>;
}

function DiffLineRow({
  line,
  hunkIndex,
  lineIndex,
  interactive,
  selected,
  tokens,
  wordChanges,
  onSelect,
  onExtendSelection,
}: {
  line: DiffLine;
  hunkIndex: number;
  lineIndex: number;
  interactive: boolean;
  selected: boolean;
  tokens?: HighlightToken[];
  wordChanges?: TextRange[];
  onSelect: (hunkIndex: number, lineIndex: number, event: MouseEvent<HTMLButtonElement>) => void;
  onExtendSelection: (hunkIndex: number, lineIndex: number, direction: -1 | 1) => void;
}) {
  const { t } = useTranslation("workspace");
  const content = <>
    <span className="w-10 shrink-0 select-none px-1 text-right" style={{ color: "var(--mist)" }}>
      {line.oldLineno ?? ""}
    </span>
    <span className="w-10 shrink-0 select-none px-1 text-right" style={{ color: "var(--mist)" }}>
      {line.newLineno ?? ""}
    </span>
    <span className="whitespace-pre px-2">
      {LINE_PREFIX[line.kind]}
      <SyntaxContent content={line.content} tokens={tokens} wordChanges={wordChanges} />
    </span>
  </>;
  if (!isChangedLine(line) || !interactive) {
    return (
      <div className="flex h-full min-w-full" style={{ background: LINE_BG[line.kind], color: LINE_COLOR[line.kind] }}>
        {content}
      </div>
    );
  }

  const lineNumber = line.oldLineno ?? line.newLineno ?? lineIndex + 1;
  const label = t(selected ? `diff.deselect.${line.kind}` : `diff.select.${line.kind}`, { line: lineNumber });
  return (
    <button
      type="button"
      data-diff-line={`${hunkIndex}:${lineIndex}`}
      aria-pressed={selected}
      aria-label={label}
      title={label}
      className="flex h-full min-w-full text-left outline-none focus-visible:ring-2 focus-visible:ring-inset"
      style={{
        background: selected
          ? `color-mix(in srgb, var(--fjord-tint) 55%, ${LINE_BG[line.kind]})`
          : LINE_BG[line.kind],
        color: LINE_COLOR[line.kind],
        boxShadow: selected ? "inset 3px 0 var(--fjord)" : undefined,
      }}
      onClick={(event) => onSelect(hunkIndex, lineIndex, event)}
      onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
        if (!event.shiftKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
        event.preventDefault();
        onExtendSelection(hunkIndex, lineIndex, event.key === "ArrowUp" ? -1 : 1);
      }}
    >
      {content}
    </button>
  );
}

function splitCellProps(
  side: "old" | "new",
  reference: DiffLineRef | null,
  hunkIndex: number,
  interactive: boolean,
  selectedLineIndices: Set<number> | null,
  highlightTokens: ReadonlyMap<string, HighlightToken[]>,
  wordChanges: ReadonlyMap<string, TextRange[]>,
  onSelect: (hunkIndex: number, lineIndex: number, event: MouseEvent<HTMLButtonElement>) => void,
  onExtendSelection: (hunkIndex: number, lineIndex: number, direction: -1 | 1) => void,
) {
  return {
    side,
    reference,
    hunkIndex,
    interactive,
    selected: reference ? selectedLineIndices?.has(reference.lineIndex) === true : false,
    tokens: reference ? highlightTokens.get(diffLineKey(hunkIndex, reference.lineIndex)) : undefined,
    wordChanges: reference ? wordChanges.get(diffLineKey(hunkIndex, reference.lineIndex)) : undefined,
    onSelect,
    onExtendSelection,
  } as const;
}

function SplitDiffCell({
  side,
  reference,
  hunkIndex,
  interactive,
  selected,
  tokens,
  wordChanges,
  onSelect,
  onExtendSelection,
}: {
  side: "old" | "new";
  reference: DiffLineRef | null;
  hunkIndex: number;
  interactive: boolean;
  selected: boolean;
  tokens?: HighlightToken[];
  wordChanges?: TextRange[];
  onSelect: (hunkIndex: number, lineIndex: number, event: MouseEvent<HTMLButtonElement>) => void;
  onExtendSelection: (hunkIndex: number, lineIndex: number, direction: -1 | 1) => void;
}) {
  const { t } = useTranslation("workspace");
  const line = reference?.line;
  const baseClass = "flex h-full min-w-full text-left";
  const style = {
    background: line ? LINE_BG[line.kind] : "var(--canvas)",
    color: line ? LINE_COLOR[line.kind] : "var(--mist)",
    boxShadow: selected ? "inset 3px 0 var(--fjord)" : undefined,
  };
  if (!line || !reference) {
    return <div aria-hidden="true" className={baseClass} style={style} />;
  }

  const content = <>
    <span className="w-10 shrink-0 select-none px-1 text-right" style={{ color: "var(--mist)" }}>
      {side === "old" ? line.oldLineno ?? "" : line.newLineno ?? ""}
    </span>
    <span className="whitespace-pre px-2">
      {LINE_PREFIX[line.kind]}
      <SyntaxContent content={line.content} tokens={tokens} wordChanges={wordChanges} />
    </span>
  </>;
  if (!isChangedLine(line) || !interactive) {
    return <div className={baseClass} style={style}>{content}</div>;
  }

  const lineNumber = line.oldLineno ?? line.newLineno ?? reference.lineIndex + 1;
  const label = t(selected ? `diff.deselect.${line.kind}` : `diff.select.${line.kind}`, { line: lineNumber });
  return (
    <button
      type="button"
      data-diff-line={`${hunkIndex}:${reference.lineIndex}`}
      aria-pressed={selected}
      aria-label={label}
      title={label}
      className={`${baseClass} outline-none focus-visible:ring-2 focus-visible:ring-inset`}
      style={{
        ...style,
        background: selected
          ? `color-mix(in srgb, var(--fjord-tint) 55%, ${LINE_BG[line.kind]})`
          : LINE_BG[line.kind],
      }}
      onClick={(event) => onSelect(hunkIndex, reference.lineIndex, event)}
      onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
        if (!event.shiftKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
        event.preventDefault();
        onExtendSelection(hunkIndex, reference.lineIndex, event.key === "ArrowUp" ? -1 : 1);
      }}
    >
      {content}
    </button>
  );
}

const TOKEN_COLOR: Record<HighlightTokenKind, string> = {
  keyword: "var(--fjord-ink)",
  literal: "var(--rust-ink)",
  number: "var(--amber)",
  string: "var(--moss-ink)",
  comment: "var(--mist)",
  type: "var(--amber)",
  tag: "var(--rust-ink)",
};

function SyntaxContent({
  content,
  tokens = [],
  wordChanges = [],
}: {
  content: string;
  tokens?: HighlightToken[];
  wordChanges?: TextRange[];
}) {
  if (tokens.length === 0 && wordChanges.length === 0) return content;
  const parts: ReactNode[] = [];
  const boundaries = new Set([0, content.length]);
  for (const range of [...tokens, ...wordChanges]) {
    boundaries.add(Math.max(0, Math.min(content.length, range.start)));
    boundaries.add(Math.max(0, Math.min(content.length, range.start + range.length)));
  }
  const points = [...boundaries].sort((left, right) => left - right);
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    if (end <= start) continue;
    const token = tokens.find((candidate) => candidate.start <= start && candidate.start + candidate.length >= end);
    const wordChange = wordChanges.some((candidate) => candidate.start <= start && candidate.start + candidate.length >= end);
    if (!token && !wordChange) {
      parts.push(content.slice(start, end));
      continue;
    }
    parts.push(
      <span
        key={`${start}:${end}`}
        data-syntax-token={token?.kind}
        data-word-change={wordChange || undefined}
        style={{
          color: token ? TOKEN_COLOR[token.kind] : undefined,
          background: wordChange ? "color-mix(in srgb, currentColor 16%, transparent)" : undefined,
          borderRadius: wordChange ? 2 : undefined,
        }}
      >
        {content.slice(start, end)}
      </span>,
    );
  }
  return parts;
}
