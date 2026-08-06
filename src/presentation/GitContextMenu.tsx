import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { isPrimaryShortcut } from "@/application/keyboardShortcut";
import { Button, Input, Select } from "@/presentation/ui";

export interface ContextMenuItem {
  id: string;
  label: string;
  icon?: ContextMenuIcon;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  separatorBefore?: boolean;
}

export type ContextMenuIcon =
  | "branch"
  | "checkout"
  | "copy"
  | "delete"
  | "reset"
  | "revert"
  | "tag";

export function ContextMenu({
  position,
  items,
  onSelect,
  onClose,
}: {
  position: { x: number; y: number };
  items: ContextMenuItem[];
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [menuPosition, setMenuPosition] = useState(position);
  const [activeIndex, setActiveIndex] = useState(() => firstEnabledIndex(items));

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const bounds = menu.getBoundingClientRect();
    setMenuPosition({
      x: Math.max(8, Math.min(position.x, window.innerWidth - bounds.width - 8)),
      y: Math.max(8, Math.min(position.y, window.innerHeight - bounds.height - 8)),
    });
  }, [position]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => itemRefs.current[activeIndex]?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [activeIndex]);

  function moveActive(direction: 1 | -1) {
    if (items.every((item) => item.disabled)) return;
    let next = activeIndex;
    do {
      next = (next + direction + items.length) % items.length;
    } while (items[next].disabled);
    setActiveIndex(next);
  }

  return (
    <div className="fixed inset-0 z-50" onMouseDown={onClose}>
      <div
        ref={menuRef}
        role="menu"
        className="desktop-popover absolute min-w-52 overflow-hidden rounded-md border py-1"
        style={{
          left: menuPosition.x,
          top: menuPosition.y,
          background: "var(--paper)",
          borderColor: "var(--hairline-strong)",
        }}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          const shortcutItem = items.find(
            (item) => !item.disabled && item.shortcut && matchesMenuShortcut(event, item.shortcut),
          );
          if (shortcutItem) {
            event.preventDefault();
            onSelect(shortcutItem.id);
            return;
          }

          if (event.key === "ArrowDown") {
            event.preventDefault();
            moveActive(1);
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            moveActive(-1);
          } else if (event.key === "Home") {
            event.preventDefault();
            setActiveIndex(firstEnabledIndex(items));
          } else if (event.key === "End") {
            event.preventDefault();
            setActiveIndex(lastEnabledIndex(items));
          } else if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            const item = items[activeIndex];
            if (item && !item.disabled) onSelect(item.id);
          }
        }}
      >
        {items.map((item, index) => (
          <div key={item.id} className={item.separatorBefore ? "mt-1 border-t pt-1" : ""} style={item.separatorBefore ? { borderColor: "var(--hairline)" } : undefined}>
            <button
              ref={(element) => {
                itemRefs.current[index] = element;
              }}
              type="button"
              role="menuitem"
              tabIndex={index === activeIndex ? 0 : -1}
              disabled={item.disabled}
              className="interactive-row flex h-8 w-full items-center gap-2 px-2.5 text-left text-[13px] disabled:cursor-not-allowed disabled:opacity-40"
              style={{ color: item.danger ? "var(--rust-ink)" : "var(--ink)" }}
              onMouseEnter={() => {
                if (!item.disabled) setActiveIndex(index);
              }}
              onClick={() => {
                if (!item.disabled) onSelect(item.id);
              }}
            >
              <span className="flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden="true">
                {item.icon ? <MenuIcon kind={item.icon} /> : null}
              </span>
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.shortcut ? (
                <kbd className="shrink-0 font-mono text-[10px]" style={{ color: "var(--mist)" }}>
                  {item.shortcut}
                </kbd>
              ) : null}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function matchesMenuShortcut(event: ReactKeyboardEvent<HTMLDivElement>, shortcut: string) {
  if (shortcut === "Ctrl+C") return isPrimaryShortcut(event.nativeEvent, "KeyC");
  if (shortcut === "Ctrl+Enter") {
    return (
      (event.ctrlKey || event.metaKey) &&
      !event.altKey &&
      !event.shiftKey &&
      event.code === "Enter"
    );
  }
  return false;
}

function firstEnabledIndex(items: ContextMenuItem[]) {
  const index = items.findIndex((item) => !item.disabled);
  return index === -1 ? 0 : index;
}

function lastEnabledIndex(items: ContextMenuItem[]) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (!items[index].disabled) return index;
  }
  return 0;
}

