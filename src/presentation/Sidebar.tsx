import { useState } from "react";
import { useTranslation } from "react-i18next";
import { FjordMark } from "@/presentation/FjordMark";
import { Button, GroupLabel, Input } from "@/presentation/ui";
import type { Workspace } from "@/domain/workspace";
import type { View } from "@/presentation/view";

interface SidebarProps {
  view: View;
  onViewChange: (view: View) => void;
  workspaces: Workspace[];
  repoCountByWorkspace: Record<string, number>;
  attentionByWorkspace: Record<string, number>;
  selectedWorkspaceId: string | null;
  onSelectWorkspace: (id: string) => void;
  onCreateWorkspace: (name: string) => void;
  onRenameWorkspace: (id: string, name: string) => void;
  onDeleteWorkspace: (id: string) => void;
  onMoveWorkspace: (id: string, direction: -1 | 1) => void;
  pending: string | null;
  onOpenSettings: () => void;
}

export function Sidebar({
  view,
  onViewChange,
  workspaces,
  repoCountByWorkspace,
  attentionByWorkspace,
  selectedWorkspaceId,
  onSelectWorkspace,
  onCreateWorkspace,
  onRenameWorkspace,
  onDeleteWorkspace,
  onMoveWorkspace,
  pending,
  onOpenSettings,
}: SidebarProps) {
  const { t } = useTranslation();
  const { t: tw } = useTranslation("workspace");
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [menuId, setMenuId] = useState<string | null>(null);

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

  return (
    <aside
      className="flex w-60 shrink-0 flex-col border-r"
      style={{ borderRightWidth: "0.5px", borderColor: "var(--hairline)", background: "var(--paper)" }}
    >
      <div className="flex items-center gap-2 px-4 pb-3 pt-4">
        <FjordMark size={18} style={{ color: "var(--brand)" }} />
        <span className="text-[15px] font-medium">{t("app.title")}</span>
      </div>

      <nav className="flex flex-col gap-0.5 px-2">
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
          className="flex h-4 w-4 items-center justify-center rounded text-sm leading-none"
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
            <div key={workspace.id} className="group relative">
              <button
                type="button"
                onClick={() => onSelectWorkspace(workspace.id)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px]"
                style={{
                  background: isSelected ? "var(--fjord-tint)" : "transparent",
                  color: isSelected ? "var(--fjord-ink)" : "var(--ink)",
                }}
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

              <button
                type="button"
                onClick={() => setMenuId(menuId === workspace.id ? null : workspace.id)}
                className="absolute right-1.5 top-1/2 hidden -translate-y-1/2 rounded px-1 text-xs leading-none group-hover:block"
                style={{ color: "var(--slate)" }}
                aria-label={tw("workspaces.rename")}
              >
                •••
              </button>

              {menuId === workspace.id && (
                <div
                  className="absolute right-1 top-full z-20 mt-0.5 flex w-36 flex-col rounded-lg border py-1 shadow-lg"
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
            </div>
          );
        })}
      </div>

      <div
        className="border-t px-2 py-2"
        style={{ borderTopWidth: "0.5px", borderColor: "var(--hairline)" }}
      >
        <Button variant="ghost" size="sm" onClick={onOpenSettings} className="w-full justify-start">
          {tw("settings.title")}
        </Button>
      </div>
    </aside>
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
      className="rounded-md px-2 py-1.5 text-left text-[13px]"
      style={{
        background: active ? "var(--fjord-tint)" : "transparent",
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
      className="px-2.5 py-1 text-left text-xs disabled:opacity-45"
      style={{ color: danger ? "var(--rust-ink)" : "var(--ink)" }}
    >
      {children}
    </button>
  );
}
