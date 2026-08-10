import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useStashes } from "@/application/useStashes";
import { Button, Input, Surface, TYPOGRAPHY } from "@/presentation/ui";
import { OverflowMenu } from "@/presentation/OverflowMenu";
import type { RepoStatus } from "@/domain/git";
import type { RepositoryEntry } from "@/domain/workspace";

/** Every one-click action the toolbar can fire. Branch creation needs a name, so it's a separate prop. */
export type RepoAction =
  | "fetch"
  | "pull"
  | "push"
  | "stash"
  | "stash-pop"
  | "terminal"
  | "open-ide"
  | "merge-tool";

export interface RepoOperationProgress {
  completed: number;
  total: number;
  error: string | null;
  status: string;
}

/**
 * The repository action bar, shaped after GitKraken's: one horizontal strip
 * of icon-over-label buttons in related groups (sync · branch/stash · tools)
 * rather than a row of undifferentiated text buttons.
 *
 * Only actions the backend actually implements appear here — there is no
 * Undo/Redo, because nothing in `GitBackend` models an operation log to undo
 * against, and a button that silently does nothing is worse than no button.
 */
export function RepoToolbar({
  repo,
  status,
  dataValidated,
  actionPending,
  operationProgress,
  onBack,
  onAction,
  onCancelOperation,
  onCreateBranch,
  onOpenSearch,
  onOpenInspector,
}: {
  repo: RepositoryEntry;
  status: RepoStatus | null;
  dataValidated: boolean;
  actionPending: string | null;
  operationProgress: RepoOperationProgress | null;
  onBack: () => void;
  onAction: (action: RepoAction) => void;
  onCancelOperation: () => void;
  onCreateBranch: (name: string) => void;
  onOpenSearch: () => void;
  onOpenInspector?: () => void;
}) {
  const { t } = useTranslation("workspace");
  const { stashes } = useStashes(repo.id);
  const [branchOpen, setBranchOpen] = useState(false);
  const [branchName, setBranchName] = useState("");
  const branchRef = useRef<HTMLDivElement>(null);

  const busy = actionPending !== null;
  const mutationBlocked = busy || !dataValidated;

  useEffect(() => {
    if (!branchOpen) return;
    function onPointerDown(event: MouseEvent) {
      if (!branchRef.current?.contains(event.target as Node)) setBranchOpen(false);
    }
    window.addEventListener("mousedown", onPointerDown);
    return () => window.removeEventListener("mousedown", onPointerDown);
  }, [branchOpen]);

  function submitBranch() {
    const name = branchName.trim();
    if (!name) {
      setBranchOpen(false);
      return;
    }
    onCreateBranch(name);
    setBranchName("");
    setBranchOpen(false);
  }

  return (
    <Surface className="flex shrink-0 flex-col" style={{ background: "var(--paper)" }}>
      <header className="flex items-stretch gap-1 px-2 py-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <button
            type="button"
            onClick={onBack}
            title={t("nav.back")}
            aria-label={t("nav.back")}
            className="interactive-control flex h-8 w-8 shrink-0 items-center justify-center rounded-md"
            style={{ color: "var(--slate)" }}
          >
            <IconBack />
          </button>
          <div className="min-w-0">
            <div className={`truncate font-medium leading-tight ${TYPOGRAPHY.body}`}>{repo.name}</div>
            <div className={`flex items-center gap-1.5 truncate ${TYPOGRAPHY.caption}`} style={{ color: "var(--slate)" }}>
              <IconBranch size={11} />
              <span className="truncate font-mono">{status?.branch ?? t("dashboard.unknown")}</span>
              {status ? <SyncCounters status={status} /> : null}
            </div>
          </div>
        </div>

        <ToolGroup>
          <PrimaryToolButton
            label={t("repoActions.fetch")}
            icon={<IconFetch />}
            pending={actionPending === "fetch"}
            disabled={mutationBlocked}
            disabledReason={!dataValidated ? t("snapshot.validationFailed") : t("operations.running")}
            onClick={() => onAction("fetch")}
          />
          <PrimaryToolButton
            label={t("repoActions.pull")}
            icon={<IconPull />}
            badge={status && status.behind > 0 ? status.behind : undefined}
            pending={actionPending === "pull"}
            disabled={mutationBlocked}
            disabledReason={!dataValidated ? t("snapshot.validationFailed") : t("operations.running")}
            onClick={() => onAction("pull")}
          />
          <PrimaryToolButton
            label={t("repoActions.push")}
            icon={<IconPush />}
            badge={status && status.ahead > 0 ? status.ahead : undefined}
            pending={actionPending === "push"}
            disabled={mutationBlocked}
            disabledReason={!dataValidated ? t("snapshot.validationFailed") : t("operations.running")}
            onClick={() => onAction("push")}
          />
          <div className="relative" ref={branchRef}>
            <PrimaryToolButton
              label={t("toolbar.branch")}
              icon={<IconBranch />}
              disabled={mutationBlocked}
              disabledReason={!dataValidated ? t("snapshot.validationFailed") : t("operations.running")}
              active={branchOpen}
              onClick={() => setBranchOpen((open) => !open)}
            />
            {branchOpen && (
              <div
                className="desktop-popover absolute right-0 top-full z-30 mt-1 w-60 rounded-lg border p-2"
                style={{
                  borderWidth: "0.5px",
                  borderColor: "var(--hairline-strong)",
                  background: "var(--paper)",
                }}
              >
                <Input
                  autoFocus
                  value={branchName}
                  onChange={(event) => setBranchName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") submitBranch();
                    if (event.key === "Escape") setBranchOpen(false);
                  }}
                  placeholder={t("toolbar.branchPlaceholder")}
                  className="w-full"
                />
                <div className="mt-1.5 flex justify-end">
                  <Button size="sm" variant="primary" onClick={submitBranch}>
                    {t("toolbar.createBranch")}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </ToolGroup>

        <ToolGroup last>
          <IconToolButton label={t("toolbar.search")} icon={<IconSearch />} onClick={onOpenSearch} />
          <IconToolButton
            label={t("repoActions.openIde")}
            icon={<IconIde />}
            pending={actionPending === "open-ide"}
            disabled={busy}
            disabledReason={t("operations.running")}
            onClick={() => onAction("open-ide")}
          />
          <OverflowMenu
            label={t("toolbar.moreActions")}
            items={[
              {
                id: "stash",
                label: t("toolbar.stash"),
                disabled: mutationBlocked || (status !== null && status.dirtyCount === 0),
                disabledReason: !dataValidated
                  ? t("snapshot.validationFailed")
                  : busy
                    ? t("operations.running")
                    : t("toolbar.nothingToStash"),
                onSelect: () => onAction("stash"),
              },
              {
                id: "stash-pop",
                label: `${t("toolbar.pop")}${stashes.length > 0 ? ` (${stashes.length})` : ""}`,
                disabled: mutationBlocked || stashes.length === 0,
                disabledReason: !dataValidated
                  ? t("snapshot.validationFailed")
                  : busy
                    ? t("operations.running")
                    : t("toolbar.noStashes"),
                onSelect: () => onAction("stash-pop"),
              },
              {
                id: "terminal",
                label: t("toolbar.terminal"),
                disabled: busy,
                disabledReason: t("operations.running"),
                onSelect: () => onAction("terminal"),
              },
              {
                id: "merge-tool",
                label: t("repoStatus.openMergeTool"),
                disabled: mutationBlocked || !status?.hasConflict,
                disabledReason: !dataValidated
                  ? t("snapshot.validationFailed")
                  : busy
                    ? t("operations.running")
                    : t("toolbar.noConflicts"),
                onSelect: () => onAction("merge-tool"),
              },
              ...(onOpenInspector
                ? [{ id: "inspector", label: t("inspector.open"), onSelect: onOpenInspector }]
                : []),
            ]}
          />
        </ToolGroup>
      </header>

      {operationProgress ? (
        <OperationProgressStrip progress={operationProgress} onCancel={onCancelOperation} />
      ) : null}
    </Surface>
  );
}

function OperationProgressStrip({
  progress,
  onCancel,
}: {
  progress: RepoOperationProgress;
  onCancel: () => void;
}) {
  const { t } = useTranslation("workspace");
  const percent =
    progress.total > 0 ? Math.min(100, Math.round((progress.completed / progress.total) * 100)) : 0;
  const label =
    progress.total > 1
      ? t("operations.progress", { completed: progress.completed, total: progress.total })
      : t("operations.running");

  return (
    <div
      className="flex items-center gap-2 border-t px-3 py-2"
      style={{ borderTopWidth: "0.5px", borderColor: "var(--hairline)" }}
    >
      <div className="h-1.5 min-w-28 flex-1 overflow-hidden rounded-full" style={{ background: "var(--page-bg)" }}>
        <div
          className="h-full rounded-full transition-[width]"
          style={{ background: "var(--fjord)", width: `${percent}%` }}
        />
      </div>
      <span className="w-24 shrink-0 text-right text-[11px]" style={{ color: "var(--slate)" }}>
        {label}
      </span>
      <Button size="sm" variant="ghost" onClick={onCancel}>
        {t("operations.cancel")}
      </Button>
    </div>
  );
}

function SyncCounters({ status }: { status: RepoStatus }) {
  const { t } = useTranslation("workspace");
  const parts: string[] = [];
  if (status.hasConflict) parts.push(`⚠ ${t("cardStatus.conflict")}`);
  if (status.ahead > 0) parts.push(`↑${status.ahead}`);
  if (status.behind > 0) parts.push(`↓${status.behind}`);
  if (status.dirtyCount > 0) parts.push(`●${status.dirtyCount}`);
  if (parts.length === 0) return null;

  return (
    <span className="shrink-0 font-mono tabular-nums" style={{ color: "var(--mist)" }}>
      {parts.join(" ")}
    </span>
  );
}

function ToolGroup({ children, last = false }: { children: ReactNode; last?: boolean }) {
  return (
    <div
      className={`flex shrink-0 items-stretch gap-0.5 ${last ? "" : "border-r pr-1 mr-0.5"}`}
      style={last ? undefined : { borderRightWidth: "0.5px", borderColor: "var(--hairline)" }}
    >
      {children}
    </div>
  );
}

function PrimaryToolButton({
  label,
  icon,
  onClick,
  disabled = false,
  disabledReason,
  pending = false,
  active = false,
  badge,
}: {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  disabledReason?: string;
  pending?: boolean;
  active?: boolean;
  badge?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={disabled ? disabledReason : label}
      data-selected={active}
      className="interactive-control relative flex h-8 items-center justify-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors disabled:opacity-35"
      style={{
        color: active ? "var(--fjord-ink)" : "var(--ink)",
        opacity: pending ? 0.55 : undefined,
      }}
    >
      <span className="flex shrink-0 items-center justify-center">{icon}</span>
      <span>{label}</span>
      {badge !== undefined ? (
        <span
          className="rounded-full px-1 text-[9px] font-medium leading-[13px] tabular-nums"
          style={{ background: "var(--fjord)", color: "var(--paper)" }}
        >
          {badge}
        </span>
      ) : null}
    </button>
  );
}

function IconToolButton({
  label,
  icon,
  onClick,
  disabled = false,
  disabledReason,
  pending = false,
}: {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  disabledReason?: string;
  pending?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={disabled ? disabledReason : label}
      className="interactive-control flex h-8 w-8 items-center justify-center rounded-md disabled:opacity-35"
      style={{ color: "var(--slate)", opacity: pending ? 0.55 : undefined }}
    >
      {icon}
    </button>
  );
}

// Inline 16px stroke icons — the project ships no icon dependency, and these
// are small enough that adding one would cost more than it saves.

function Svg({ children, size = 15 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

function IconBack() {
  return (
    <Svg size={16}>
      <path d="M19 12H5" />
      <path d="m12 19-7-7 7-7" />
    </Svg>
  );
}

function IconBranch({ size = 15 }: { size?: number }) {
  return (
    <Svg size={size}>
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </Svg>
  );
}

function IconIde() {
  return (
    <Svg>
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
    </Svg>
  );
}

function IconSearch() {
  return (
    <Svg>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </Svg>
  );
}

function IconFetch() {
  return (
    <Svg>
      <path d="M21 12a9 9 0 1 1-3-6.7" />
      <path d="M21 3v6h-6" />
    </Svg>
  );
}

function IconPull() {
  return (
    <Svg>
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 21h14" />
    </Svg>
  );
}

function IconPush() {
  return (
    <Svg>
      <path d="M12 21V9" />
      <path d="m7 14 5-5 5 5" />
      <path d="M5 3h14" />
    </Svg>
  );
}
