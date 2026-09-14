import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { StashEntry } from "@/domain/git";
import { TextActionDialog } from "@/presentation/GitContextMenu";

export function CreateBranchFromStashDialog({
  stash,
  onClose,
  onConfirm,
}: {
  stash: StashEntry;
  onClose: () => void;
  onConfirm: (name: string, apply: boolean) => void;
}) {
  const { t } = useTranslation("workspace");
  const [apply, setApply] = useState(true);
  return (
    <TextActionDialog
      title={t("stash.branch.title")}
      description={t("stash.branch.description", { base: stash.base.slice(0, 7) })}
      label={t("stash.branch.name")}
      initialValue={suggestedBranchName(stash.title)}
      confirmLabel={t("stash.branch.confirm")}
      onClose={onClose}
      onConfirm={(name) => onConfirm(name, apply)}
    >
      <p className="text-[12px]" style={{ color: "var(--slate)" }}>
        {t("stash.branch.base", { base: stash.base.slice(0, 7) })}
      </p>
      <label className="flex items-center gap-2 text-[13px]" style={{ color: "var(--slate)" }}>
        <input
          type="checkbox"
          checked={apply}
          onChange={(event) => setApply(event.target.checked)}
        />
        {t("stash.branch.applyAfterCheckout")}
      </label>
      <p className="text-[12px]" style={{ color: "var(--slate)" }}>
        {t("stash.branch.kept")}
      </p>
    </TextActionDialog>
  );
}

function suggestedBranchName(title: string) {
  const slug = title
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug ? `feature/${slug}` : "feature/stash-work";
}
