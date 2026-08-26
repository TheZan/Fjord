import { useTranslation } from "react-i18next";
import type { StashId } from "@/domain/git";
import { ContextMenu, type ContextMenuItem } from "@/presentation/GitContextMenu";

export interface StashContextMenuState {
  stashId: StashId;
  x: number;
  y: number;
}

export function StashContextMenu({
  state,
  onClose,
  onRevealInGraph,
}: {
  state: StashContextMenuState;
  onClose: () => void;
  onRevealInGraph?: (stashId: StashId) => void;
}) {
  const { t } = useTranslation("workspace");
  const items: ContextMenuItem[] = onRevealInGraph
    ? [{ id: "revealInGraph", label: t("stash.action.revealInGraph") }]
    : [];

  return (
    <ContextMenu
      position={state}
      ariaLabel={t("tree.stashes")}
      items={items}
      onClose={onClose}
      onSelect={(action) => {
        onClose();
        if (action === "revealInGraph") onRevealInGraph?.(state.stashId);
      }}
    />
  );
}
