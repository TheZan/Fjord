import { fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { useDialogFocusTrap } from "@/presentation/useDialogFocusTrap";

function Dialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocusTrap(ref, onClose);
  return <div ref={ref} tabIndex={-1}><button>First</button><button>Last</button></div>;
}

describe("useDialogFocusTrap", () => {
  it("cycles focus, closes on Escape, and restores the invoking control", () => {
    const onClose = vi.fn();
    const view = render(<button>Invoker</button>);
    const invoker = screen.getByRole("button", { name: "Invoker" });
    invoker.focus();
    view.rerender(<><button>Invoker</button><Dialog onClose={onClose} /></>);
    const first = screen.getByRole("button", { name: "First" });
    const last = screen.getByRole("button", { name: "Last" });

    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    view.rerender(<button>Invoker</button>);
    expect(screen.getByRole("button", { name: "Invoker" })).toHaveFocus();
  });
});
