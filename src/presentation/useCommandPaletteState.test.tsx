import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useCommandPaletteState } from "@/presentation/useCommandPaletteState";

describe("useCommandPaletteState", () => {
  it("opens explicitly and clears the previous query", () => {
    const { result } = renderHook(() => useCommandPaletteState());
    act(() => result.current.setQuery("old query"));
    act(() => result.current.openPalette());

    expect(result.current.open).toBe(true);
    expect(result.current.query).toBe("");
  });

  it("closes without losing the query until the next open", () => {
    const { result } = renderHook(() => useCommandPaletteState());
    act(() => {
      result.current.openPalette();
      result.current.setQuery("fetch");
      result.current.closePalette();
    });
    expect(result.current.open).toBe(false);
    expect(result.current.query).toBe("fetch");
    act(() => result.current.openPalette());
    expect(result.current.query).toBe("");
  });
});
