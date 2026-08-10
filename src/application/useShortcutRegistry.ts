import { useEffect, useRef } from "react";
import {
  installShortcutRegistry,
  type ShortcutBinding,
  type ShortcutScope,
} from "@/application/shortcutRegistry";

/** Owns the app's single document-level keydown listener. */
export function useShortcutRegistry(
  bindings: ShortcutBinding[],
  activeScopes: ShortcutScope[],
): void {
  const bindingsRef = useRef(bindings);
  const scopesRef = useRef(activeScopes);
  bindingsRef.current = bindings;
  scopesRef.current = activeScopes;

  useEffect(
    () =>
      installShortcutRegistry({
        bindings: () => bindingsRef.current,
        getActiveScopes: () => scopesRef.current,
      }),
    [],
  );
}