function MenuIcon({ kind }: { kind: ContextMenuIcon }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {kind === "branch" ? <><path d="M4 2v11" /><path d="M4 5h4a3 3 0 0 0 3-3" /><circle cx="4" cy="13" r="1.5" /><circle cx="11" cy="2" r="1.5" /></> : null}
      {kind === "checkout" ? <><path d="M3 8h9" /><path d="m9 5 3 3-3 3" /><path d="M13.5 3.5v9" /></> : null}
      {kind === "copy" ? <><rect x="5" y="5" width="8" height="8" rx="1" /><path d="M3 11H2.5A1.5 1.5 0 0 1 1 9.5v-7A1.5 1.5 0 0 1 2.5 1h7A1.5 1.5 0 0 1 11 2.5V3" /></> : null}
      {kind === "delete" ? <><path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9h6.6l.7-9M6.5 6.5v4M9.5 6.5v4" /></> : null}
      {kind === "reset" ? <><path d="M3 5V2L1 4" /><path d="M3 3a6 6 0 1 1-1 7" /><path d="M8 5v3l2 1" /></> : null}
      {kind === "revert" ? <><path d="m5 4-3 3 3 3" /><path d="M2 7h7a4 4 0 0 1 4 4v2" /></> : null}
      {kind === "tag" ? <><path d="M2 2h5l7 7-5 5-7-7V2Z" /><circle cx="5" cy="5" r="1" /></> : null}
    </svg>
  );
}

export function TextActionDialog({
  title,
  description,
  label,
  initialValue = "",
  confirmLabel,
  onConfirm,
  onClose,
}: {
  title: string;
  description: string;
  label: string;
  initialValue?: string;
  confirmLabel: string;
  onConfirm: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <DialogFrame title={title} description={description} onClose={onClose}>
      <label className="flex flex-col gap-1.5 text-[13px]" style={{ color: "var(--slate)" }}>
        <span>{label}</span>
        <Input
          ref={inputRef}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && value.trim()) onConfirm(value.trim());
          }}
        />
      </label>
      <DialogActions
        confirmLabel={confirmLabel}
        disabled={!value.trim()}
        onConfirm={() => onConfirm(value.trim())}
        onClose={onClose}
      />
    </DialogFrame>
  );
}

export function ConfirmActionDialog({
  title,
  description,
  confirmLabel,
  danger = false,
  onConfirm,
  onClose,
  resetModes = false,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: (mode?: "soft" | "mixed" | "hard") => void;
  onClose: () => void;
  resetModes?: boolean;
}) {
  const [mode, setMode] = useState<"soft" | "mixed" | "hard">("mixed");
  const { t } = useTranslation("workspace");
  return (
    <DialogFrame title={title} description={description} onClose={onClose}>
      {resetModes && (
        <label className="flex flex-col gap-1.5 text-[13px]" style={{ color: "var(--slate)" }}>
          <span>{t("context.resetMode")}</span>
          <Select value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}>
            <option value="soft">{t("context.resetSoft")}</option>
            <option value="mixed">{t("context.resetMixed")}</option>
            <option value="hard">{t("context.resetHard")}</option>
          </Select>
        </label>
      )}
      <DialogActions
        confirmLabel={confirmLabel}
        danger={danger}
        onConfirm={() => onConfirm(resetModes ? mode : undefined)}
        onClose={onClose}
      />
    </DialogFrame>
  );
}

function DialogFrame({
  title,
  description,
  children,
  onClose,
}: {
  title: string;
  description: string;
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="desktop-popover w-full max-w-md rounded-lg border p-4"
        style={{ background: "var(--paper)", borderColor: "var(--hairline-strong)" }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 className="text-sm font-semibold" style={{ color: "var(--ink)" }}>{title}</h2>
        <p className="mt-1 text-[13px]" style={{ color: "var(--slate)" }}>{description}</p>
        <div className="mt-4 flex flex-col gap-4">{children}</div>
      </div>
    </div>
  );
}

function DialogActions({
  confirmLabel,
  disabled = false,
  danger = false,
  onConfirm,
  onClose,
}: {
  confirmLabel: string;
  disabled?: boolean;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("workspace");
  return (
    <div className="flex justify-end gap-2">
      <Button onClick={onClose}>{t("context.cancel")}</Button>
      <Button variant={danger ? "danger" : "primary"} disabled={disabled} onClick={onConfirm}>
        {confirmLabel}
      </Button>
    </div>
  );
}
