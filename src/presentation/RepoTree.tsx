import { useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useBranches } from "@/application/useBranches";
import { useTags } from "@/application/useTags";
import { Input } from "@/presentation/ui";
import { ContextMenu, type ContextMenuItem } from "@/presentation/GitContextMenu";
import type { BranchInfo, TagInfo } from "@/domain/git";

type SectionKey = "local" | "remote" | "tags";

/**
 * Branches + tags, GitKraken-style: collapsible sections with a filter box,
 * each section's body capped at a fixed height so a repo with a hundred
 * branches stays a compact scrollable list instead of stretching the whole
 * column — the flat always-expanded `BranchesPanel` it replaces didn't.
 */
export function RepoTree({
  repoId,
  focusedBranch,
  onSelectBranch,
  onCheckout,
  onBranchContextAction,
  onTagContextAction,
}: {
  repoId: string;
  focusedBranch?: string | null;
  onSelectBranch?: (branch: string) => void;
  onCheckout?: (branch: string) => void;
  onBranchContextAction?: (action: BranchContextAction, branch: BranchInfo) => void;
  onTagContextAction?: (action: TagContextAction, tag: TagInfo) => void;
}) {
  const { t } = useTranslation("workspace");
  const { branches, loading: branchesLoading, error: branchesError } = useBranches(repoId);
  const { tags, loading: tagsLoading, error: tagsError } = useTags(repoId);
  const treeRef = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<Record<SectionKey, boolean>>({
    local: true,
    remote: false,
    tags: false,
  });
  const [menu, setMenu] = useState<
    | { kind: "branch"; branch: BranchInfo; x: number; y: number }
    | { kind: "tag"; tag: TagInfo; x: number; y: number }
    | null
  >(null);

  const loading = branchesLoading || tagsLoading;
  const error = branchesError ?? tagsError;

  const normalizedFilter = filter.trim().toLocaleLowerCase();
  const matches = (name: string) => !normalizedFilter || name.toLocaleLowerCase().includes(normalizedFilter);

  const visibleLocalBranches = branches.filter((branch) => !branch.isRemote);
  const local = visibleLocalBranches.filter((branch) => matches(branch.name));
  const visibleRemoteBranches = branches.filter(
    (branch) => branch.isRemote && remoteBranchDisplayName(branch.name) !== null,
  );
  const remote = visibleRemoteBranches.filter((branch) =>
    matches(remoteBranchDisplayName(branch.name) ?? branch.name),
  );
  const filteredTags = tags.filter((tag) => matches(tag.name));

  const totalCount = visibleLocalBranches.length + visibleRemoteBranches.length + tags.length;
  const matchedCount = local.length + remote.length + filteredTags.length;

  function toggle(key: SectionKey) {
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  if (loading && branches.length === 0 && tags.length === 0) return <RepoTreeSkeleton />;
  if (error) {
    return (
      <p className="text-sm" style={{ color: "var(--rust-ink)" }}>
        {error}
      </p>
    );
  }
  if (totalCount === 0) {
    return (
      <p className="text-sm" style={{ color: "var(--slate)" }}>
        {t("tree.empty")}
      </p>
    );
  }

  return (
    <div
      ref={treeRef}
      className="flex w-full max-w-sm flex-col rounded-lg border text-sm"
      style={{ borderColor: "var(--hairline)", background: "var(--paper)" }}
      onKeyDown={handleTreeKeyDown}
    >
      <div className="border-b p-2" style={{ borderColor: "var(--hairline)" }}>
        <Input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={t("tree.filterPlaceholder")}
          className="w-full"
        />
        {normalizedFilter && (
          <div
            className="mt-1 flex items-center justify-between px-0.5 text-[11px]"
            style={{ color: "var(--mist)" }}
          >
            <span>{t("tree.filterCount", { matched: matchedCount, total: totalCount })}</span>
            <button
              type="button"
              onClick={() => setFilter("")}
              className="interactive-control rounded px-1"
              style={{ color: "var(--fjord-ink)" }}
            >
              {t("tree.clearFilter")}
            </button>
          </div>
        )}
      </div>

      <div className="flex flex-col p-2">
        <TreeSection
          label={t("tree.local")}
          count={local.length}
          expanded={expanded.local}
          onToggle={() => toggle("local")}
          noMatches={normalizedFilter !== "" && local.length === 0}
        >
          {local.map((branch) => (
            <BranchRow
              key={branch.name}
              branch={branch}
              currentLabel={t("branches.current")}
              focused={branch.name === focusedBranch}
              onSelectBranch={onSelectBranch}
              onCheckout={onCheckout}
              onContextMenu={(event) => setMenu({ kind: "branch", branch, x: event.clientX, y: event.clientY })}
            />
          ))}
        </TreeSection>

        {visibleRemoteBranches.length > 0 && (
          <TreeSection
            label={t("tree.remote")}
            count={remote.length}
            expanded={expanded.remote}
            onToggle={() => toggle("remote")}
            noMatches={normalizedFilter !== "" && remote.length === 0}
          >
            {remote.map((branch) => (
              <BranchRow
                key={branch.name}
                branch={branch}
                currentLabel={t("branches.current")}
                focused={branch.name === focusedBranch}
                onSelectBranch={onSelectBranch}
                onCheckout={onCheckout}
                onContextMenu={(event) => setMenu({ kind: "branch", branch, x: event.clientX, y: event.clientY })}
              />
            ))}
          </TreeSection>
        )}

        {tags.length > 0 && (
          <TreeSection
            label={t("tree.tags")}
            count={filteredTags.length}
            expanded={expanded.tags}
            onToggle={() => toggle("tags")}
            noMatches={normalizedFilter !== "" && filteredTags.length === 0}
          >
            {filteredTags.map((tag) => (
              <TagRow key={tag.name} tag={tag} onContextMenu={(event) => setMenu({ kind: "tag", tag, x: event.clientX, y: event.clientY })} />
            ))}
          </TreeSection>
        )}
      </div>
      {menu && (
        <ContextMenu
          position={menu}
          items={menu.kind === "branch" ? branchMenuItems(menu.branch, t) : tagMenuItems(menu.tag, t)}
          onClose={() => setMenu(null)}
          onSelect={(action) => {
            const selection = menu;
            setMenu(null);
            if (selection.kind === "branch") onBranchContextAction?.(action as BranchContextAction, selection.branch);
            else onTagContextAction?.(action as TagContextAction, selection.tag);
          }}
        />
      )}
    </div>
  );

  function handleTreeKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(treeRef.current?.querySelectorAll<HTMLElement>("[data-tree-item]") ?? []);
    if (items.length === 0) return;
    const current = (event.target as HTMLElement).closest<HTMLElement>("[data-tree-item]");
    if (!current) return;
    event.preventDefault();
    const currentIndex = Math.max(0, items.indexOf(current));
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : Math.min(Math.max(currentIndex + (event.key === "ArrowDown" ? 1 : -1), 0), items.length - 1);
    items[nextIndex].focus();
  }
}

