import { afterEach, describe, expect, it } from "vitest";
import {
  beginInteraction,
  currentInteraction,
  installInteractionCapture,
  setInteractionDiagnosticsEnabled,
} from "@/presentation/performance";

describe("interaction ids", () => {
  afterEach(() => setInteractionDiagnosticsEnabled(false));

  it("mints a unique session id at the input event and closes the event scope", async () => {
    setInteractionDiagnosticsEnabled(true);
    const first = beginInteraction(new Event("click"));
    const second = beginInteraction(new Event("keydown"));

    expect(first).toMatch(/^[a-zA-Z0-9]+:1$/);
    expect(second).toMatch(/^[a-zA-Z0-9]+:2$/);
    expect(currentInteraction()).toBe(second);
    await Promise.resolve();
    expect(currentInteraction()).toBeNull();
  });

  it("captures document input before the target handler runs", () => {
    setInteractionDiagnosticsEnabled(true);
    const uninstall = installInteractionCapture();
    let seenInHandler: string | null = null;
    const button = document.createElement("button");
    button.addEventListener("click", () => {
      seenInHandler = currentInteraction();
    });
    document.body.append(button);

    button.click();

    expect(seenInHandler).toMatch(/^[a-zA-Z0-9]+:\d+$/);
    uninstall();
    button.remove();
  });

  it("does no work while diagnostics are disabled", () => {
    setInteractionDiagnosticsEnabled(false);
    expect(beginInteraction(new Event("click"))).toBeNull();
    expect(currentInteraction()).toBeNull();
  });
});
