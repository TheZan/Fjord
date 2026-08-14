import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useRecoveryDiff, useReflog } from "@/application/useReflog";
import type { ReflogEntry } from "@/domain/git";
import type { RepositoryEntry } from "@/domain/workspace";
import { TextActionDialog } from "@/presentation/GitContextMenu";
import { Button, Select, Surface, TYPOGRAPHY } from "@/presentation/ui";

export function RecoveryCenter({
  repo,
  ready,
  actionPending,
  actionError,
  actionSuccess,
  onBack,
  onCreateBranch,
  onRestore,
}: {
  repo: RepositoryEntry;
  ready: boolean;
  actionPending: string | null;
  actionError: string | null;
  actionSuccess: string | null;
  onBack: () => void;
  onCreateBranch: (name: string, commitId: string) => void;
  onRestore: (commitId: string) => void;
}) {
  const { t, i18n } = useTranslation("workspace");
  const [refName, setRefName] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [branchTarget, setBranchTarget] = useState<ReflogEntry | null>(null);
  const [copied, setCopied] = useState(false);
  const { entries, refs, loading, loadingMore, hasMore, loadMore, error } = useReflog(
    repo.id,
    refName,
    ready,
  );
  const selected = entries.find((entry) => entry.index === selectedIndex) ?? entries[0] ?? null;
  const diff = useRecoveryDiff(repo.id, selected, ready);
  const busy = actionPending !== null;

  useEffect(() => {
    if (selectedIndex === null && entries[0]) setSelectedIndex(entries[0].index);
  }, [entries, selectedIndex]);

  useEffect(() => {
    setSelectedIndex(null);
    setCopied(false);
  }, [refName]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <Surface className="flex shrink-0 items-center gap-3 px-3 py-2" style={{ background: "var(--paper)" }}>
        <Button size="sm" variant="ghost" onClick={onBack}>{t("recovery.back")}</Button>
        <div className="min-w-0 flex-1">
          <h1 className={TYPOGRAPHY.screenTitle}>{t("recovery.title")}</h1>
          <p className={TYPOGRAPHY.caption} style={{ color: "var(--slate)" }}>{repo.name}</p>
        </div>
        <label className="flex items-center gap-2 text-[12px]" style={{ color: "var(--slate)" }}>
          <span>{t("recovery.reference")}</span>
          <Select
            aria-label={t("recovery.reference")}
            value={refName ?? "HEAD"}
            onChange={(event) => setRefName(event.target.value === "HEAD" ? null : event.target.value)}
          >
            <option value="HEAD">HEAD</option>
            {refs.map((name) => <option key={name} value={name}>{shortRef(name)}</option>)}
          </Select>
        </label>
      </Surface>

      <p
        className="shrink-0 rounded-md border px-3 py-2 text-[12px]"
        style={{ borderColor: "var(--hairline)", color: "var(--slate)", background: "var(--paper)" }}
      >
        {t("recovery.explanation")}
      </p>

      {actionError ? (
        <p role="alert" className="shrink-0 rounded-md px-3 py-2 text-[12px]" style={{ color: "var(--rust-ink)" }}>
          {actionError}
        </p>
      ) : actionSuccess ? (
        <p role="status" className="shrink-0 rounded-md px-3 py-2 text-[12px]" style={{ color: "var(--moss-ink)" }}>
          {actionSuccess}
        </p>
      ) : null}

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(18rem,0.9fr)_minmax(22rem,1.4fr)] gap-3">
        <Surface className="flex min-h-0 flex-col overflow-hidden" style={{ background: "var(--paper)" }}>
          <div className="border-b px-3 py-2 text-[12px] font-medium" style={{ borderColor: "var(--hairline)" }}>
            {t("recovery.entries")}
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-1.5">
            {loading ? <p role="status" className="p-3 text-[12px]">{t("recovery.loading")}</p> : null}
            {error ? <p role="alert" className="p-3 text-[12px]" style={{ color: "var(--rust-ink)" }}>{error}</p> : null}
            {!loading && !error && entries.length === 0 ? (
              <p className="p-3 text-[12px]" style={{ color: "var(--mist)" }}>{t("recovery.empty")}</p>
            ) : null}
            <ul className="flex flex-col gap-0.5">
              {entries.map((entry) => (
                <li key={entry.index}>
                  <button
                    type="button"
                    aria-pressed={selected?.index === entry.index}
                    onClick={() => {
                      setSelectedIndex(entry.index);
                      setCopied(false);
                    }}
                    className="interactive-row flex w-full flex-col rounded px-2.5 py-2 text-left"
                    style={{
                      background: selected?.index === entry.index ? "var(--fjord-tint)" : undefined,
                    }}
                  >
                    <span className="flex w-full items-center gap-2 text-[12px]">
                      <span className="min-w-0 flex-1 truncate font-medium">{entry.operation || t("recovery.unknownOperation")}</span>
                      <span className="shrink-0 font-mono text-[10px]" style={{ color: "var(--mist)" }}>
                        {entry.newId.slice(0, 8)}
                      </span>
                    </span>
                    <span className="mt-0.5 line-clamp-2 text-[11px]" style={{ color: "var(--slate)" }}>
                      {entry.commit?.message.split("\n", 1)[0] || entry.message || t("recovery.expired")}
                    </span>
                    <span className="mt-1 text-[10px]" style={{ color: "var(--mist)" }}>
                      {formatTimestamp(entry.timestamp, i18n.language)} · {entry.committerName}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {hasMore ? (
              <div className="p-2 text-center">
                <Button size="sm" onClick={loadMore} disabled={loadingMore}>
                  {loadingMore ? t("recovery.loadingMore") : t("recovery.loadMore")}
                </Button>
              </div>
            ) : null}
          </div>
        </Surface>

        <Surface className="flex min-h-0 flex-col overflow-hidden" style={{ background: "var(--paper)" }}>
          {selected ? (
            <>
              <div className="shrink-0 border-b p-3" style={{ borderColor: "var(--hairline)" }}>
                <div className="flex flex-wrap items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <h2 className="font-mono text-[13px]">{refName ? shortRef(refName) : "HEAD"}@&#123;{selected.index}&#125;</h2>
                    <p className="mt-1 break-all font-mono text-[11px]" style={{ color: "var(--mist)" }}>{selected.newId}</p>
                  </div>
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={busy || !ready || !selected.commit}
                      title={!selected.commit ? t("recovery.expiredReason") : undefined}
                      onClick={() => setBranchTarget(selected)}
                    >
                      {t("recovery.createBranch")}
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={busy || !ready || !selected.commit}
                      title={!selected.commit ? t("recovery.expiredReason") : undefined}
                      onClick={() => onRestore(selected.newId)}
                    >
                      {t("recovery.restore")}
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => {
                        void navigator.clipboard?.writeText(selected.newId);
                        setCopied(true);
                      }}
                    >
                      {copied ? t("recovery.copied") : t("recovery.copySha")}
                    </Button>
                  </div>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-auto p-3">
                <h3 className="text-[12px] font-medium">{t("recovery.diffTitle")}</h3>
                {diff.loading ? <p role="status" className="mt-3 text-[12px]">{t("recovery.loadingDiff")}</p> : null}
                {diff.error ? <p role="alert" className="mt-3 text-[12px]" style={{ color: "var(--rust-ink)" }}>{diff.error}</p> : null}
                {!selected.commit ? <p className="mt-3 text-[12px]">{t("recovery.expiredReason")}</p> : null}
                {!diff.loading && !diff.error && selected.commit && diff.files.length === 0 ? (
                  <p className="mt-3 text-[12px]" style={{ color: "var(--mist)" }}>{t("recovery.noDifference")}</p>
                ) : null}
                <ul className="mt-2 flex flex-col gap-1">
                  {diff.files.map((file) => (
                    <li key={file.path} className="flex items-center gap-2 rounded px-2 py-1.5 text-[12px]">
                      <span className="w-4 font-mono" aria-label={t(`commitInspector.changeType.${file.changeType}`)}>
                        {t(`commitInspector.changeTypeMark.${file.changeType}`)}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
                      <span style={{ color: "var(--moss-ink)" }}>+{file.additions}</span>
                      <span style={{ color: "var(--rust-ink)" }}>−{file.deletions}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          ) : (
            <p className="p-4 text-[12px]" style={{ color: "var(--mist)" }}>{t("recovery.selectEntry")}</p>
          )}
        </Surface>
      </div>

      {branchTarget ? (
        <TextActionDialog
          title={t("recovery.createBranchTitle")}
          description={t("recovery.createBranchDescription", { sha: branchTarget.newId.slice(0, 8) })}
          label={t("context.branchName")}
          confirmLabel={t("context.create")}
          onClose={() => setBranchTarget(null)}
          onConfirm={(name) => {
            onCreateBranch(name, branchTarget.newId);
            setBranchTarget(null);
          }}
        />
      ) : null}
    </div>
  );
}

function shortRef(refName: string) {
  return refName.replace(/^refs\/heads\//, "");
}

function formatTimestamp(value: string, locale: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
}
