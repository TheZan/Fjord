import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CreateStashRequest, StashScope } from "@/domain/git";
import { TextActionDialog } from "@/presentation/GitContextMenu";

export interface StashDialogPath {
  path: string;
  untracked: boolean;
}

export function CreateStashDialog({
  initialScope,
  selectedPaths = [],
  pathsSupported,
  onClose,
  onConfirm,
}: {
  initialScope: StashScope;
  selectedPaths?: StashDialogPath[];
  pathsSupported: boolean;
  onClose: () => void;
  onConfirm: (request: CreateStashRequest) => void;
}) {
  const { t } = useTranslation("workspace");
  const openedWithPaths = initialScope.kind === "paths";
  const [scopeKind, setScopeKind] = useState<"all" | "paths">(initialScope.kind);
  const [includeUntracked, setIncludeUntracked] = useState(true);
  const effectivePaths = useMemo(
    () => selectedPaths.filter((item) => includeUntracked || !item.untracked),
    [includeUntracked, selectedPaths],
  );
  const excluded = selectedPaths.filter((item) => item.untracked && !includeUntracked);
  const pathsUnavailable = scopeKind === "paths" && !pathsSupported;
  const pathsEmpty = scopeKind === "paths" && effectivePaths.length === 0;
  const disabledReason = pathsUnavailable
    ? t("stash.create.unsupportedGit")
    : pathsEmpty
      ? t("stash.create.emptyEffectiveScope")
      : undefined;
  const initialValue = initialScope.kind === "all"
    ? t("stash.create.defaultAll")
    : selectedPaths.length === 1
      ? t("workingFile.stashFile.defaultMessage", { path: selectedPaths[0]?.path ?? "" })
      : t("stash.create.defaultPaths", { count: selectedPaths.length });

  return (
    <TextActionDialog
      title={t("stash.create.title")}
      description={t("workingFile.stashFile.stagedNotPreserved")}
      label={t("stash.create.name")}
      initialValue={initialValue}
      confirmLabel={t("stash.create.confirm")}
      disabled={Boolean(disabledReason)}
      disabledReason={disabledReason}
      onClose={onClose}
      onConfirm={(message) => {
        const scope: StashScope = scopeKind === "all"
          ? { kind: "all" }
          : { kind: "paths", paths: effectivePaths.map((item) => item.path) };
        onConfirm({ scope, message, includeUntracked });
      }}
    >
      {openedWithPaths ? (
        <fieldset className="flex flex-col gap-2 text-[13px]" style={{ color: "var(--slate)" }}>
          <legend className="mb-1">{t("stash.create.scope")}</legend>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="stash-scope"
              checked={scopeKind === "all"}
              onChange={() => setScopeKind("all")}
            />
            <span>{t("stash.create.all")}</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="stash-scope"
              checked={scopeKind === "paths"}
              onChange={() => setScopeKind("paths")}
            />
            <span>{t("stash.create.selected", { count: effectivePaths.length })}</span>
          </label>
          {scopeKind === "paths" && effectivePaths.length > 0 ? (
            <ul className="ml-6 max-h-28 overflow-auto font-mono text-[11px]" aria-label={t("stash.create.selectedFiles")}>
              {effectivePaths.slice(0, 5).map((item) => <li key={item.path}>{item.path}</li>)}
              {effectivePaths.length > 5 ? (
                <li>{t("stash.create.andMore", { count: effectivePaths.length - 5 })}</li>
              ) : null}
            </ul>
          ) : null}
        </fieldset>
      ) : null}
      <label className="flex items-center gap-2 text-[13px]" style={{ color: "var(--slate)" }}>
        <input
          type="checkbox"
          checked={includeUntracked}
          onChange={(event) => setIncludeUntracked(event.target.checked)}
        />
        <span>{t("stash.create.includeUntracked")}</span>
      </label>
      {scopeKind === "paths" && excluded.length > 0 ? (
        <p className="text-[12px]" style={{ color: "var(--slate)" }}>
          {t("stash.create.untrackedExcluded", {
            count: excluded.length,
            paths: excluded.map((item) => item.path).join(", "),
          })}
        </p>
      ) : null}
    </TextActionDialog>
  );
}
