import { useRef } from "react";
import { useTranslation } from "react-i18next";
import type { ShortcutBinding } from "@/application/shortcutRegistry";
import { Button } from "@/presentation/ui";
import { useDialogFocusTrap } from "@/presentation/useDialogFocusTrap";

export function ShortcutHelpSheet({
  bindings,
  onClose,
}: {
  bindings: ShortcutBinding[];
  onClose: () => void;
}) {
  const { t } = useTranslation("workspace");
  const dialogRef = useRef<HTMLElement>(null);
  useDialogFocusTrap(dialogRef, onClose);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6" style={{ background: "rgba(8, 12, 16, 0.45)" }} onMouseDown={onClose}>
      <section
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcut-help-title"
        className="desktop-popover max-h-[80vh] w-full max-w-lg overflow-auto rounded-lg border p-4"
        style={{ borderColor: "var(--hairline-strong)", background: "var(--paper)" }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="mb-3 flex items-center justify-between gap-3">
          <h2 id="shortcut-help-title" className="text-base font-semibold">{t("shortcuts.title")}</h2>
          <Button size="sm" variant="ghost" onClick={onClose}>{t("shortcuts.close")}</Button>
        </header>
        <ul className="space-y-1">
          {bindings.map((binding) => (
            <li key={`${binding.scope}:${binding.id}`} className="flex items-center justify-between gap-4 py-1 text-[13px]">
              <span>{shortcutLabel(binding.id, t)}</span>
              <kbd className="rounded border px-1.5 py-0.5 text-[11px]" style={{ borderColor: "var(--hairline-strong)", color: "var(--slate)" }}>
                {formatShortcut(binding, {
                  primary: t("shortcuts.key.primary"),
                  alt: t("shortcuts.key.alt"),
                  shift: t("shortcuts.key.shift"),
                  escape: t("shortcuts.key.escape"),
                  enter: t("shortcuts.key.enter"),
                })}
              </kbd>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

interface ShortcutKeyLabels {
  primary: string;
  alt: string;
  shift: string;
  escape: string;
  enter: string;
}

export function formatShortcut(binding: ShortcutBinding, labels: ShortcutKeyLabels): string {
  const parts: string[] = [];
  if (binding.modifiers.primary) parts.push(labels.primary);
  if (binding.modifiers.alt) parts.push(labels.alt);
  if (binding.modifiers.shift) parts.push(labels.shift);
  parts.push(displayCode(binding.code, labels));
  return parts.join("+");
}

function displayCode(code: string, labels: ShortcutKeyLabels): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  return { Comma: ",", Slash: "/", Escape: labels.escape, Enter: labels.enter }[code] ?? code;
}

function shortcutLabel(id: string, t: (key: string, values?: Record<string, unknown>) => string): string {
  if (id.startsWith("workspace.switch.")) {
    return t("shortcuts.workspace", { number: id.split(".").at(-1) });
  }
  return t(`shortcuts.${id.replaceAll(".", "_")}`);
}
