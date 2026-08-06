import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input, Select } from "@/presentation/ui";

export interface ContextMenuItem {
  id: string;
  label: string;
  disabled?: boolean;
  danger?: boolean;
  separatorBefore?: boolean;
}

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
  const [menuPosition, setMenuPosition] = useState(position);

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

  return (
    <div className="fixed inset-0 z-50" onMouseDown={onClose}>
      <div
        ref={menuRef}
        role="menu"
        className="absolute min-w-52 overflow-hidden rounded-md border py-1 shadow-xl"
        style={{
          left: menuPosition.x,
          top: menuPosition.y,
          background: "var(--paper)",
          borderColor: "var(--hairline-strong)",
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {items.map((item) => (
          <div key={item.id} className={item.separatorBefore ? "mt-1 border-t pt-1" : ""} style={item.separatorBefore ? { borderColor: "var(--hairline)" } : undefined}>
            <button
              type="button"
              role="menuitem"
              disabled={item.disabled}
              className="interactive-row flex h-8 w-full items-center px-3 text-left text-[13px] disabled:cursor-not-allowed disabled:opacity-40"
              style={{ color: item.danger ? "var(--rust-ink)" : "var(--ink)" }}
              onClick={() => {
                if (!item.disabled) onSelect(item.id);
              }}
            >
              {item.label}
            </button>
          </div>
        ))}
      </div>
    </div>
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
        className="w-full max-w-md rounded-lg border p-4 shadow-2xl"
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
