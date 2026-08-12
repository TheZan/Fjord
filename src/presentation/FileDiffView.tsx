import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useTranslation } from "react-i18next";
import { useFileDiff, type DiffSource } from "@/application/useFileDiff";
import { CHANGE_TYPE_COLOR } from "@/presentation/diffFormatting";
import { DestructivePreflightDialog } from "@/presentation/DestructivePreflightDialog";
import { Surface } from "@/presentation/ui";
import type { DestructiveAction, DiffLineKind, DiscardSelection, GenerationSet, PatchSelection } from "@/domain/git";
import type { DiffHunk, DiffLine } from "@/domain/git";

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
 * Full-detail diff for one file, meant to take over the center column when a
 * file is selected (see RepoDetailView) — GitKraken's diff view replaces the
 * commit graph rather than squeezing into a narrow side panel.
 */
export function FileDiffView({
  repoId,
  path,
  source,
  onBack,
  actionDisabled = false,
  snapshotInvalid = false,
  onApplyHunk,
  onDiscardPatch,
}: {
  repoId: string;
  path: string;
  source: DiffSource;
  onBack?: () => void;
  actionDisabled?: boolean;
  /** A rejected backend patch makes this rendered snapshot unsafe until refresh. */
  snapshotInvalid?: boolean;
  onApplyHunk?: (selection: PatchSelection, expectedGenerations: GenerationSet) => Promise<boolean>;
  onDiscardPatch?: (
    action: DestructiveAction,
    selection: PatchSelection,
    expectedGenerations: GenerationSet,
    confirmationToken: string,
  ) => Promise<boolean>;
}) {
  const { t } = useTranslation("workspace");
  const { diff, loading, loadingMore, hasMore, loadMore, error, generations } = useFileDiff(
    repoId,
    path,
    source,
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const [lineSelection, setLineSelection] = useState<LineSelection | null>(null);
  const [selectionPending, setSelectionPending] = useState(false);
  const [pendingDiscard, setPendingDiscard] = useState<PendingDiscard | null>(null);
  const rows = useMemo(() => flattenDiffRows(diff?.hunks ?? []), [diff?.hunks]);
  const actionsDisabled = actionDisabled || snapshotInvalid;
  const snapshotKey = `${repoId}\0${path}\0${diffSourceKey(source)}\0${diff?.baseDigest ?? ""}\0${generationKey(generations)}`;
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (rows[index].kind === "hunk" ? HUNK_HEADER_HEIGHT : DIFF_LINE_HEIGHT),
    overscan: 20,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const lastVisibleIndex = virtualRows.at(-1)?.index ?? -1;

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

  return <>
    <Surface className="flex h-full min-h-0 w-full flex-col text-sm" style={{ background: "var(--paper)" }}>
      <div
        className="flex items-center gap-3 border-b px-3 py-2"
        style={{ borderColor: "var(--hairline)" }}
      >
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="interactive-control shrink-0 rounded px-1.5 py-0.5 text-[11px]"
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
        {canDiscard && diff?.baseDigest && generations && diff.hunks.length > 0 ? (
          <button
            type="button"
            className="interactive-control rounded px-1.5 py-0.5 text-[11px] disabled:cursor-not-allowed disabled:opacity-60"
            style={{ color: "var(--rust-ink)" }}
            disabled={actionsDisabled || selectionPending || Boolean(pendingDiscard) || hasMore || loadingMore}
            title={hasMore || loadingMore ? t("diff.discardFileIncomplete") : undefined}
            onClick={() => requestDiscard(
              wholeFileSelection(path, diff.hunks, diff.baseDigest!),
              { kind: "file", path },
            )}
          >
            {t("diff.discardFile")}
          </button>
        ) : null}
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
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
          <p className="p-3 text-xs" style={{ color: "var(--slate)" }}>
            {t("diff.tooLarge", { size: formatFileBytes(diff.fileBytes) })}
          </p>
        )}
        {!loading && !error && diff && !diff.isBinary && !diff.tooLarge && diff.hunks.length === 0 && (
          <p className="p-3 text-xs" style={{ color: "var(--slate)" }}>
            {t("diff.empty")}
          </p>
        )}
        {diff && !diff.isBinary && !diff.tooLarge && rows.length > 0 && (
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
                      partialApplyUnsupported={source.kind === "working" && source.staged && diff.changeType === "deleted"}
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
                  ) : (
                    <DiffLineRow
                      line={row.line}
                      hunkIndex={row.hunkIndex}
                      lineIndex={row.lineIndex}
                      interactive={source.kind === "working" && !actionsDisabled && !selectionPending && !pendingDiscard}
                      selected={lineSelection?.hunkIndex === row.hunkIndex && lineSelection.lineIndices.has(row.lineIndex)}
                      onSelect={selectLine}
                      onExtendSelection={extendLineSelection}
                    />
                  )}
                </div>
              );
            })}
          </div>
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
        patchSelection={pendingDiscard.selection}
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

type FlatDiffRow =
  | { kind: "hunk"; key: string; hunk: DiffHunk; hunkIndex: number }
  | { kind: "line"; key: string; line: DiffLine; hunkIndex: number; lineIndex: number };

function flattenDiffRows(hunks: DiffHunk[]): FlatDiffRow[] {
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
  return source.kind === "commit" ? `commit:${source.commitId}` : `working:${source.staged}`;
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
        className="interactive-control ml-auto rounded px-1.5 py-0.5 text-[11px] disabled:cursor-not-allowed disabled:opacity-60"
        disabled={disabled || partialApplyUnsupported || selectedLineCount === 0 || !onApplySelected}
        title={partialApplyUnsupported ? t("diff.partialDeletedUnstageUnsupported") : undefined}
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
          className="interactive-control rounded px-1.5 py-0.5 text-[11px] disabled:cursor-not-allowed disabled:opacity-60"
          style={{ color: "var(--rust-ink)" }}
          disabled={disabled || selectedLineCount === 0}
          aria-label={t("diff.discardSelectedLines")}
          onClick={onDiscardSelected}
        >
          {t("diff.discardSelectedLines")}
        </button>
      ) : null}
      <button
        type="button"
        className="interactive-control rounded px-1.5 py-0.5 text-[11px] disabled:cursor-not-allowed disabled:opacity-60"
        disabled={disabled || partialApplyUnsupported || pending || !onApply}
        title={partialApplyUnsupported ? t("diff.partialDeletedUnstageUnsupported") : undefined}
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
          className="interactive-control rounded px-1.5 py-0.5 text-[11px] disabled:cursor-not-allowed disabled:opacity-60"
          style={{ color: "var(--rust-ink)" }}
          disabled={disabled}
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
  onSelect,
  onExtendSelection,
}: {
  line: DiffLine;
  hunkIndex: number;
  lineIndex: number;
  interactive: boolean;
  selected: boolean;
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
      {line.content}
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
