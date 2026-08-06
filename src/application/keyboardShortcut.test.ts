import { describe, expect, it } from "vitest";
import { isPrimaryShortcut } from "@/application/keyboardShortcut";

describe("isPrimaryShortcut", () => {
  it("uses the physical key code instead of the current layout character", () => {
    expect(
      isPrimaryShortcut(
        { code: "KeyK", key: "л", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false },
        "KeyK",
      ),
    ).toBe(true);
  });

  it("rejects extra modifiers", () => {
    expect(
      isPrimaryShortcut(
        { code: "KeyK", key: "k", ctrlKey: true, metaKey: false, altKey: false, shiftKey: true },
        "KeyK",
      ),
    ).toBe(false);
  });

  it("recognizes find on a non-Latin layout", () => {
    expect(
      isPrimaryShortcut(
        { code: "KeyF", key: "а", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false },
        "KeyF",
      ),
    ).toBe(true);
  });
});
