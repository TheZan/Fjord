import { useState } from "react";

export function useCommandPaletteState() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  function openPalette() {
    setQuery("");
    setOpen(true);
  }

  function closePalette() {
    setOpen(false);
  }

  return {
    closePalette,
    open,
    openPalette,
    query,
    setQuery,
  };
}
