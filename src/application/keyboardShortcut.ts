type ShortcutKeyboardEvent = Pick<
  KeyboardEvent,
  "altKey" | "code" | "ctrlKey" | "key" | "metaKey" | "shiftKey"
>;

/** Matches a physical letter key, independent of the active keyboard layout. */
export function isPrimaryShortcut(
  event: ShortcutKeyboardEvent,
  code: `Key${Uppercase<string>}`,
) {
  return (
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.code === code
  );
}
