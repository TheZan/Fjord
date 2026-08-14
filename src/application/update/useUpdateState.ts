import { useSyncExternalStore } from "react";
import { updateCoordinator } from "@/application/update/UpdateCoordinator";
import type { UpdateSnapshot } from "@/application/update/updateModel";

export function useUpdateState(): UpdateSnapshot {
  return useSyncExternalStore(updateCoordinator.subscribe, updateCoordinator.getSnapshot);
}
