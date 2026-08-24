import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, MouseEvent, ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useTranslation } from "react-i18next";
import { buildFileTree, splitPath, type FileTreeNode } from "@/presentation/fileTree";

export type FileViewMode = "path" | "tree";
export interface FileContextMenuAnchor { x: number; y: number }
export interface FileSelectionIntent {
  toggle: boolean;
  range: boolean;
  /** Keyboard toggle keeps the stable Shift-range origin. */
  preserveAnchor?: boolean;
}

/**
 * Which directory rows are folded. Owned by the panel rather than by the list
 * so that one "collapse all" governs every list in it — the commit panel
 * renders two (staged and unstaged) under a single set of controls.
 */
export interface FileTreeCollapse {
  collapsed: Set<string>;
  toggle: (path: string) => void;
  collapseAll: () => void;
  expandAll: () => void;
  /** False when nothing is nested, so the controls can hide instead of no-op. */
  hasDirectories: boolean;
  allCollapsed: boolean;
}

/** `directoryPaths` is every directory row across all lists sharing this state. */
export function useFileTreeCollapse(directoryPaths: string[]): FileTreeCollapse {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggle = useCallback((path: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const collapseAll = useCallback(() => setCollapsed(new Set(directoryPaths)), [directoryPaths]);
  const expandAll = useCallback(() => setCollapsed(new Set()), []);

  return {
    collapsed,
    toggle,
    collapseAll,
    expandAll,
    hasDirectories: directoryPaths.length > 0,
    allCollapsed: directoryPaths.length > 0 && directoryPaths.every((path) => collapsed.has(path)),
  };
}

/** Collapse-all / expand-all pair, shown only alongside the tree view. */
export function FileTreeControls({ collapse }: { collapse: FileTreeCollapse }) {
  const { t } = useTranslation("workspace");
  if (!collapse.hasDirectories) return null;

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <IconButton
        label={t("fileView.collapseAll")}
        disabled={collapse.allCollapsed}
        onClick={collapse.collapseAll}
      >
        <path d="m7 4 5 5 5-5" />
        <path d="m7 20 5-5 5 5" />
      </IconButton>
      <IconButton
        label={t("fileView.expandAll")}
        disabled={collapse.collapsed.size === 0}
        onClick={collapse.expandAll}
      >
        <path d="m7 9 5-5 5 5" />
        <path d="m7 15 5 5 5-5" />
      </IconButton>
    </div>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="interactive-control flex h-6 w-6 items-center justify-center rounded disabled:opacity-30"
      style={{ color: "var(--slate)" }}
    >
      <svg
        width={13}
        height={13}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {children}
      </svg>
    </button>
  );
}

/** Segmented Path/Tree switch sitting over the file list. */
export function FileViewTabs({
  mode,
  onChange,
}: {
  mode: FileViewMode;
  onChange: (mode: FileViewMode) => void;
}) {
  const { t } = useTranslation("workspace");

  return (
    <div
      className="inline-flex shrink-0 rounded-md border p-0.5"
      style={{ borderWidth: "0.5px", borderColor: "var(--hairline)" }}
    >
      {(["path", "tree"] as const).map((value) => (
        <button
          key={value}
          type="button"
          onClick={() => onChange(value)}
          data-selected={mode === value}
          className="interactive-control rounded px-2 py-0.5 text-[11px] font-medium"
          style={{
            color: mode === value ? "var(--fjord-ink)" : "var(--slate)",
          }}
        >
          {t(`fileView.${value}`)}
        </button>
      ))}
    </div>
  );
}

interface FileEntryListProps<T extends { path: string }> {
  files: T[];
  mode: FileViewMode;
  collapse: FileTreeCollapse;
  selectedPaths: ReadonlySet<string>;
  activePath: string | null;
  onSelect: (file: T, intent: FileSelectionIntent, visibleFiles: readonly T[]) => void;
  onActivate?: (file: T) => void;
  onSelectAll?: (visibleFiles: readonly T[], focusedFile: T) => void;
  onVisibleFilesChange?: (visibleFiles: readonly T[]) => void;
  /** The single-letter A/M/D/R change mark. */
  renderMark: (file: T) => ReactNode;
  /** Right-aligned extra, e.g. `+3 -1` or a stage button. */
  renderTrailing?: (file: T) => ReactNode;
  onFileContextMenu?: (file: T, anchor: FileContextMenuAnchor) => void;
  ariaLabel?: string;
  multiselectable?: boolean;
  /** Occupy the parent's remaining height instead of using a capped list. */
  fill?: boolean;
}

const FILE_ROW_HEIGHT = 29;
const MAX_CAPPED_LIST_HEIGHT = FILE_ROW_HEIGHT * 11;

/**
 * One file list, rendered either flat ("path") or nested ("tree"). Both modes
 * show the *basename* as the label — a full repository path in a 24rem panel
 * truncated to uselessness, which is why the directory is demoted to a dimmed
 * prefix in path mode and to the enclosing row in tree mode.
 */
export function FileEntryList<T extends { path: string }>({
  files,
  mode,
  collapse,
  selectedPaths,
  activePath,
  onSelect,
  onActivate,
  onSelectAll,
  onVisibleFilesChange,
  renderMark,
  renderTrailing,
  onFileContextMenu,
  ariaLabel,
  multiselectable = false,
  fill = false,
}: FileEntryListProps<T>) {
  const tree = useMemo(() => (mode === "tree" ? buildFileTree(files) : []), [files, mode]);
  const entries = useMemo(
    () =>
      mode === "path"
        ? files.map((file) => {
            const { dir, name } = splitPath(file.path);
            return { kind: "file" as const, file, label: name, prefix: dir, depth: 0 };
          })
        : flattenVisibleTree(tree, collapse.collapsed),
    [collapse.collapsed, files, mode, tree],
  );
  const visibleFiles = useMemo(
    () => entries.flatMap((entry) => entry.kind === "file" ? [entry.file] : []),
    [entries],
  );
  const visiblePathSet = useMemo(
    () => new Set(visibleFiles.map((file) => file.path)),
    [visibleFiles],
  );
  const focusablePath = activePath !== null && visiblePathSet.has(activePath)
    ? activePath
    : visibleFiles[0]?.path ?? null;
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocusPath = useRef<string | null>(null);
  const onVisibleFilesChangeRef = useRef(onVisibleFilesChange);
  onVisibleFilesChangeRef.current = onVisibleFilesChange;
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => FILE_ROW_HEIGHT,
    overscan: 8,
  });

  useEffect(() => {
    onVisibleFilesChangeRef.current?.(visibleFiles);
  }, [visibleFiles]);

  useEffect(() => {
    if (!activePath || pendingFocusPath.current !== activePath) return;
    const row = rowRefs.current.get(activePath);
    if (row) {
      row.focus();
      pendingFocusPath.current = null;
    }
  }, [activePath, entries]);

  function selectAndFocus(file: T, intent: FileSelectionIntent) {
    const index = entries.findIndex(
      (entry) => entry.kind === "file" && entry.file.path === file.path,
    );
    if (index >= 0) rowVirtualizer.scrollToIndex?.(index);
    pendingFocusPath.current = file.path;
    onSelect(file, intent, visibleFiles);
  }

  return (
    <div
      ref={scrollRef}
      className={`min-h-0 min-w-0 overflow-x-hidden overflow-y-auto ${fill ? "h-full" : ""}`}
      style={fill ? undefined : { height: Math.min(entries.length * FILE_ROW_HEIGHT, MAX_CAPPED_LIST_HEIGHT) }}
      onKeyDown={(event) => {
        if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "a") {
          return;
        }
        const focused = visibleFiles.find((file) => file.path === activePath) ?? visibleFiles[0];
        if (!focused || !onSelectAll) return;
        event.preventDefault();
        onSelectAll(visibleFiles, focused);
      }}
    >
      <ul
        role="listbox"
        aria-label={ariaLabel}
        aria-multiselectable={multiselectable || undefined}
        className="relative min-w-0 w-full overflow-hidden"
        style={{ height: rowVirtualizer.getTotalSize() }}
      >
        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
          const entry = entries[virtualRow.index];
          const rowStyle: CSSProperties = {
            height: virtualRow.size,
            left: 0,
            position: "absolute",
            top: 0,
            transform: `translateY(${virtualRow.start}px)`,
            width: "100%",
          };
          return entry.kind === "file" ? (
            <FileRow
              key={entry.file.path}
              file={entry.file}
              label={entry.label}
              prefix={entry.prefix}
              depth={entry.depth}
              selected={selectedPaths.has(entry.file.path)}
              active={entry.file.path === activePath}
              focusable={entry.file.path === focusablePath}
              registerRef={(element) => {
                if (element) {
                  rowRefs.current.set(entry.file.path, element);
                  if (pendingFocusPath.current === entry.file.path) {
                    element.focus();
                    pendingFocusPath.current = null;
                  }
                } else rowRefs.current.delete(entry.file.path);
              }}
              onActivate={onActivate}
              onSelect={(file, intent) => onSelect(file, intent, visibleFiles)}
              onMove={(file, direction, range) => {
                const currentIndex = visibleFiles.findIndex((candidate) => candidate.path === file.path);
                const next = visibleFiles[currentIndex + direction];
                if (next) selectAndFocus(next, { toggle: false, range });
              }}
              renderMark={renderMark}
              renderTrailing={renderTrailing}
              onFileContextMenu={onFileContextMenu}
              style={rowStyle}
            />
          ) : (
            <DirectoryRow
              key={entry.node.path}
              node={entry.node}
              depth={entry.depth}
              collapsed={collapse.collapsed.has(entry.node.path)}
              onToggle={collapse.toggle}
              style={rowStyle}
            />
          );
        })}
      </ul>
    </div>
  );
}

