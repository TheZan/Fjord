import { useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useTranslation } from "react-i18next";
import { useBranches } from "@/application/useBranches";
import { useStashes } from "@/application/useStashes";
import { useTags } from "@/application/useTags";
import { Input, Surface } from "@/presentation/ui";
import { ContextMenu, type ContextMenuItem } from "@/presentation/GitContextMenu";
import { formatRelativeTime } from "@/presentation/formatRelativeTime";
import type { BranchInfo, StashEntry, StashId, TagInfo } from "@/domain/git";

type SectionKey = "local" | "remote" | "tags" | "stashes";
const TREE_ROW_HEIGHT = 40;

/**
 * Branches, tags, and stashes: collapsible sections with a filter box, each section's body
 * capped at a fixed height so a repo with a hundred branches stays a compact
 * scrollable list instead of stretching the whole column — the flat
 * always-expanded `BranchesPanel` it replaces didn't.
 */
export function RepoTree({
  repoId,
  focusedBranch,
  onSelectBranch,
  onCheckout,
  checkoutDisabledReason,
  onBranchContextAction,
  onPublishBranch,
  onTagContextAction,
  selectedStashId,
  onSelectStash,
  onStashContextMenu,
}: {
  repoId: string;
  focusedBranch?: string | null;
  onSelectBranch?: (branch: string) => void;
  onCheckout?: (branch: string) => void;
  checkoutDisabledReason?: string;
  onBranchContextAction?: (action: BranchContextAction, branch: BranchInfo, upstreamChoices: string[]) => void;
  onPublishBranch?: (branch: string) => void;
  onTagContextAction?: (action: TagContextAction, tag: TagInfo) => void;
  selectedStashId?: StashId | null;
  onSelectStash?: (stashId: StashId) => void;
  onStashContextMenu?: (stashId: StashId) => void;
}) {
  const { t, i18n } = useTranslation("workspace");
  const { branches, loading: branchesLoading, error: branchesError } = useBranches(repoId);
  const { tags, loading: tagsLoading, error: tagsError } = useTags(repoId);
  const { stashes, loading: stashesLoading, error: stashesError } = useStashes(repoId);
  const treeRef = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<Record<SectionKey, boolean>>({
    local: true,
    remote: false,
    tags: false,
    stashes: false,
  });
  const [menu, setMenu] = useState<
    | { kind: "branch"; branch: BranchInfo; x: number; y: number }
    | { kind: "tag"; tag: TagInfo; x: number; y: number }
    | { kind: "stash"; stashId: StashId; x: number; y: number }
    | null
  >(null);

  const loading = branchesLoading || tagsLoading || stashesLoading;
  const error = branchesError ?? tagsError ?? stashesError;

  const normalizedFilter = filter.trim().toLocaleLowerCase();
  const matches = (name: string) => !normalizedFilter || name.toLocaleLowerCase().includes(normalizedFilter);

  const visibleLocalBranches = branches.filter((branch) => !branch.isRemote);
  const currentBranch = visibleLocalBranches.find((branch) => branch.isCurrent)?.name ?? null;
  const local = visibleLocalBranches.filter((branch) => matches(branch.name));
  const visibleRemoteBranches = branches.filter(
    (branch) => branch.isRemote && remoteBranchDisplayName(branch.name) !== null,
  );
  const remote = visibleRemoteBranches.filter((branch) =>
    matches(remoteBranchDisplayName(branch.name) ?? branch.name),
  );
  const filteredTags = tags.filter((tag) => matches(tag.name));
  const filteredStashes = stashes.filter(
    (entry) => matches(entry.title) || matches(entry.message),
  );

  const totalCount = visibleLocalBranches.length + visibleRemoteBranches.length + tags.length + stashes.length;
  const matchedCount = local.length + remote.length + filteredTags.length + filteredStashes.length;

  function toggle(key: SectionKey) {
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  if (loading && branches.length === 0 && tags.length === 0 && stashes.length === 0) {
    return <RepoTreeSkeleton />;
  }
  if (error) {
    return (
      <p className="text-sm" style={{ color: "var(--rust-ink)" }}>
        {error}
      </p>
    );
  }
  return (
    <Surface
      ref={treeRef}
      className="repo-tree-container flex w-full max-w-sm flex-col text-sm"
      style={{ background: "var(--paper)" }}
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
          <VirtualTreeItems
            count={local.length}
            renderItem={(index) => {
              const branch = local[index];
              return (
                <BranchRow
                  branch={branch}
                  currentLabel={t("branches.current")}
                  publishLabel={t("remotes.pushAndSetUpstream")}
                  focused={branch.name === focusedBranch}
                  onSelectBranch={onSelectBranch}
                  onCheckout={onCheckout}
                  checkoutDisabledReason={checkoutDisabledReason}
                  onPublishBranch={onPublishBranch}
                  onContextMenu={(position) => setMenu({ kind: "branch", branch, ...position })}
                />
              );
            }}
          />
        </TreeSection>

        {visibleRemoteBranches.length > 0 && (
          <TreeSection
            label={t("tree.remote")}
            count={remote.length}
            expanded={expanded.remote}
            onToggle={() => toggle("remote")}
            noMatches={normalizedFilter !== "" && remote.length === 0}
          >
            <VirtualTreeItems
              count={remote.length}
              renderItem={(index) => {
                const branch = remote[index];
                return (
                  <BranchRow
                    branch={branch}
                    currentLabel={t("branches.current")}
                    publishLabel={t("remotes.pushAndSetUpstream")}
                    focused={branch.name === focusedBranch}
                    onSelectBranch={onSelectBranch}
                    onCheckout={onCheckout}
                    checkoutDisabledReason={checkoutDisabledReason}
                    onPublishBranch={onPublishBranch}
                    onContextMenu={(position) => setMenu({ kind: "branch", branch, ...position })}
                  />
                );
              }}
            />
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
            <VirtualTreeItems
              count={filteredTags.length}
              renderItem={(index) => {
                const tag = filteredTags[index];
                return <TagRow tag={tag} onContextMenu={(event) => setMenu({ kind: "tag", tag, x: event.clientX, y: event.clientY })} />;
              }}
            />
          </TreeSection>
        )}

        <TreeSection
          label={t("tree.stashes")}
          count={filteredStashes.length}
          expanded={expanded.stashes}
          onToggle={() => toggle("stashes")}
          noMatches={normalizedFilter !== "" && stashes.length > 0 && filteredStashes.length === 0}
        >
          {stashes.length === 0 ? (
            <p className="px-2 py-1 pl-3 text-xs" style={{ color: "var(--slate)" }}>
              {t("stash.empty")}
            </p>
          ) : (
            <VirtualTreeItems
              count={filteredStashes.length}
              getItemKey={(index) => filteredStashes[index].id}
              renderItem={(index) => {
                const entry = filteredStashes[index];
                return (
                  <StashRow
                    entry={entry}
                    locale={i18n.language}
                    selected={entry.id === selectedStashId}
                    onSelect={() => onSelectStash?.(entry.id)}
                    onContextMenu={(position, invoker) => {
                      invoker.focus();
                      onStashContextMenu?.(entry.id);
                      setMenu({ kind: "stash", stashId: entry.id, ...position });
                    }}
                  />
                );
              }}
            />
          )}
        </TreeSection>
      </div>
      {menu && (
        <ContextMenu
          position={menu}
          ariaLabel={menu.kind === "stash" ? t("tree.stashes") : undefined}
          items={
            menu.kind === "branch"
              ? branchMenuItems(menu.branch, currentBranch, t, visibleRemoteBranches.length > 0, checkoutDisabledReason)
              : menu.kind === "tag"
                ? tagMenuItems(menu.tag, t)
                : []
          }
          onClose={() => setMenu(null)}
          onSelect={(action) => {
            const selection = menu;
            setMenu(null);
            if (selection.kind === "branch") {
              onBranchContextAction?.(
                action as BranchContextAction,
                selection.branch,
                visibleRemoteBranches.map((branch) => branch.name),
              );
            }
            else if (selection.kind === "tag") {
              onTagContextAction?.(action as TagContextAction, selection.tag);
            }
          }}
        />
      )}
    </Surface>
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
          <div className="pl-3">{children}</div>
        ))}
    </div>
  );
}

