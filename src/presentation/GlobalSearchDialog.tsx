import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { GlobalSearchResult } from "@/domain/git";
import { globalSearch } from "@/infrastructure/tauriClient";
import { useDialogFocusTrap } from "@/presentation/useDialogFocusTrap";

export function GlobalSearchDialog({
  onSelect,
  onClose,
}: {
  onSelect: (result: GlobalSearchResult) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("workspace");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GlobalSearchResult[]>([]);
  const [index, setIndex] = useState(0);
  const dialogRef = useRef<HTMLElement>(null);
  useDialogFocusTrap(dialogRef, onClose);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void globalSearch(trimmed, null, 20)
        .then((next) => {
          if (!cancelled) setResults(next);
        })
        .catch(() => {
          if (!cancelled) setResults([]);
        });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  function select(result: GlobalSearchResult | undefined) {
    if (!result) return;
    onClose();
    onSelect(result);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[15vh]" style={{ background: "rgba(8, 12, 16, 0.45)" }} onMouseDown={onClose}>
      <section ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t("globalSearch.title")} className="desktop-popover w-full max-w-xl overflow-hidden rounded-lg border" style={{ borderColor: "var(--hairline-strong)", background: "var(--paper)" }} onMouseDown={(event) => event.stopPropagation()}>
        <input
          autoFocus
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setIndex(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setIndex((current) => Math.min(current + 1, Math.max(results.length - 1, 0)));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setIndex((current) => Math.max(current - 1, 0));
            } else if (event.key === "Enter") {
              event.preventDefault();
              select(results[index]);
            }
          }}
          placeholder={t("globalSearch.placeholder")}
          className="h-11 w-full border-b px-4 text-[13px] outline-none"
          style={{ borderColor: "var(--hairline)", background: "var(--paper)" }}
        />
        {results.length === 0 ? (
          <p className="px-4 py-3 text-[13px]" style={{ color: "var(--slate)" }}>{t(query.trim().length < 2 ? "globalSearch.hint" : "globalSearch.empty")}</p>
        ) : (
          <ul className="max-h-80 overflow-auto p-1.5">
            {results.map((result, resultIndex) => (
              <li key={`${result.kind}:${result.repoId}:${result.branch ?? result.commit?.id ?? result.repoPath}`}>
                <button type="button" data-selected={resultIndex === index} onMouseEnter={() => setIndex(resultIndex)} onClick={() => select(result)} className="interactive-row grid w-full grid-cols-[minmax(0,1fr)_auto] gap-3 rounded-md px-2.5 py-1.5 text-left">
                  <span className="min-w-0">
                    <span className="block truncate text-[13px]">{resultLabel(result)}</span>
                    <span className="block truncate text-[11px]" style={{ color: "var(--mist)" }}>{result.repoName}</span>
                  </span>
                  <span className="text-[10px]" style={{ color: "var(--mist)" }}>{t(`globalSearch.kind.${result.kind}`)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function resultLabel(result: GlobalSearchResult): string {
  if (result.kind === "commit") return result.commit?.message.split("\n")[0] ?? result.repoName;
  if (result.kind === "branch") return result.branch ?? result.repoName;
  return result.repoName;
}
