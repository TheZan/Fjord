import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { isPrimaryShortcut } from "@/application/keyboardShortcut";
import type { GlobalSearchResult } from "@/domain/git";
import { globalSearch } from "@/infrastructure/tauriClient";
import type { PaletteItem } from "@/presentation/CommandPalette";

export function useCommandPaletteState({
  onSearchResult,
}: {
  onSearchResult: (result: GlobalSearchResult) => void;
}) {
  const { t } = useTranslation("workspace");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<GlobalSearchResult[]>([]);

  function openPalette() {
    setQuery("");
    setOpen(true);
  }

  function closePalette() {
    setOpen(false);
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (isPrimaryShortcut(event, "KeyK")) {
        event.preventDefault();
        openPalette();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const trimmed = query.trim();
    if (!open || trimmed.length < 2) {
      setSearchResults([]);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      globalSearch(trimmed, null, 20)
        .then((results) => {
          if (!cancelled) setSearchResults(results);
        })
        .catch(() => {
          if (!cancelled) setSearchResults([]);
        });
    }, 200);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, open]);

  const remoteItems: PaletteItem[] = useMemo(
    () =>
      searchResults
        .filter((result) => result.kind === "commit")
        .map((result, index) => ({
          id: `search:${result.repoId}:${result.commit?.id ?? index}`,
          label: result.commit?.message.split("\n")[0] ?? result.repoName,
          detail: `${result.repoName} · ${result.commit?.id.slice(0, 7) ?? ""}`,
          kind: t("commandPalette.commit"),
          run: () => onSearchResult(result),
        })),
    [onSearchResult, searchResults, t],
  );

  return {
    closePalette,
    open,
    openPalette,
    query,
    remoteItems,
    setQuery,
  };
}
