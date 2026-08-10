import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { GroupLabel, Input, TYPOGRAPHY } from "@/presentation/ui";
import type { RepoStatusSummary, RepositoryEntry, Workspace } from "@/domain/workspace";
import type { View } from "@/presentation/view";

interface SidebarProps {
  view: View;
  onViewChange: (view: View) => void;
  workspaces: Workspace[];
  repositoriesByWorkspace: Record<string, RepositoryEntry[]>;
  statusByRepo: Record<string, RepoStatusSummary>;
  repoCountByWorkspace: Record<string, number>;
  attentionByWorkspace: Record<string, number>;
  selectedWorkspaceId: string | null;
  selectedRepoId: string | null;
  onSelectWorkspace: (id: string) => void;
  onSelectRepository: (workspaceId: string, repoId: string) => void;
  onWarmRepository: (repoId: string) => void;
  onCreateWorkspace: (name: string) => void;
  onRenameWorkspace: (id: string, name: string) => void;
  onDeleteWorkspace: (id: string) => void;
  onMoveWorkspace: (id: string, direction: -1 | 1) => void;
  onMoveWorkspaceTo: (id: string, targetId: string) => void;
  pending: string | null;
}

export function Sidebar({
  view,
  onViewChange,
  workspaces,
  repositoriesByWorkspace,
  statusByRepo,
  repoCountByWorkspace,
  attentionByWorkspace,
  selectedWorkspaceId,
  selectedRepoId,
  onSelectWorkspace,
  onSelectRepository,
  onWarmRepository,
  onCreateWorkspace,
  onRenameWorkspace,
  onDeleteWorkspace,
  onMoveWorkspace,
  onMoveWorkspaceTo,
  pending,
}: SidebarProps) {
  const { t: tw } = useTranslation("workspace");
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [menuId, setMenuId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [draggedWorkspaceId, setDraggedWorkspaceId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedWorkspaceId) return;
    setExpandedIds((current) => {
      if (current.has(selectedWorkspaceId)) return current;
      const next = new Set(current);
      next.add(selectedWorkspaceId);
      return next;
    });
  }, [selectedWorkspaceId]);

  useEffect(() => {
    setExpandedIds((current) => {
      const existing = new Set(workspaces.map((workspace) => workspace.id));
      const next = new Set([...current].filter((id) => existing.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [workspaces]);

  function submitNew() {
    if (!newName.trim()) {
      setAdding(false);
      return;
    }
    onCreateWorkspace(newName);
    setNewName("");
    setAdding(false);
  }

  function submitRename(id: string) {
    if (editingName.trim()) onRenameWorkspace(id, editingName);
    setEditingId(null);
  }

  function toggleExpanded(id: string) {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <aside
      className="flex w-60 shrink-0 flex-col border-r"
      style={{ borderRightWidth: "0.5px", borderColor: "var(--hairline)", background: "var(--sidebar-bg)" }}
    >
      <nav className="flex flex-col gap-0.5 px-2 pt-3">
        <NavItem active={view === "overview"} onClick={() => onViewChange("overview")}>
          {tw("nav.overview")}
        </NavItem>
        <NavItem active={view === "repositories"} onClick={() => onViewChange("repositories")}>
          {tw("nav.allRepositories")}
        </NavItem>
      </nav>

      <div className="mt-5 flex items-center justify-between px-4 pb-1.5">
        <GroupLabel>{tw("workspaces.label")}</GroupLabel>
        <button
          type="button"
          onClick={() => setAdding((value) => !value)}
          className="interactive-control flex h-4 w-4 items-center justify-center rounded text-sm leading-none"
          style={{ color: "var(--mist)" }}
          aria-label={tw("workspaces.createButton")}
        >
          +
        </button>
      </div>

      {adding && (
        <div className="px-2 pb-1.5">
          <Input
            autoFocus
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            onBlur={submitNew}
            onKeyDown={(event) => {
              if (event.key === "Enter") submitNew();
              if (event.key === "Escape") setAdding(false);
            }}
            placeholder={tw("workspaces.createPlaceholder")}
            className="w-full"
          />
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2">
        {workspaces.map((workspace) => {
          const isSelected = workspace.id === selectedWorkspaceId;
          const attention = attentionByWorkspace[workspace.id] ?? 0;
          const repos = repositoriesByWorkspace[workspace.id] ?? [];
          const expanded = expandedIds.has(workspace.id);
          const dragging = draggedWorkspaceId === workspace.id;
          const dropTarget = dropTargetId === workspace.id && draggedWorkspaceId !== workspace.id;

          if (editingId === workspace.id) {
            return (
              <Input
                key={workspace.id}
                autoFocus
                value={editingName}
                onChange={(event) => setEditingName(event.target.value)}
                onBlur={() => submitRename(workspace.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") submitRename(workspace.id);
                  if (event.key === "Escape") setEditingId(null);
                }}
                className="w-full"
              />
            );
          }

          return (
            <div
              key={workspace.id}
              draggable={pending === null}
              onDragStart={(event) => {
                setDraggedWorkspaceId(workspace.id);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", workspace.id);
              }}
              onDragOver={(event) => {
                if (!draggedWorkspaceId || draggedWorkspaceId === workspace.id) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setDropTargetId(workspace.id);
              }}
              onDragLeave={() => {
                setDropTargetId((current) => (current === workspace.id ? null : current));
              }}
              onDrop={(event) => {
                event.preventDefault();
                const draggedId = draggedWorkspaceId ?? event.dataTransfer.getData("text/plain");
                setDraggedWorkspaceId(null);
                setDropTargetId(null);
                if (draggedId && draggedId !== workspace.id) onMoveWorkspaceTo(draggedId, workspace.id);
              }}
              onDragEnd={() => {
                setDraggedWorkspaceId(null);
                setDropTargetId(null);
              }}
              className="group relative rounded-md"
              style={{
                opacity: dragging ? 0.55 : 1,
                outline: dropTarget ? "1px solid var(--fjord)" : "none",
                outlineOffset: dropTarget ? "2px" : 0,
              }}
            >
              <div
                data-selected={isSelected}
                className={`interactive-row flex w-full cursor-grab items-center gap-1 rounded-md px-1.5 py-1.5 text-left active:cursor-grabbing ${TYPOGRAPHY.body}`}
                style={{
                  color: isSelected ? "var(--fjord-ink)" : "var(--ink)",
                }}
              >
                <span className="flex h-5 w-3 shrink-0 items-center justify-center" style={{ color: "var(--mist)" }}>
                  <DragHandleIcon />
                </span>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleExpanded(workspace.id);
                  }}
                  className="interactive-control flex h-5 w-5 shrink-0 items-center justify-center rounded"
                  style={{ color: "var(--mist)" }}
                  aria-label={expanded ? tw("workspaces.collapse") : tw("workspaces.expand")}
                  title={expanded ? tw("workspaces.collapse") : tw("workspaces.expand")}
                >
                  <ChevronIcon open={expanded} />
                </button>
                <button
                  type="button"
                  onClick={() => onSelectWorkspace(workspace.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: attention > 0 ? "var(--amber)" : "var(--moss)" }}
                />
                <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
                <span
                  className="shrink-0 text-[11px] tabular-nums group-hover:opacity-0"
                  style={{ color: "var(--mist)" }}
                >
                  {repoCountByWorkspace[workspace.id] ?? 0}
                </span>
                </button>
              </div>

              <button
                type="button"
                onClick={() => setMenuId(menuId === workspace.id ? null : workspace.id)}
                className="interactive-control absolute right-1.5 top-1/2 hidden -translate-y-1/2 rounded px-1 text-xs leading-none group-hover:block"
                style={{ color: "var(--slate)" }}
                aria-label={tw("workspaces.rename")}
              >
                •••
              </button>

              {menuId === workspace.id && (
                <div
                  className="desktop-popover absolute right-1 top-full z-20 mt-0.5 flex w-36 flex-col rounded-md border py-1"
                  style={{
                    borderWidth: "0.5px",
                    borderColor: "var(--hairline-strong)",
                    background: "var(--paper)",
                  }}
                >
                  <MenuItem
                    onClick={() => {
                      setEditingId(workspace.id);
                      setEditingName(workspace.name);
                      setMenuId(null);
                    }}
                  >
                    {tw("workspaces.rename")}
                  </MenuItem>
                  <MenuItem
                    disabled={pending !== null}
                    onClick={() => {
                      onMoveWorkspace(workspace.id, -1);
                      setMenuId(null);
                    }}
                  >
                    {tw("workspaces.moveUp")}
                  </MenuItem>
                  <MenuItem
                    disabled={pending !== null}
                    onClick={() => {
                      onMoveWorkspace(workspace.id, 1);
                      setMenuId(null);
                    }}
                  >
                    {tw("workspaces.moveDown")}
                  </MenuItem>
                  <MenuItem
                    danger
                    disabled={pending !== null}
                    onClick={() => {
                      onDeleteWorkspace(workspace.id);
                      setMenuId(null);
                    }}
                  >
                    {tw("workspaces.delete")}
                  </MenuItem>
                </div>
              )}

              {expanded && (
                <div className="flex flex-col gap-0.5 pb-1 pl-7 pr-1 pt-1">
                  {repos.length === 0 ? (
                    <span className="truncate px-2 py-1 text-[11px]" style={{ color: "var(--mist)" }}>
                      {tw("workspaces.noRepositories")}
                    </span>
                  ) : (
                    repos.map((repo) => (
                      <RepositoryItem
                        key={repo.id}
                        repo={repo}
                        status={statusByRepo[repo.id]?.status}
                        selected={repo.id === selectedRepoId}
                        onSelect={() => onSelectRepository(workspace.id, repo.id)}
                        onWarm={() => onWarmRepository(repo.id)}
                      />
                    ))
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

    </aside>
  );
}

function RepositoryItem({
  repo,
  status,
  selected,
  onSelect,
  onWarm,
}: {
  repo: RepositoryEntry;
  status: RepoStatusSummary["status"] | undefined;
  selected: boolean;
  onSelect: () => void;
  onWarm: () => void;
}) {
  const { t } = useTranslation("workspace");
  const dirty = status?.dirtyCount ?? 0;
  const ahead = status?.ahead ?? 0;
  const behind = status?.behind ?? 0;
  const tone = status?.hasConflict
    ? "var(--rust)"
    : dirty > 0
      ? "var(--amber)"
      : ahead > 0 || behind > 0
        ? "var(--fjord)"
        : "var(--moss)";

  return (
    <button
      type="button"
      onClick={onSelect}
      onPointerEnter={onWarm}
      onFocus={onWarm}
      data-selected={selected}
      className="interactive-row grid w-full grid-cols-[0.5rem_minmax(0,1fr)] items-center gap-x-2 rounded-md px-2 py-1 text-left"
      title={repo.path}
      style={{
        color: selected ? "var(--fjord-ink)" : "var(--slate)",
      }}
    >
      <span className="row-span-2 h-1.5 w-1.5 rounded-full" style={{ background: tone }} />
      <span className={`min-w-0 truncate font-medium ${TYPOGRAPHY.body}`}>{repo.name}</span>
      <span className={`min-w-0 truncate ${TYPOGRAPHY.caption}`} style={{ color: "var(--mist)" }}>
        {status?.branch ?? repo.path}
        {(dirty > 0 || ahead > 0 || behind > 0) && (
          <span className="ml-1.5 inline-flex gap-1 tabular-nums">
            {dirty > 0 && (
              <span style={{ color: "var(--amber-ink)" }}>
                {t("cardStatus.changes", { count: dirty })}
              </span>
            )}
            {ahead > 0 && <span>↑{ahead}</span>}
            {behind > 0 && <span>↓{behind}</span>}
          </span>
        )}
      </span>
    </button>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 12 12" className="h-3 w-3" aria-hidden="true">
      <path
        d={open ? "M3 4.5 6 7.5 9 4.5" : "M4.5 3 7.5 6 4.5 9"}
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </svg>
  );
}

function DragHandleIcon() {
  return (
    <svg viewBox="0 0 8 14" className="h-3.5 w-2" aria-hidden="true">
      <circle cx="2" cy="3" r="0.8" fill="currentColor" />
      <circle cx="6" cy="3" r="0.8" fill="currentColor" />
      <circle cx="2" cy="7" r="0.8" fill="currentColor" />
      <circle cx="6" cy="7" r="0.8" fill="currentColor" />
      <circle cx="2" cy="11" r="0.8" fill="currentColor" />
      <circle cx="6" cy="11" r="0.8" fill="currentColor" />
    </svg>
  );
}

function NavItem({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-selected={active}
      className={`interactive-row rounded-md px-2 py-1.5 text-left ${TYPOGRAPHY.body}`}
      style={{
        color: active ? "var(--fjord-ink)" : "var(--slate)",
        fontWeight: active ? 500 : 400,
      }}
    >
      {children}
    </button>
  );
}

function MenuItem({
  children,
  onClick,
  danger = false,
  disabled = false,
}: {
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="interactive-row px-2.5 py-1 text-left text-xs disabled:opacity-45"
      style={{ color: danger ? "var(--rust-ink)" : "var(--ink)" }}
    >
      {children}
    </button>
  );
}
