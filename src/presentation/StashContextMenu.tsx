import { useTranslation } from "react-i18next";
import { buildStashMenuItems, type StashAction } from "@/application/stashActions";
import type { StashEntry } from "@/domain/git";
import { ContextMenu, type ContextMenuItem } from "@/presentation/GitContextMenu";

export interface StashContextMenuState {
  stash: StashEntry;
  x: number;
  y: number;
}

export function StashContextMenu({
  state,
  onClose,
  canRevealInGraph = false,
  onAction,
}: {
  state: StashContextMenuState;
  onClose: () => void;
  canRevealInGraph?: boolean;
  onAction: (action: StashAction, stash: StashEntry) => void;
}) {
  const { t } = useTranslation("workspace");
  const items: ContextMenuItem[] = buildStashMenuItems(canRevealInGraph).map((item) => ({
    id: item.id,
    label: t(item.labelKey),
    separatorBefore: item.separatorBefore,
    danger: item.danger,
  }));

  return (
    <ContextMenu
      position={state}
      ariaLabel={t("tree.stashes")}
      items={items}
      onClose={onClose}
      onSelect={(action) => {
        onClose();
        onAction(action as StashAction, state.stash);
      }}
    />
  );
}
