import { useState } from "react";
import { useTranslation } from "react-i18next";
import { userErrorMessage } from "@/application/errorMessage";
import { useRemotes } from "@/application/useRemotes";
import { runFetchRepo } from "@/infrastructure/tauriClient";
import { Button, Input, Surface } from "@/presentation/ui";
import type { RemotePushResult } from "@/domain/workspace";

export function RemoteSection({
  repoId,
  onPushToRemotes,
}: {
  repoId: string;
  onPushToRemotes: (remotes: string[]) => Promise<RemotePushResult[] | null>;
}) {
  const { t } = useTranslation("workspace");
  const { remotes, loading, error: loadError, addRemote } = useRemotes(repoId);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("origin");
  const [url, setUrl] = useState("");
  const [fetchImmediately, setFetchImmediately] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedForPush, setSelectedForPush] = useState<string[]>([]);
  const [pushPending, setPushPending] = useState(false);
  const [pushResults, setPushResults] = useState<RemotePushResult[] | null>(null);

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

  return (
    <Surface className="mt-3 w-full max-w-sm p-3 text-sm" style={{ background: "var(--paper)" }}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[12px] font-semibold">{t("remotes.title")}</h2>
        {!adding && (
          <Button size="sm" disabled={pushPending} onClick={() => setAdding(true)}>
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
                  disabled={pushPending}
                  onChange={() => togglePushRemote(remote.name)}
                />
              )}
              <div className="min-w-0 flex-1">
                <div className="text-[12px] font-medium">{remote.name}</div>
                <div className="truncate text-[11px]" style={{ color: "var(--slate)" }} title={remote.fetchUrl}>
                  {remote.fetchUrl}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {remotes.length > 1 && !adding && (
        <div className="mt-3 border-t pt-3" style={{ borderColor: "var(--hairline)" }}>
          <p className="text-[11px]" style={{ color: "var(--slate)" }}>
            {t("remotes.pushDescription")}
          </p>
          <Button
            className="mt-2"
            size="sm"
            disabled={pushPending || selectedForPush.length === 0}
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
    </Surface>
  );
}