function BranchRow({
  branch,
  currentLabel,
  publishLabel,
  focused,
  onSelectBranch,
  onCheckout,
  checkoutDisabledReason,
  onPublishBranch,
  onContextMenu,
}: {
  branch: BranchInfo;
  currentLabel: string;
  publishLabel: string;
  focused: boolean;
  onSelectBranch?: (branch: string) => void;
  onCheckout?: (branch: string) => void;
  checkoutDisabledReason?: string;
  onPublishBranch?: (branch: string) => void;
  onContextMenu: (position: { x: number; y: number }) => void;
}) {
  const displayName = branch.isRemote ? remoteBranchDisplayName(branch.name) : branch.name;
  if (displayName === null) return null;

  const showPublish = branch.isCurrent && !branch.upstream && Boolean(onPublishBranch);

  return (
    <li className="flex items-center gap-1">
      <button
        data-tree-item
        type="button"
        onClick={() => onSelectBranch?.(branch.name)}
        onDoubleClick={() => {
          if (!branch.isCurrent && !checkoutDisabledReason) onCheckout?.(branch.name);
        }}
        onKeyDown={(event) => {
          if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
            event.preventDefault();
            const bounds = event.currentTarget.getBoundingClientRect();
            onContextMenu({ x: bounds.left + 12, y: bounds.top + 12 });
            return;
          }
          if (event.key !== "Enter") return;
          event.preventDefault();
          onSelectBranch?.(branch.name);
          if (event.ctrlKey && !branch.isCurrent && !checkoutDisabledReason) onCheckout?.(branch.name);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          onContextMenu({ x: event.clientX, y: event.clientY });
        }}
        data-selected={branch.isCurrent}
        data-focused={focused}
        title={!branch.isCurrent ? checkoutDisabledReason : undefined}
        className="interactive-row flex min-w-0 flex-1 items-center justify-between gap-2 rounded px-2 py-1 text-left"
        style={branch.isCurrent ? { color: "var(--fjord-ink)" } : undefined}
      >
        <span className="flex min-w-0 flex-col">
          <code className="truncate font-mono text-xs">{displayName}</code>
          {!branch.isRemote && branch.upstream ? (
            <span className="truncate text-[10px]" style={{ color: "var(--mist)" }}>
              {branch.upstream} {branch.ahead ? `↑${branch.ahead}` : ""} {branch.behind ? `↓${branch.behind}` : ""}
            </span>
          ) : null}
        </span>
        {branch.isCurrent && !showPublish ? <span className="shrink-0 text-xs" style={{ color: "var(--fjord-ink)" }}>{currentLabel}</span> : null}
      </button>
      {showPublish ? (
        <button
          type="button"
          className="interactive-control shrink-0 whitespace-nowrap rounded px-1.5 py-1 text-[10px]"
          style={{ color: "var(--fjord-ink)" }}
          aria-label={publishLabel}
          onClick={() => onPublishBranch?.(branch.name)}
        >
          {publishLabel}
        </button>
      ) : null}
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

function StashRow({
  entry,
  locale,
  selected,
  onSelect,
  onContextMenu,
}: {
  entry: StashEntry;
  locale: string;
  selected: boolean;
  onSelect: () => void;
  onContextMenu: (
    position: { x: number; y: number },
    invoker: HTMLButtonElement,
  ) => void;
}) {
  const source = entry.branch ?? entry.base.slice(0, 7);
  const relativeTime = formatRelativeTime(entry.createdAt, locale);

  function openKeyboardMenu(event: KeyboardEvent<HTMLButtonElement>) {
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    onContextMenu(
      { x: bounds.left + 12, y: bounds.top + 12 },
      event.currentTarget,
    );
  }

  return (
    <li className="h-10">
      <button
        data-tree-item
        data-stash-id={entry.id}
        data-selected={selected}
        type="button"
        onClick={onSelect}
        onKeyDown={(event) => {
          if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
            openKeyboardMenu(event);
          }
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          onContextMenu(
            { x: event.clientX, y: event.clientY },
            event.currentTarget,
          );
        }}
        className="interactive-row flex h-10 w-full min-w-0 items-center gap-2 rounded px-2 text-left"
      >
        <span
          aria-hidden="true"
          className="flex h-5 w-4 shrink-0 items-center justify-center text-sm"
          style={{ color: "var(--fjord-ink)" }}
        >
          ◈
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-xs font-medium">{entry.title}</span>
          <span className="flex min-w-0 items-center gap-2 text-[10px]" style={{ color: "var(--mist)" }}>
            <span className="min-w-0 flex-1 truncate font-mono">
              {source} · {entry.refName}
            </span>
            <time
              className="stash-relative-time shrink-0"
              dateTime={entry.createdAt}
              title={entry.createdAt}
            >
              {relativeTime}
            </time>
          </span>
        </span>
      </button>
    </li>
  );
}

