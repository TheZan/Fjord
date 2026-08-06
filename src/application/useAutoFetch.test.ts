import { describe, expect, it } from "vitest";
import { autoFetchRetryDelay } from "@/application/useAutoFetch";

describe("autoFetchRetryDelay", () => {
  it("backs off failures and caps the delay", () => {
    expect(autoFetchRetryDelay(1)).toBe(60_000);
    expect(autoFetchRetryDelay(3)).toBe(240_000);
    expect(autoFetchRetryDelay(20)).toBe(600_000);
  });
});
