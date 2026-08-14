import { useTranslation } from "react-i18next";
import type { OperationControl, RepoOperation, RepoOperationState } from "@/domain/generated";
import { Button } from "@/presentation/ui";

const CONFLICT_SAMPLE_LIMIT = 5;

export function isOperationInProgress(operation: RepoOperation | null | undefined): boolean {
  return Boolean(
    operation &&
      operation.kind !== "normal" &&
      operation.kind !== "detached" &&
      operation.kind !== "unbornBranch",
  );
}

export function OperationBanner({
  state,
  validated,
  pendingControl,
  onControl,
  onOpenMergeTool,
}: {
  state: RepoOperationState | null;
  validated: boolean;
  pendingControl: OperationControl | null;
  onControl: (control: OperationControl) => void;
  onOpenMergeTool: () => void;
}) {
  const { t } = useTranslation("workspace");
  if (!state || state.operation.kind === "normal") return null;

  const operation = state.operation;
  const conflicts = state.conflictedPaths.slice(0, CONFLICT_SAMPLE_LIMIT);
  const remainingConflicts = state.conflictedPaths.length - conflicts.length;
  const busy = pendingControl !== null;

  return (
    <section
      aria-label={t("operationBanner.label")}
      className="rounded-lg border px-3 py-2.5 text-[13px]"
      style={{
        borderWidth: "0.5px",
        borderColor: "var(--amber)",
        background: "var(--amber-tint)",
        color: "var(--ink)",
      }}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium" style={{ color: "var(--amber-ink)" }}>
            <span aria-hidden="true">⚠ </span>
            {operationTitle(operation, t)}
          </div>
          <p className="mt-0.5 text-[12px]" style={{ color: "var(--slate)" }}>
            {state.detectedExternally
              ? t("operationBanner.external")
              : t("operationBanner.startedHere")}
          </p>
          {isOperationInProgress(operation) ? (
            <p className="mt-1 text-[11px]" style={{ color: "var(--mist)" }}>
              {t("operationBanner.blockedActions")}
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          {state.conflictedPaths.length > 0 ? (
            <Button
              size="sm"
              disabled={busy || !validated}
              title={!validated
                ? t("snapshot.validationFailed")
                : busy
                  ? t("operations.running")
                  : undefined}
              onClick={onOpenMergeTool}
            >
              {t("repoStatus.openMergeTool")}
            </Button>
          ) : null}
          {state.available.map((control) => (
            <Button
              key={control}
              size="sm"
              variant={
                control === "abort"
                  ? "danger"
                  : control === "continue"
                    ? "primary"
                    : "secondary"
              }
              disabled={busy || !validated}
              title={!validated
                ? t("snapshot.validationFailed")
                : busy
                  ? t("operations.running")
                  : undefined}
              onClick={() => onControl(control)}
            >
              {pendingControl === control
                ? t("operations.running")
                : t(`operationBanner.controls.${control}`)}
            </Button>
          ))}
        </div>
      </div>

      {conflicts.length > 0 ? (
        <div className="mt-2 border-t pt-2" style={{ borderColor: "var(--hairline)" }}>
          <div className="text-[11px] font-medium uppercase tracking-wide" style={{ color: "var(--rust-ink)" }}>
            {t("operationBanner.conflicts", { count: state.conflictedPaths.length })}
          </div>
          <ul className="mt-1 grid gap-0.5 font-mono text-[11px]" style={{ color: "var(--slate)" }}>
            {conflicts.map((path) => (
              <li key={path} className="truncate">{path}</li>
            ))}
          </ul>
          {remainingConflicts > 0 ? (
            <div className="mt-1 text-[11px]" style={{ color: "var(--mist)" }}>
              {t("operationBanner.moreConflicts", { count: remainingConflicts })}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function operationTitle(
  operation: RepoOperation,
  t: (key: string, values?: Record<string, unknown>) => string,
): string {
  switch (operation.kind) {
    case "merge":
      return t("operationBanner.states.merge", { count: operation.incoming.length });
    case "rebase":
      return t("operationBanner.states.rebase", {
        current: operation.current,
        total: operation.total,
        kind: t(`operationBanner.rebaseKinds.${operation.rebaseKind}`),
      });
    case "cherryPick":
      return t("operationBanner.states.cherryPick", { commit: operation.commit.slice(0, 7) });
    case "revert":
      return t("operationBanner.states.revert", { commit: operation.commit.slice(0, 7) });
    case "bisect":
      return t("operationBanner.states.bisect", { good: operation.good, bad: operation.bad });
    case "detached":
      return t("operationBanner.states.detached", { commit: operation.head.slice(0, 7) });
    case "unbornBranch":
      return t("operationBanner.states.unbornBranch");
    case "normal":
      return "";
  }
}
