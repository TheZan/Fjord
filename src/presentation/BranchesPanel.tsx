import { useTranslation } from "react-i18next";
import { useBranches } from "@/application/useBranches";

export function BranchesPanel({ repoId }: { repoId: string }) {
  const { t } = useTranslation("workspace");
  const { branches, loading, error } = useBranches(repoId);

  const local = branches.filter((b) => !b.isRemote);
  const remote = branches.filter((b) => b.isRemote);

  if (loading) return null;
  if (error) {
    return (
      <p className="text-sm" style={{ color: "var(--rust-ink)" }}>
        {error}
      </p>
    );
  }
  if (branches.length === 0) {
    return (
      <p className="text-sm" style={{ color: "var(--slate)" }}>
        {t("branches.empty")}
      </p>
    );
  }

  return (
    <div
      className="w-full max-w-sm rounded-lg border p-3 text-sm"
      style={{ borderColor: "var(--hairline)", background: "var(--paper)" }}
    >
      <BranchGroup label={t("branches.local")} branches={local} currentLabel={t("branches.current")} />
      {remote.length > 0 && (
        <BranchGroup label={t("branches.remote")} branches={remote} currentLabel={t("branches.current")} />
      )}
    </div>
  );
}

function BranchGroup({
  label,
  branches,
  currentLabel,
}: {
  label: string;
  branches: { name: string; isCurrent: boolean }[];
  currentLabel: string;
}) {
  if (branches.length === 0) return null;
  return (
    <div className="mb-2 last:mb-0">
      <div className="mb-1 text-xs font-medium uppercase tracking-wide" style={{ color: "var(--mist)" }}>
        {label}
      </div>
      <ul className="flex flex-col gap-0.5">
        {branches.map((branch) => (
          <li
            key={branch.name}
            className="flex items-center justify-between rounded px-2 py-1"
            style={branch.isCurrent ? { background: "var(--fjord-tint)", color: "var(--fjord-ink)" } : undefined}
          >
            <code className="font-mono text-xs">{branch.name}</code>
            {branch.isCurrent && (
              <span className="text-xs" style={{ color: "var(--fjord-ink)" }}>
                {currentLabel}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
