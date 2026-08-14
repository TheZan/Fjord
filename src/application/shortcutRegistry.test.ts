import { describe, expect, it, vi } from "vitest";
import {
  assertNoDuplicateShortcuts,
  dispatchShortcut,
  installShortcutRegistry,
  type ShortcutBinding,
} from "@/application/shortcutRegistry";

function binding(overrides: Partial<ShortcutBinding> = {}): ShortcutBinding {
  return {
    id: "palette",
    code: "KeyK",
    modifiers: { primary: true },
    scope: "global",
    handler: vi.fn(),
    ...overrides,
  };
}

function keydown(
  code: string,
  overrides: KeyboardEventInit & { target?: HTMLElement } = {},
): KeyboardEvent {
  const { target, ...init } = overrides;
  const event = new KeyboardEvent("keydown", { code, bubbles: true, cancelable: true, ...init });
  if (target) target.dispatchEvent(event);
  return event;
}

describe("shortcut registry", () => {
  it("resolves the most specific active scope", () => {
    const global = binding({ id: "global", handler: vi.fn() });
    const repository = binding({ id: "repository", scope: "repository", handler: vi.fn() });
    const dialog = binding({ id: "dialog", scope: "dialog", handler: vi.fn() });

    dispatchShortcut([global, repository, dialog], ["repository"], keydown("KeyK", { ctrlKey: true }));
    expect(repository.handler).toHaveBeenCalledOnce();
    expect(global.handler).not.toHaveBeenCalled();

    dispatchShortcut([global, repository, dialog], ["repository", "dialog"], keydown("KeyK", { ctrlKey: true }));
    expect(dialog.handler).toHaveBeenCalledOnce();
  });

  it("rejects duplicate physical bindings within one scope", () => {
    expect(() =>
      assertNoDuplicateShortcuts([binding({ id: "one" }), binding({ id: "two" })]),
    ).toThrow(/Duplicate shortcut.*one.*two/);
    expect(() =>
      assertNoDuplicateShortcuts([binding(), binding({ id: "repository", scope: "repository" })]),
    ).not.toThrow();
  });

  it("suppresses input-field shortcuts except Escape and commit", () => {
    const input = document.createElement("input");
    document.body.append(input);
    const palette = binding();
    const escape = binding({ id: "escape", code: "Escape", modifiers: {}, handler: vi.fn() });
    const commit = binding({ id: "commit", code: "Enter", handler: vi.fn() });

    dispatchShortcut([palette], [], keydown("KeyK", { ctrlKey: true, target: input }));
    dispatchShortcut([escape], [], keydown("Escape", { target: input }));
    dispatchShortcut([commit], [], keydown("Enter", { ctrlKey: true, target: input }));

    expect(palette.handler).not.toHaveBeenCalled();
    expect(escape.handler).toHaveBeenCalledOnce();
    expect(commit.handler).toHaveBeenCalledOnce();
    input.remove();
  });

  it("matches the physical code on a Cyrillic layout", () => {
    const open = binding();
    const event = new KeyboardEvent("keydown", {
      key: "л",
      code: "KeyK",
      ctrlKey: true,
      cancelable: true,
    });

    expect(dispatchShortcut([open], [], event)).toBe(true);
    expect(open.handler).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });

  it("installs and removes exactly one document listener", () => {
    const target = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const dispose = installShortcutRegistry({
      bindings: () => [binding()],
      getActiveScopes: () => [],
      target,
    });

    expect(target.addEventListener).toHaveBeenCalledOnce();
    expect(target.addEventListener).toHaveBeenCalledWith("keydown", expect.any(Function));
    dispose();
    expect(target.removeEventListener).toHaveBeenCalledWith(
      "keydown",
      target.addEventListener.mock.calls[0][1],
    );
  });
});
