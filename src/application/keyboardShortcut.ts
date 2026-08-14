type ShortcutKeyboardEvent = Pick<
  KeyboardEvent,
  "altKey" | "code" | "ctrlKey" | "key" | "metaKey" | "shiftKey"
>;

/** Matches a physical letter key, independent of the active keyboard layout. */
export function isPrimaryShortcut(
  event: ShortcutKeyboardEvent,
  code: string,
  modifiers: { alt?: boolean; shift?: boolean } = {},
) {
  return (
    (event.ctrlKey || event.metaKey) &&
    event.altKey === Boolean(modifiers.alt) &&
    event.shiftKey === Boolean(modifiers.shift) &&
    event.code === code
  );
}