function TreeSection({
  label,
  count,
  expanded,
  onToggle,
  noMatches,
  children,
}: {
  label: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  noMatches: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation("workspace");

  return (
    <div className="mb-1 last:mb-0">
      <button
        type="button"
        onClick={onToggle}
        className="interactive-row flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px] font-medium uppercase tracking-wide"
        style={{ color: "var(--mist)" }}
      >
        <span className="inline-block w-3 shrink-0 text-center" style={{ color: "var(--slate)" }}>
          {expanded ? "▾" : "▸"}
        </span>
        <span className="flex-1">{label}</span>
        <span className="tabular-nums">{count}</span>
      </button>

      {expanded &&
        (noMatches ? (
          <p className="px-2 py-1 pl-6 text-xs" style={{ color: "var(--slate)" }}>
            {t("tree.noMatches")}
          </p>
        ) : (
          <div className="max-h-64 overflow-y-auto pl-3">
            <ul className="flex flex-col gap-0.5">{children}</ul>
          </div>
        ))}
    </div>
  );
}

function BranchRow({
  branch,
  currentLabel,
  focused,
  onSelectBranch,
  onCheckout,
  onContextMenu,
}: {
  branch: BranchInfo;
  currentLabel: string;
  focused: boolean;
  onSelectBranch?: (branch: string) => void;
  onCheckout?: (branch: string) => void;
  onContextMenu: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const displayName = branch.isRemote ? remoteBranchDisplayName(branch.name) : branch.name;
  if (displayName === null) return null;

  return (
    <li>
      <button
        data-tree-item
        type="button"
        onClick={() => onSelectBranch?.(branch.name)}
        onDoubleClick={() => {
          if (!branch.isCurrent) onCheckout?.(branch.name);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          onSelectBranch?.(branch.name);
          if (event.ctrlKey && !branch.isCurrent) onCheckout?.(branch.name);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          onContextMenu(event);
        }}
        data-selected={branch.isCurrent}
        data-focused={focused}
        className="interactive-row flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left"
        style={branch.isCurrent ? { color: "var(--fjord-ink)" } : undefined}
      >
        <code className="min-w-0 truncate font-mono text-xs">{displayName}</code>
        {branch.isCurrent && (
          <span className="shrink-0 text-xs" style={{ color: "var(--fjord-ink)" }}>
            {currentLabel}
          </span>
        )}
      </button>
    </li>
  );
}

function remoteBranchDisplayName(name: string) {
  const slash = name.indexOf("/");
  if (slash === -1) return name === "HEAD" ? null : name;
  const localName = name.slice(slash + 1);
  return localName === "HEAD" || localName.trim() === "" ? null : localName;
}

function TagRow({ tag, onContextMenu }: { tag: TagInfo; onContextMenu: (event: MouseEvent<HTMLLIElement>) => void }) {
  return (
    <li onContextMenu={(event) => { event.preventDefault(); onContextMenu(event); }}>
      <button
        data-tree-item
        type="button"
        className="interactive-row flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left"
      >
        <code className="min-w-0 truncate font-mono text-xs">{tag.name}</code>
        <span className="shrink-0 font-mono text-[11px]" style={{ color: "var(--mist)" }}>
          {tag.targetCommitId.slice(0, 7)}
        </span>
      </button>
    </li>
  );
}

export type BranchContextAction = "checkout" | "createBranch" | "rename" | "delete" | "deleteRemote" | "copy";
export type TagContextAction = "createBranch" | "delete" | "copy";

function branchMenuItems(branch: BranchInfo, t: (key: string) => string): ContextMenuItem[] {
  return [
    { id: "checkout", label: t("context.checkout"), icon: "checkout", shortcut: "Ctrl+Enter", disabled: branch.isCurrent },
    { id: "createBranch", label: t("context.createBranchHere"), icon: "branch", separatorBefore: true },
    { id: "rename", label: t("context.renameBranch"), icon: "branch", disabled: branch.isRemote },
    {
      id: branch.isRemote ? "deleteRemote" : "delete",
      label: branch.isRemote ? t("context.deleteRemoteBranch") : t("context.deleteBranch"),
      disabled: !branch.isRemote && branch.isCurrent,
      danger: true,
      icon: "delete",
    },
    { id: "copy", label: t("context.copyBranchName"), icon: "copy", shortcut: "Ctrl+C", separatorBefore: true },
  ];
}

function tagMenuItems(_tag: TagInfo, t: (key: string) => string): ContextMenuItem[] {
  return [
    { id: "createBranch", label: t("context.createBranchHere"), icon: "branch" },
    { id: "delete", label: t("context.deleteTag"), icon: "delete", danger: true },
    { id: "copy", label: t("context.copyTagName"), icon: "copy", shortcut: "Ctrl+C", separatorBefore: true },
  ];
}

function RepoTreeSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="flex w-full max-w-sm flex-col gap-3 rounded-lg border p-3"
      style={{ borderColor: "var(--hairline)", background: "var(--paper)" }}
    >
      <div className="skeleton h-8 w-full rounded-md" />
      {["82%", "65%", "74%", "58%", "70%"].map((width, index) => (
        <div key={index} className="skeleton h-6 rounded" style={{ width }} />
      ))}
    </div>
  );
}
