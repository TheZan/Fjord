import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { userErrorMessage } from "@/application/errorMessage";
import { useRemotes } from "@/application/useRemotes";
import { runFetchRepo } from "@/infrastructure/tauriClient";
import { DialogActions, DialogFrame } from "@/presentation/GitContextMenu";
import { Button, Input, Surface } from "@/presentation/ui";
import type { RemoteInfo, RemotePushResult, RemoveRemotePreflight } from "@/domain/workspace";

type RemoteDialog =
  | { kind: "edit"; remote: RemoteInfo }
  | { kind: "rename"; remote: RemoteInfo }
  | { kind: "remove"; preflight: RemoveRemotePreflight };

export function RemoteSection({
  repoId,
  onPushToRemotes,
}: {
  repoId: string;
  onPushToRemotes: (remotes: string[]) => Promise<RemotePushResult[] | null>;
}) {
  const { t } = useTranslation("workspace");
  const {
    remotes,
    loading,
    error: loadError,
    addRemote,
    editRemote,
    renameRemote,
    preflightRemoveRemote,
    removeRemote,
  } = useRemotes(repoId);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("origin");
  const [url, setUrl] = useState("");
  const [fetchImmediately, setFetchImmediately] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<RemoteDialog | null>(null);
  const [preflightPending, setPreflightPending] = useState<string | null>(null);
  const [selectedForPush, setSelectedForPush] = useState<string[]>([]);
  const [pushPending, setPushPending] = useState(false);
  const [pushResults, setPushResults] = useState<RemotePushResult[] | null>(null);

  useEffect(() => {
    const names = new Set(remotes.map((remote) => remote.name));
    setSelectedForPush((current) => {
      const selected = current.filter((remote) => names.has(remote));
      return selected.length === current.length ? current : selected;
    });
  }, [remotes]);

  async function submit() {
    if (!name.trim() || !url.trim() || pending) return;
    setPending(true);
    setError(null);
    try {
      const remote = await addRemote(name.trim(), url.trim());
      if (fetchImmediately) await runFetchRepo(repoId, remote.name).promise;
      setAdding(false);
      setName("origin");
      setUrl("");
    } catch (reason) {
      setError(userErrorMessage(reason));
    } finally {
      setPending(false);
    }
  }

  async function requestRemove(remote: RemoteInfo) {
    if (preflightPending) return;
    setPreflightPending(remote.name);
    setError(null);
    try {
      const preflight = await preflightRemoveRemote(remote.name);
      setDialog({ kind: "remove", preflight });
    } catch (reason) {
      setError(userErrorMessage(reason));
    } finally {
      setPreflightPending(null);
    }
  }

  function togglePushRemote(remote: string) {
    setSelectedForPush((current) =>
      current.includes(remote)
        ? current.filter((item) => item !== remote)
        : [...current, remote],
    );
    setPushResults(null);
  }

  async function pushSelectedRemotes() {
    if (selectedForPush.length === 0 || pushPending) return;
    setPushPending(true);
    setPushResults(null);
    try {
      const results = await onPushToRemotes(selectedForPush);
      if (results) setPushResults(results);
    } finally {
      setPushPending(false);
    }
  }

  const actionPending = pushPending || preflightPending !== null;

  return (
    <Surface className="mt-3 w-full max-w-sm p-3 text-sm" style={{ background: "var(--paper)" }}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[12px] font-semibold">{t("remotes.title")}</h2>
        {!adding && (
          <Button size="sm" disabled={actionPending} onClick={() => { setAdding(true); setError(null); }}>
            {t("remotes.add")}
          </Button>
        )}
      </div>

      {loading ? (
        <p className="mt-2 text-[11px]" style={{ color: "var(--slate)" }}>{t("remotes.loading")}</p>
      ) : loadError ? (
        <p role="alert" className="mt-2 text-[11px]" style={{ color: "var(--rust-ink)" }}>{loadError}</p>
      ) : remotes.length === 0 ? (
        <p className="mt-2 text-[11px]" style={{ color: "var(--slate)" }}>{t("remotes.empty")}</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {remotes.map((remote) => (
            <li key={remote.name} className="flex min-w-0 items-start gap-2">
              {remotes.length > 1 && (
                <input
                  type="checkbox"
                  className="mt-0.5"
                  aria-label={t("remotes.selectForPush", { remote: remote.name })}
                  checked={selectedForPush.includes(remote.name)}
                  disabled={actionPending}
                  onChange={() => togglePushRemote(remote.name)}
                />
              )}
              <div className="min-w-0 flex-1">
                <div className="text-[12px] font-medium">{remote.name}</div>
                <RemoteUrl label={t("remotes.fetchUrl")} value={remote.fetchUrl} />
                {remote.pushUrl ? <RemoteUrl label={t("remotes.pushUrl")} value={remote.pushUrl} /> : null}
                <div className="mt-1 flex flex-wrap gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={actionPending}
                    aria-label={t("remotes.editLabel", { remote: remote.name })}
                    onClick={() => { setDialog({ kind: "edit", remote }); setError(null); }}
                  >
                    {t("remotes.edit")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={actionPending}
                    aria-label={t("remotes.renameLabel", { remote: remote.name })}
                    onClick={() => { setDialog({ kind: "rename", remote }); setError(null); }}
                  >
                    {t("remotes.rename")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={actionPending}
                    aria-label={t("remotes.removeLabel", { remote: remote.name })}
                    onClick={() => void requestRemove(remote)}
                  >
                    {preflightPending === remote.name ? t("remotes.removeChecking") : t("remotes.remove")}
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {error && !adding ? (
        <p role="alert" className="mt-2 text-[11px]" style={{ color: "var(--rust-ink)" }}>{error}</p>
      ) : null}

      {remotes.length > 1 && !adding && (
        <div className="mt-3 border-t pt-3" style={{ borderColor: "var(--hairline)" }}>
          <p className="text-[11px]" style={{ color: "var(--slate)" }}>
            {t("remotes.pushDescription")}
          </p>
          <Button
            className="mt-2"
            size="sm"
            disabled={actionPending || selectedForPush.length === 0}
            onClick={() => void pushSelectedRemotes()}
          >
            {pushPending
              ? t("remotes.pushPending")
              : t("remotes.pushSelected", { count: selectedForPush.length })}
          </Button>
          {pushResults && (
            <ul
              className="mt-2 flex flex-col gap-1"
              aria-label={t("remotes.pushResults")}
              aria-live="polite"
              role="status"
            >
              {pushResults.map((result) => (
                <li
                  key={result.remote}
                  className="text-[11px]"
                  style={{ color: result.ok ? "var(--moss-ink)" : "var(--rust-ink)" }}
                >
                  {result.remote}: {result.ok
                    ? t("remotes.pushSuccess")
                    : t("remotes.pushFailure", {
                        error: userErrorMessage({ code: result.errorCode ?? "unexpected" }),
                      })}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {adding && (
        <div className="mt-3 flex flex-col gap-2 border-t pt-3" style={{ borderColor: "var(--hairline)" }}>
          <label className="flex flex-col gap-1 text-[11px]">
            {t("remotes.name")}
            <Input autoFocus disabled={pending} value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-[11px]">
            {t("remotes.url")}
            <Input disabled={pending} value={url} onChange={(event) => setUrl(event.target.value)} />
          </label>
          <label className="flex items-center gap-2 text-[11px]">
            <input
              type="checkbox"
              checked={fetchImmediately}
              disabled={pending}
              onChange={(event) => setFetchImmediately(event.target.checked)}
            />
            {t("remotes.fetchImmediately")}
          </label>
          {error && <p role="alert" className="text-[11px]" style={{ color: "var(--rust-ink)" }}>{error}</p>}
          <div className="flex justify-end gap-2">
            <Button size="sm" disabled={pending} onClick={() => { setAdding(false); setError(null); }}>
              {t("remotes.cancel")}
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={pending || !name.trim() || !url.trim()}
              onClick={() => void submit()}
            >
              {pending ? t("remotes.adding") : t("remotes.submit")}
            </Button>
          </div>
        </div>
      )}

      {dialog?.kind === "edit" ? (
        <EditRemoteDialog
          remote={dialog.remote}
          onClose={() => setDialog(null)}
          onSave={(fetchUrl, pushUrl) => editRemote(dialog.remote.name, fetchUrl, pushUrl)}
        />
      ) : null}
      {dialog?.kind === "rename" ? (
        <RenameRemoteDialog
          remote={dialog.remote}
          onClose={() => setDialog(null)}
          onRename={(newName) => renameRemote(dialog.remote.name, newName)}
        />
      ) : null}
      {dialog?.kind === "remove" ? (
        <RemoveRemoteDialog
          preflight={dialog.preflight}
          onClose={() => setDialog(null)}
          onRemove={() => removeRemote(dialog.preflight)}
        />
      ) : null}
    </Surface>
  );
}

function RemoteUrl({ label, value }: { label: string; value: string }) {
  return (
    <div className="truncate text-[11px]" style={{ color: "var(--slate)" }} title={value}>
      <span>{label}: </span><span>{value}</span>
    </div>
  );
}

function EditRemoteDialog({
  remote,
  onSave,
  onClose,
}: {
  remote: RemoteInfo;
  onSave: (fetchUrl: string, pushUrl: string | null) => Promise<RemoteInfo>;
  onClose: () => void;
}) {
  const { t } = useTranslation("workspace");
  const [fetchUrl, setFetchUrl] = useState("");
  const [separatePush, setSeparatePush] = useState(remote.pushUrl !== null);
  const [pushUrl, setPushUrl] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = fetchUrl.trim() !== "" && (!separatePush || pushUrl.trim() !== "");

  async function submit() {
    if (!valid || pending) return;
    setPending(true);
    setError(null);
    try {
      await onSave(fetchUrl.trim(), separatePush ? pushUrl.trim() : null);
      onClose();
    } catch (reason) {
      setError(userErrorMessage(reason));
      setPending(false);
    }
  }

  return (
    <DialogFrame
      title={t("remotes.editTitle", { remote: remote.name })}
      description={t("remotes.editDescription")}
      onClose={() => { if (!pending) onClose(); }}
    >
      <div className="text-[12px]" style={{ color: "var(--slate)" }}>
        <p>{t("remotes.currentFetchUrl")}</p>
        <code className="block break-all">{remote.fetchUrl}</code>
        <p className="mt-2">{t("remotes.currentPushUrl")}</p>
        <code className="block break-all">{remote.pushUrl ?? t("remotes.noExplicitPushUrl")}</code>
      </div>
      <label className="flex flex-col gap-1.5 text-[13px]">
        <span>{t("remotes.newFetchUrl")}</span>
        <Input
          autoComplete="off"
          disabled={pending}
          value={fetchUrl}
          onChange={(event) => setFetchUrl(event.target.value)}
        />
      </label>
      <label className="flex items-center gap-2 text-[13px]">
        <input
          type="checkbox"
          checked={separatePush}
          disabled={pending}
          onChange={(event) => { setSeparatePush(event.target.checked); setPushUrl(""); }}
        />
        {t("remotes.useSeparatePushUrl")}
      </label>
      {separatePush ? (
        <label className="flex flex-col gap-1.5 text-[13px]">
          <span>{t("remotes.newPushUrl")}</span>
          <Input
            autoComplete="off"
            disabled={pending}
            value={pushUrl}
            onChange={(event) => setPushUrl(event.target.value)}
          />
        </label>
      ) : null}
      {error ? <p role="alert" className="text-[12px]" style={{ color: "var(--rust-ink)" }}>{error}</p> : null}
      <DialogActions
        confirmLabel={pending ? t("remotes.saving") : t("remotes.save")}
        disabled={!valid || pending}
        closeDisabled={pending}
        onConfirm={() => void submit()}
        onClose={onClose}
      />
    </DialogFrame>
  );
}

function RenameRemoteDialog({
  remote,
  onRename,
  onClose,
}: {
  remote: RemoteInfo;
  onRename: (newName: string) => Promise<RemoteInfo>;
  onClose: () => void;
}) {
  const { t } = useTranslation("workspace");
  const [name, setName] = useState(remote.name);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const normalizedName = name.trim();
  const valid = normalizedName !== "" && normalizedName !== remote.name;

  async function submit() {
    if (!valid || pending) return;
    setPending(true);
    setError(null);
    try {
      await onRename(normalizedName);
      onClose();
    } catch (reason) {
      setError(userErrorMessage(reason));
      setPending(false);
    }
  }

  return (
    <DialogFrame
      title={t("remotes.renameTitle", { remote: remote.name })}
      description={t("remotes.renameDescription")}
      onClose={() => { if (!pending) onClose(); }}
    >
      <label className="flex flex-col gap-1.5 text-[13px]">
        <span>{t("remotes.name")}</span>
        <Input
          disabled={pending}
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") void submit(); }}
        />
      </label>
      {error ? <p role="alert" className="text-[12px]" style={{ color: "var(--rust-ink)" }}>{error}</p> : null}
      <DialogActions
        confirmLabel={pending ? t("remotes.renaming") : t("remotes.rename")}
        disabled={!valid || pending}
        closeDisabled={pending}
        onConfirm={() => void submit()}
        onClose={onClose}
      />
    </DialogFrame>
  );
}

function RemoveRemoteDialog({
  preflight,
  onRemove,
  onClose,
}: {
  preflight: RemoveRemotePreflight;
  onRemove: () => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation("workspace");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await onRemove();
      onClose();
    } catch (reason) {
      setError(userErrorMessage(reason));
      setPending(false);
    }
  }

  return (
    <DialogFrame
      title={t("remotes.removeTitle", { remote: preflight.remote })}
      description={t("remotes.removeDescription", { remote: preflight.remote })}
      onClose={() => { if (!pending) onClose(); }}
    >
      {preflight.orphanedUpstreams.length > 0 ? (
        <div className="text-[13px]">
          <p>{t("remotes.orphanedBranches")}</p>
          <ul className="mt-1 list-disc pl-5">
            {preflight.orphanedUpstreams.map((branch) => <li key={branch}><code>{branch}</code></li>)}
          </ul>
        </div>
      ) : (
        <p className="text-[13px]">{t("remotes.noOrphanedBranches")}</p>
      )}
      {error ? <p role="alert" className="text-[12px]" style={{ color: "var(--rust-ink)" }}>{error}</p> : null}
      <DialogActions
        confirmLabel={pending ? t("remotes.removing") : t("remotes.remove")}
        danger
        disabled={pending}
        closeDisabled={pending}
        onConfirm={() => void submit()}
        onClose={onClose}
      />
    </DialogFrame>
  );
}
