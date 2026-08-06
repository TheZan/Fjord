import { useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useBranches } from "@/application/useBranches";
import { useTags } from "@/application/useTags";
import { Input } from "@/presentation/ui";
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
}: {
  repoId: string;
  focusedBranch?: string | null;
  onSelectBranch?: (branch: string) => void;
  onCheckout?: (branch: string) => void;
}) {
  const { t } = useTranslation("workspace");
  const { branches, loading: branchesLoading, error: branchesError } = useBranches(repoId);
  const { tags, loading: tagsLoading, error: tagsError } = useTags(repoId);
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<Record<SectionKey, boolean>>({
    local: true,
    remote: false,
    tags: false,
  });

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

  if (loading && branches.length === 0 && tags.length === 0) return null;
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
      className="flex w-full max-w-sm flex-col rounded-lg border text-sm"
      style={{ borderColor: "var(--hairline)", background: "var(--paper)" }}
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
              <TagRow key={tag.name} tag={tag} />
            ))}
          </TreeSection>
        )}
      </div>
    </div>
  );
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
}: {
  branch: BranchInfo;
  currentLabel: string;
  focused: boolean;
  onSelectBranch?: (branch: string) => void;
  onCheckout?: (branch: string) => void;
}) {
  const displayName = branch.isRemote ? remoteBranchDisplayName(branch.name) : branch.name;
  if (displayName === null) return null;

  return (
    <li>
      <button
        type="button"
        onClick={() => onSelectBranch?.(branch.name)}
        onDoubleClick={() => {
          if (!branch.isCurrent) onCheckout?.(branch.name);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          onSelectBranch?.(branch.name);
          if (!branch.isCurrent) onCheckout?.(branch.name);
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

function TagRow({ tag }: { tag: TagInfo }) {
  return (
    <li className="interactive-row flex items-center justify-between gap-2 rounded px-2 py-1">
      <code className="min-w-0 truncate font-mono text-xs">{tag.name}</code>
      <span className="shrink-0 font-mono text-[11px]" style={{ color: "var(--mist)" }}>
        {tag.targetCommitId.slice(0, 7)}
      </span>
    </li>
  );
}