function VirtualTreeItems({
  count,
  renderItem,
  getItemKey,
}: {
  count: number;
  renderItem: (index: number) => ReactNode;
  getItemKey?: (index: number) => string | number;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => TREE_ROW_HEIGHT,
    getItemKey,
    overscan: 6,
  });

  return (
    <div
      ref={scrollRef}
      role="list"
      className="overflow-y-auto"
      style={{ height: Math.min(count * TREE_ROW_HEIGHT, 256) }}
    >
      <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtualRow) => (
          <div
            key={virtualRow.key}
            className="absolute left-0 top-0 w-full"
            style={{
              height: virtualRow.size,
              transform: `translateY(${virtualRow.start}px)`,
            }}
          >
            {renderItem(virtualRow.index)}
          </div>
        ))}
      </div>
    </div>
  );
}

export type BranchContextAction = "checkout" | "merge" | "squashMerge" | "createBranch" | "rename" | "setUpstream" | "unsetUpstream" | "publish" | "delete" | "deleteRemote" | "copy";
export type TagContextAction = "createBranch" | "delete" | "copy";

function branchMenuItems(
  branch: BranchInfo,
  currentBranch: string | null,
  t: (key: string, values?: Record<string, unknown>) => string,
  hasRemoteBranches: boolean,
  checkoutDisabledReason?: string,
): ContextMenuItem[] {
  return [
    {
      id: "checkout",
      label: t("context.checkout"),
      icon: "checkout",
      shortcut: "Ctrl+Enter",
      disabled: branch.isCurrent || Boolean(checkoutDisabledReason),
      disabledReason: checkoutDisabledReason,
    },
    {
      id: "merge",
      label: t("context.mergeInto", {
        source: branch.name,
        target: currentBranch ?? "HEAD",
      }),
      icon: "merge",
      separatorBefore: true,
      disabled: branch.isCurrent || !currentBranch || Boolean(checkoutDisabledReason),
      disabledReason: branch.isCurrent
        ? t("merge.blocked.sourceIsCurrentBranch", { target: currentBranch ?? branch.name })
        : !currentBranch
          ? t("merge.blocked.detachedHead")
          : checkoutDisabledReason,
    },
    {
      id: "squashMerge",
      label: t("context.squashMergeInto", {
        source: branch.name,
        target: currentBranch ?? "HEAD",
      }),
      icon: "merge",
      disabled: branch.isCurrent || !currentBranch || Boolean(checkoutDisabledReason),
      disabledReason: branch.isCurrent
        ? t("merge.blocked.sourceIsCurrentBranch", { target: currentBranch ?? branch.name })
        : !currentBranch
          ? t("merge.blocked.detachedHead")
          : checkoutDisabledReason,
    },
    {
      id: "createBranch",
      label: t("context.createBranchHere"),
      icon: "branch",
      disabled: Boolean(checkoutDisabledReason),
      disabledReason: checkoutDisabledReason,
    },
    { id: "rename", label: t("context.renameBranch"), icon: "branch", disabled: branch.isRemote },
    { id: "setUpstream", label: t("context.setUpstream"), icon: "branch", disabled: branch.isRemote || !hasRemoteBranches },
    { id: "unsetUpstream", label: t("context.unsetUpstream"), icon: "branch", disabled: branch.isRemote || !branch.upstream },
    { id: "publish", label: t("remotes.pushAndSetUpstream"), icon: "branch", disabled: branch.isRemote || !branch.isCurrent || Boolean(branch.upstream) },
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
