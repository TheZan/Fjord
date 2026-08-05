import { useCallback, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { buildFileTree, splitPath, type FileTreeNode } from "@/presentation/fileTree";

export type FileViewMode = "path" | "tree";

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
      className="flex h-6 w-6 items-center justify-center rounded disabled:opacity-30"
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

/** Segmented Path/Tree switch, matching the pair GitKraken puts over its file list. */
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
          className="rounded px-2 py-0.5 text-[11px] font-medium"
          style={{
            background: mode === value ? "var(--fjord-tint)" : "transparent",
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
  selectedPath: string | null;
  onSelect: (file: T) => void;
  /** The single-letter A/M/D/R change mark. */
  renderMark: (file: T) => ReactNode;
  /** Right-aligned extra, e.g. `+3 -1` or a stage button. */
  renderTrailing?: (file: T) => ReactNode;
}

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
  selectedPath,
  onSelect,
  renderMark,
  renderTrailing,
}: FileEntryListProps<T>) {
  const tree = useMemo(() => (mode === "tree" ? buildFileTree(files) : []), [files, mode]);

  if (mode === "path") {
    return (
      <ul className="flex flex-col gap-0.5">
        {files.map((file) => {
          const { dir, name } = splitPath(file.path);
          return (
            <FileRow
              key={file.path}
              file={file}
              label={name}
              prefix={dir}
              depth={0}
              selected={file.path === selectedPath}
              onSelect={onSelect}
              renderMark={renderMark}
              renderTrailing={renderTrailing}
            />
          );
        })}
      </ul>
    );
  }

  return (
    <ul className="flex flex-col gap-0.5">
      {tree.map((node) => (
        <TreeNodeRow
          key={node.path}
          node={node}
          depth={0}
          collapsed={collapse.collapsed}
          onToggle={collapse.toggle}
          selectedPath={selectedPath}
          onSelect={onSelect}
          renderMark={renderMark}
          renderTrailing={renderTrailing}
        />
      ))}
    </ul>
  );
}

function TreeNodeRow<T extends { path: string }>({
  node,
  depth,
  collapsed,
  onToggle,
  selectedPath,
  onSelect,
  renderMark,
  renderTrailing,
}: {
  node: FileTreeNode<T>;
  depth: number;
  collapsed: Set<string>;
  onToggle: (path: string) => void;
  selectedPath: string | null;
  onSelect: (file: T) => void;
  renderMark: (file: T) => ReactNode;
  renderTrailing?: (file: T) => ReactNode;
}) {
  if (node.kind === "file") {
    return (
      <FileRow
        file={node.item}
        label={node.name}
        depth={depth}
        selected={node.path === selectedPath}
        onSelect={onSelect}
        renderMark={renderMark}
        renderTrailing={renderTrailing}
      />
    );
  }

  const isCollapsed = collapsed.has(node.path);

  return (
    <li>
      <button
        type="button"
        onClick={() => onToggle(node.path)}
        className="flex w-full items-center gap-1 rounded px-2 py-1 text-left"
        style={{ paddingLeft: `${0.5 + depth * 0.75}rem`, color: "var(--slate)" }}
      >
        <span className="w-3 shrink-0 text-center text-[10px]">{isCollapsed ? "▸" : "▾"}</span>
        <span className="min-w-0 truncate font-mono text-xs">{node.name}</span>
      </button>

      {!isCollapsed && (
        <ul className="flex flex-col gap-0.5">
          {node.children.map((child) => (
            <TreeNodeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              collapsed={collapsed}
              onToggle={onToggle}
              selectedPath={selectedPath}
              onSelect={onSelect}
              renderMark={renderMark}
              renderTrailing={renderTrailing}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function FileRow<T extends { path: string }>({
  file,
  label,
  prefix,
  depth,
  selected,
  onSelect,
  renderMark,
  renderTrailing,
}: {
  file: T;
  label: string;
  prefix?: string;
  depth: number;
  selected: boolean;
  onSelect: (file: T) => void;
  renderMark: (file: T) => ReactNode;
  renderTrailing?: (file: T) => ReactNode;
}) {
  return (
    <li className="group relative">
      <button
        type="button"
        onClick={() => onSelect(file)}
        title={file.path}
        className="flex w-full items-center gap-2 rounded py-1 pr-2 text-left"
        style={{
          paddingLeft: `${0.5 + depth * 0.75}rem`,
          background: selected ? "var(--fjord-tint)" : "transparent",
          color: selected ? "var(--fjord-ink)" : "var(--ink)",
        }}
      >
        <span className="w-4 shrink-0 text-center font-mono text-xs font-semibold">
          {renderMark(file)}
        </span>
        <span className="flex min-w-0 flex-1 items-baseline gap-1">
          {prefix ? (
            // The directory is the part allowed to shrink and ellipsize, so
            // the file name stays fully readable however deep the path is.
            <span
              className="min-w-0 shrink truncate font-mono text-[11px]"
              style={{ color: "var(--mist)" }}
            >
              {prefix}
            </span>
          ) : null}
          <span className="shrink-0 truncate font-mono text-xs">{label}</span>
        </span>
        {renderTrailing?.(file)}
      </button>
    </li>
  );
}
