import { useEffect, useState } from "react";
import {
  listenOperationProgress,
  type OperationProgressEvent,
} from "@/infrastructure/tauriClient";

export function useOperationProgress() {
  const [operations, setOperations] = useState<Record<string, OperationProgressEvent>>({});

  useEffect(() => {
    let active = true;
    let cleanup: (() => void) | null = null;

    void listenOperationProgress((event) => {
      setOperations((current) => ({ ...current, [event.operationId]: event }));
    }).then((unlisten) => {
      if (active) {
        cleanup = unlisten;
      } else {
        unlisten();
      }
    });

    return () => {
      active = false;
      cleanup?.();
    };
  }, []);

  return operations;
}
