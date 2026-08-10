import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

export interface PaletteItem {
  id: string;
  label: string;
  detail: string;
  group?: string;
  run: () => void | Promise<void>;
}

export function CommandPalette({
  items,
  query,
  onQueryChange,
  onClose,
}: {
  items: PaletteItem[];
  query: string;
  onQueryChange: (value: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("workspace");
  const [index, setIndex] = useState(0);

  const scored = items
    .flatMap((item) => {
      const score = paletteScore(query, item.label, item.detail);
      return score === null ? [] : [{ item, score }];
    })
    .sort((a, b) => a.score - b.score)
    .map((entry) => entry.item);

  const visible = scored.slice(0, 12);

  useEffect(() => {
    setIndex(0);
  }, [query]);

  async function run(item: PaletteItem | undefined) {
    if (!item) return;
    onClose();
    await item.run();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[15vh]"
      style={{ background: "rgba(8, 12, 16, 0.45)" }}
      onMouseDown={onClose}
    >
      <div
        className="desktop-popover w-full max-w-xl overflow-hidden rounded-lg border"
        style={{
          borderWidth: "0.5px",
          borderColor: "var(--hairline-strong)",
          background: "var(--paper)",
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <input
          autoFocus
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setIndex((value) => Math.min(value + 1, Math.max(visible.length - 1, 0)));
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setIndex((value) => Math.max(value - 1, 0));
            }
            if (event.key === "Enter") {
              event.preventDefault();
              void run(visible[index]);
            }
          }}
          placeholder={t("commandPalette.placeholder")}
          className="h-11 w-full border-b px-4 text-[13px] outline-none"
          style={{
            borderBottomWidth: "0.5px",
            borderColor: "var(--hairline)",
            background: "var(--paper)",
            color: "var(--ink)",
          }}
        />

        {visible.length === 0 ? (
          <p className="px-4 py-3 text-[13px]" style={{ color: "var(--slate)" }}>
            {t("commandPalette.empty")}
          </p>
        ) : (
          <ul className="max-h-80 overflow-auto p-1.5">
            {visible.map((item, itemIndex) => {
              const isSelected = itemIndex === index;
              const previousGroup = visible[itemIndex - 1]?.group;

              return (
                <li key={item.id}>
                  {item.group && item.group !== previousGroup ? (
                    <p className="px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide" style={{ color: "var(--mist)" }}>
                      {item.group}
                    </p>
                  ) : null}
                  <button
                    type="button"
                    onMouseEnter={() => setIndex(itemIndex)}
                    onClick={() => void run(item)}
                    data-selected={isSelected}
                    className="interactive-row grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md px-2.5 py-1.5 text-left"
                    style={{
                      color: isSelected ? "var(--fjord-ink)" : "var(--ink)",
                    }}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-[13px]">{item.label}</span>
                      <span className="block truncate text-[11px]" style={{ color: "var(--mist)" }}>
                        {item.detail}
                      </span>
                    </span>
                    <span className="shrink-0 text-[10px]" style={{ color: "var(--mist)" }}>
                      {t("commandPalette.action")}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Subsequence match; lower score = better. Returns null when the query doesn't match. */
export function paletteScore(query: string, label: string, detail: string): number | null {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return 0;

  const haystack = `${label} ${detail}`.toLocaleLowerCase();
  const directIndex = haystack.indexOf(needle);
  if (directIndex >= 0) return directIndex;

  let cursor = 0;
  let distance = 0;
  for (const char of needle) {
    const found = haystack.indexOf(char, cursor);
    if (found < 0) return null;
    distance += found - cursor;
    cursor = found + 1;
  }

  return 1000 + distance;
}
