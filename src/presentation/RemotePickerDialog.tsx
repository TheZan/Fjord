import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useRemotes } from "@/application/useRemotes";
import { DialogActions, DialogFrame } from "@/presentation/GitContextMenu";
import { Select } from "@/presentation/ui";

export type RemotePickerKind = "fetch" | "publish" | "setUpstream";

export interface RemotePickerSelection {
  remote: string;
  upstream: string | null;
}

export function RemotePickerDialog({
  repoId,
  kind,
  branch,
  remoteBranches = [],
  onConfirm,
  onClose,
}: {
  repoId: string;
  kind: RemotePickerKind;
  branch?: string;
  remoteBranches?: string[];
  onConfirm: (selection: RemotePickerSelection) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("workspace");
  const { remotes, loading, error } = useRemotes(repoId);
  const [remote, setRemote] = useState("");
  const [upstream, setUpstream] = useState("");

  useEffect(() => {
    if (!remotes.some((candidate) => candidate.name === remote)) {
      setRemote(remotes[0]?.name ?? "");
    }
  }, [remote, remotes]);

  const upstreamOptions = useMemo(
    () => remoteBranches.filter((candidate) => candidate.startsWith(`${remote}/`)),
    [remote, remoteBranches],
  );

  useEffect(() => {
    if (!upstreamOptions.includes(upstream)) setUpstream(upstreamOptions[0] ?? "");
  }, [upstream, upstreamOptions]);

  const needsUpstream = kind === "setUpstream";
  const disabledReason = loading
    ? t("remotes.picker.loading")
    : error
      ? error
      : remotes.length === 0
        ? t("remotes.picker.empty")
        : needsUpstream && upstreamOptions.length === 0
          ? t("remotes.picker.noBranches", { remote })
          : null;
  const canConfirm = remote !== "" && (!needsUpstream || upstream !== "") && disabledReason === null;

  return (
    <DialogFrame
      title={t(`remotes.picker.${kind}Title`)}
      description={t(`remotes.picker.${kind}Description`, { branch })}
      onClose={onClose}
    >
      {loading ? (
        <p role="status" aria-live="polite" className="text-[13px]" style={{ color: "var(--slate)" }}>
          {t("remotes.picker.loading")}
        </p>
      ) : error ? (
        <p role="alert" className="text-[13px]" style={{ color: "var(--rust-ink)" }}>{error}</p>
      ) : remotes.length === 0 ? (
        <p role="status" className="text-[13px]" style={{ color: "var(--slate)" }}>
          {t("remotes.picker.empty")}
        </p>
      ) : (
        <>
          <label className="flex flex-col gap-1.5 text-[13px]">
            <span>{t("remotes.picker.remoteLabel")}</span>
            <Select value={remote} onChange={(event) => setRemote(event.target.value)}>
              {remotes.map((candidate) => (
                <option key={candidate.name} value={candidate.name}>{candidate.name}</option>
              ))}
            </Select>
          </label>
          {needsUpstream ? (
            upstreamOptions.length > 0 ? (
              <label className="flex flex-col gap-1.5 text-[13px]">
                <span>{t("remotes.picker.branchLabel")}</span>
                <Select value={upstream} onChange={(event) => setUpstream(event.target.value)}>
                  {upstreamOptions.map((candidate) => (
                    <option key={candidate} value={candidate}>{candidate.slice(remote.length + 1)}</option>
                  ))}
                </Select>
              </label>
            ) : (
              <p role="status" className="text-[12px]" style={{ color: "var(--rust-ink)" }}>
                {t("remotes.picker.noBranches", { remote })}
              </p>
            )
          ) : null}
        </>
      )}
      <DialogActions
        confirmLabel={t(`remotes.picker.${kind}Confirm`)}
        disabled={!canConfirm}
        onConfirm={() => onConfirm({ remote, upstream: needsUpstream ? upstream : null })}
        onClose={onClose}
      />
    </DialogFrame>
  );
}
