import { isPrimaryShortcut } from "@/application/keyboardShortcut";

export type ShortcutScope = "global" | "repository" | "dialog";

export interface ShortcutModifiers {
  primary?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export interface ShortcutBinding {
  id: string;
  code: string;
  modifiers: ShortcutModifiers;
  scope: ShortcutScope;
  handler: () => void;
}

const SCOPE_PRIORITY: ShortcutScope[] = ["dialog", "repository", "global"];

export function assertNoDuplicateShortcuts(bindings: ShortcutBinding[]): void {
  const seen = new Map<string, string>();
  for (const binding of bindings) {
    const signature = shortcutSignature(binding);
    const duplicate = seen.get(signature);
    if (duplicate) {
      throw new Error(
        `Duplicate shortcut in ${binding.scope} scope: ${duplicate} and ${binding.id}`,
      );
    }
    seen.set(signature, binding.id);
  }
}

export function dispatchShortcut(
  bindings: ShortcutBinding[],
  activeScopes: ShortcutScope[],
  event: KeyboardEvent,
): boolean {
  if (event.defaultPrevented) return false;
  const active = new Set<ShortcutScope>(["global", ...activeScopes]);
  const binding = SCOPE_PRIORITY.filter((scope) => active.has(scope))
    .flatMap((scope) => bindings.filter((candidate) => candidate.scope === scope))
    .find((candidate) => matchesShortcut(candidate, event));
  if (!binding || (isEditableTarget(event.target) && !isAllowedInEditable(binding))) return false;

  event.preventDefault();
  binding.handler();
  return true;
}

export function installShortcutRegistry({
  bindings,
  getActiveScopes,
  target = document,
}: {
  bindings: () => ShortcutBinding[];
  getActiveScopes: () => ShortcutScope[];
  target?: Pick<Document, "addEventListener" | "removeEventListener">;
}): () => void {
  if (import.meta.env.DEV) assertNoDuplicateShortcuts(bindings());
  const onKeyDown = (event: Event) => {
    const keyboardEvent = event as KeyboardEvent;
    const currentBindings = bindings();
    if (import.meta.env.DEV) assertNoDuplicateShortcuts(currentBindings);
    dispatchShortcut(currentBindings, getActiveScopes(), keyboardEvent);
  };
  target.addEventListener("keydown", onKeyDown);
  return () => target.removeEventListener("keydown", onKeyDown);
}

function shortcutSignature(binding: ShortcutBinding): string {
  const { primary = false, shift = false, alt = false } = binding.modifiers;
  return `${binding.scope}:${binding.code}:${primary}:${shift}:${alt}`;
}

function matchesShortcut(binding: ShortcutBinding, event: KeyboardEvent): boolean {
  const { primary = false, shift = false, alt = false } = binding.modifiers;
  if (primary) return isPrimaryShortcut(event, binding.code, { shift, alt });
  return (
    !event.ctrlKey &&
    !event.metaKey &&
    event.shiftKey === shift &&
    event.altKey === alt &&
    event.code === binding.code
  );
}

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(target.closest("input, textarea, select, [contenteditable='true']"))
  );
}

function isAllowedInEditable(binding: ShortcutBinding): boolean {
  if (binding.code === "Escape" && !binding.modifiers.primary) return true;
  return binding.id === "commit" && binding.code === "Enter" && binding.modifiers.primary === true;
}
