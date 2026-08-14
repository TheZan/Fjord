import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

export interface OverflowMenuItem {
  id: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  disabledReason?: string;
  danger?: boolean;
}

export function OverflowMenu({
  label,
  items,
  trigger,
}: {
  label: string;
  items: OverflowMenuItem[];
  trigger?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    return () => window.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  function focusItem(requestedIndex: number, direction: 1 | -1) {
    if (items.length === 0) return;
    let index = requestedIndex;
    for (let attempts = 0; attempts < items.length; attempts += 1) {
      index = (index + items.length) % items.length;
      if (!items[index].disabled) {
        itemRefs.current[index]?.focus();
        return;
      }
      index += direction;
    }
  }

  function openAndFocus(direction: 1 | -1) {
    setOpen(true);
    queueMicrotask(() => focusItem(direction === 1 ? 0 : items.length - 1, direction));
  }

  function onTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      openAndFocus(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      openAndFocus(-1);
    }
  }

  function onItemKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      focusItem(index + direction, direction);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const direction = event.key === "Home" ? 1 : -1;
      focusItem(direction === 1 ? 0 : items.length - 1, direction);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    }
  }

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={onTriggerKeyDown}
        className="interactive-control flex h-8 w-8 items-center justify-center rounded-md text-sm"
        style={{ color: "var(--slate)" }}
      >
        {trigger ?? <span aria-hidden="true">•••</span>}
      </button>

      {open ? (
        <div
          id={menuId}
          role="menu"
          className="desktop-popover absolute right-0 top-full z-40 mt-1 min-w-44 rounded-md border py-1"
          style={{
            borderWidth: "0.5px",
            borderColor: "var(--hairline-strong)",
            background: "var(--paper)",
          }}
        >
          {items.map((item, index) => (
            <button
              key={item.id}
              ref={(element) => {
                itemRefs.current[index] = element;
              }}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              title={item.disabled ? item.disabledReason : undefined}
              onClick={() => {
                item.onSelect();
                setOpen(false);
                triggerRef.current?.focus();
              }}
              onKeyDown={(event) => onItemKeyDown(event, index)}
              className="interactive-row block w-full px-3 py-1.5 text-left text-xs disabled:opacity-45"
              style={{ color: item.danger ? "var(--rust-ink)" : "var(--ink)" }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
