import { useTranslation } from "react-i18next";
import type { WorkingFileTarget } from "@/domain/git";
import { TextActionDialog } from "@/presentation/GitContextMenu";

export function StashFileDialog({
  target,
  onClose,
  onConfirm,
}: {
  target: WorkingFileTarget;
  onClose: () => void;
  onConfirm: (message: string) => void;
}) {
  const { t } = useTranslation("workspace");
  return (
    <TextActionDialog
      title={t("workingFile.stashFile.title", { path: target.path })}
      description={t("workingFile.stashFile.stagedNotPreserved")}
      label={t("workingFile.stashFile.message")}
      initialValue={t("workingFile.stashFile.defaultMessage", { path: target.path })}
      confirmLabel={t("workingFile.stashFile.confirm")}
      onClose={onClose}
      onConfirm={onConfirm}
    />
  );
}
