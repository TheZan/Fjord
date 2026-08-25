import { describe, expect, it } from "vitest";
import { formatRelativeTime } from "@/presentation/formatRelativeTime";

describe("formatRelativeTime", () => {
  it("uses the requested locale and chooses an appropriate relative unit", () => {
    const now = Date.parse("2026-08-25T12:00:00Z");

    expect(formatRelativeTime("2026-08-24T12:00:00Z", "en", now)).toBe("yesterday");
    expect(formatRelativeTime("2026-08-25T10:00:00Z", "de", now)).toContain("Stunden");
  });
});
