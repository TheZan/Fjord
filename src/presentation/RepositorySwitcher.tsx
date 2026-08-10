import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { paletteScore } from "@/presentation/CommandPalette";

export interface RepositorySwitcherItem {
  id: string;
  label: string;
  detail: string;
  kind: "repository" | "workspace";
  recency: number;
  run: () => void | Promise<void>;
}

export function RepositorySwitcher({
  items,
  query,
  onQueryChange,
  onClose,
}: {
  items: RepositorySwitcherItem[];
  query: string;
  onQueryChange: (value: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("workspace");
  const [index, setIndex] = useState(0);
  const visible = rankRepositorySwitcherItems(items, query).slice(0, 12);

  useEffect(() => setIndex(0), [query]);

  async function run(item: RepositorySwitcherItem | undefined) {
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
        style={{ borderWidth: "0.5px", borderColor: "var(--hairline-strong)", background: "var(--paper)" }}
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
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              setIndex((value) => Math.min(value + 1, Math.max(visible.length - 1, 0)));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setIndex((value) => Math.max(value - 1, 0));
            } else if (event.key === "Enter") {
              event.preventDefault();
              void run(visible[index]);
            }
          }}
          placeholder={t("repositorySwitcher.placeholder")}
          className="h-11 w-full border-b px-4 text-[13px] outline-none"
          style={{ borderBottomWidth: "0.5px", borderColor: "var(--hairline)", background: "var(--paper)", color: "var(--ink)" }}
        />
        {visible.length === 0 ? (
          <p className="px-4 py-3 text-[13px]" style={{ color: "var(--slate)" }}>
            {t("repositorySwitcher.empty")}
          </p>
        ) : (
          <ul className="max-h-80 overflow-auto p-1.5">
            {visible.map((item, itemIndex) => (
              <li key={item.id}>
                <button
                  type="button"
                  onMouseEnter={() => setIndex(itemIndex)}
                  onClick={() => void run(item)}
                  data-selected={itemIndex === index}
                  className="interactive-row grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md px-2.5 py-1.5 text-left"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[13px]">{item.label}</span>
                    <span className="block truncate text-[11px]" style={{ color: "var(--mist)" }}>{item.detail}</span>
                  </span>
                  <span className="text-[10px]" style={{ color: "var(--mist)" }}>
                    {t(`repositorySwitcher.${item.kind}`)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function rankRepositorySwitcherItems(
  items: RepositorySwitcherItem[],
  query: string,
): RepositorySwitcherItem[] {
  return items
    .flatMap((item) => {
      const score = paletteScore(query, item.label, item.detail);
      return score === null ? [] : [{ item, score }];
    })
    .sort((left, right) => right.item.recency - left.item.recency || left.score - right.score)
    .map(({ item }) => item);
}