function DirectoryRow<T extends { path: string }>({
  node,
  depth,
  collapsed,
  onToggle,
  style,
}: {
  node: Extract<FileTreeNode<T>, { kind: "dir" }>;
  depth: number;
  collapsed: boolean;
  onToggle: (path: string) => void;
  style: CSSProperties;
}) {
  return (
    <li className="min-w-0 overflow-hidden" style={style}>
      <button
        type="button"
        onClick={() => onToggle(node.path)}
        className="interactive-row flex h-7 min-w-0 w-full items-center gap-1 overflow-hidden rounded px-2 text-left"
        style={{ paddingLeft: `${0.5 + depth * 0.75}rem`, color: "var(--slate)" }}
      >
        <span className="w-3 shrink-0 text-center text-[10px]">{collapsed ? "▸" : "▾"}</span>
        <span className="min-w-0 truncate font-mono text-xs">{node.name}</span>
      </button>
    </li>
  );
}

function FileRow<T extends { path: string }>({
  file,
  label,
  prefix,
  depth,
  selected,
  active,
  focusable,
  registerRef,
  onActivate,
  onSelect,
  onMove,
  renderMark,
  renderTrailing,
  onFileContextMenu,
  style,
}: {
  file: T;
  label: string;
  prefix?: string;
  depth: number;
  selected: boolean;
  active: boolean;
  focusable: boolean;
  registerRef: (element: HTMLButtonElement | null) => void;
  onActivate?: (file: T) => void;
  onSelect: (file: T, intent: FileSelectionIntent) => void;
  onMove: (file: T, direction: -1 | 1, range: boolean) => void;
  renderMark: (file: T) => ReactNode;
  renderTrailing?: (file: T) => ReactNode;
  onFileContextMenu?: (file: T, anchor: FileContextMenuAnchor) => void;
  style: CSSProperties;
}) {
  return (
    <li role="presentation" className="group min-w-0 overflow-hidden" style={style}>
      <button
        ref={registerRef}
        type="button"
        role="option"
        aria-selected={selected}
        tabIndex={focusable ? 0 : -1}
        onFocus={() => {
          if (!active) onActivate?.(file);
        }}
        onClick={(event) => onSelect(file, selectionIntent(event))}
        onContextMenu={(event) => {
          if (!onFileContextMenu) return;
          event.preventDefault();
          event.currentTarget.focus();
          onFileContextMenu(file, { x: event.clientX, y: event.clientY });
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            onMove(file, event.key === "ArrowDown" ? 1 : -1, event.shiftKey);
            return;
          }
          if ((event.ctrlKey || event.metaKey) && event.key === " ") {
            event.preventDefault();
            onSelect(file, { toggle: true, range: false, preserveAnchor: true });
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            onSelect(file, { toggle: false, range: false });
            return;
          }
          if (!onFileContextMenu) return;
          if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
          event.preventDefault();
          const bounds = event.currentTarget.getBoundingClientRect();
          onFileContextMenu(file, { x: bounds.left + 12, y: bounds.bottom + 2 });
        }}
        title={file.path}
        data-selected={selected}
        className="interactive-row flex h-7 min-w-0 w-full items-center gap-2 overflow-hidden rounded pr-2 text-left"
        style={{
          paddingLeft: `${0.5 + depth * 0.75}rem`,
          color: selected ? "var(--fjord-ink)" : "var(--ink)",
        }}
      >
        <span className="w-4 shrink-0 text-center font-mono text-xs font-semibold">
          {renderMark(file)}
        </span>
        <span className="flex min-w-0 flex-1 items-baseline gap-1 overflow-hidden">
          {prefix ? (
            // Prefer the basename, but allow both segments to ellipsize so a
            // generated filename can never widen the inspector.
            <span
              className="min-w-0 max-w-[45%] shrink truncate font-mono text-[11px]"
              style={{ color: "var(--mist)" }}
            >
              {prefix}
            </span>
          ) : null}
          <span className="min-w-0 flex-1 truncate font-mono text-xs">{label}</span>
        </span>
        {renderTrailing?.(file)}
      </button>
    </li>
  );
}

function selectionIntent(
  event: Pick<MouseEvent<HTMLButtonElement> | KeyboardEvent<HTMLButtonElement>, "ctrlKey" | "metaKey" | "shiftKey">,
): FileSelectionIntent {
  return { toggle: event.ctrlKey || event.metaKey, range: event.shiftKey };
}

type FlatFileEntry<T extends { path: string }> =
  | { kind: "file"; file: T; label: string; prefix?: string; depth: number }
  | { kind: "dir"; node: Extract<FileTreeNode<T>, { kind: "dir" }>; depth: number };

function flattenVisibleTree<T extends { path: string }>(
  nodes: FileTreeNode<T>[],
  collapsed: Set<string>,
  depth = 0,
): FlatFileEntry<T>[] {
  const entries: FlatFileEntry<T>[] = [];
  for (const node of nodes) {
    if (node.kind === "file") {
      entries.push({ kind: "file", file: node.item, label: node.name, depth });
      continue;
    }
    entries.push({ kind: "dir", node, depth });
    if (!collapsed.has(node.path)) {
      entries.push(...flattenVisibleTree(node.children, collapsed, depth + 1));
    }
  }
  return entries;
}
