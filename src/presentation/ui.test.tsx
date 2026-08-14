import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Card, ScreenSurface, Surface } from "@/presentation/ui";

describe("shell surface density", () => {
  it.each(["overview", "repository"] as const)(
    "keeps the %s screen at one visual border level",
    (screen) => {
      const { container } = render(
        <ScreenSurface screen={screen}>
          <Surface>
            <Card>Nested content</Card>
          </Surface>
        </ScreenSurface>,
      );
      const root = container.querySelector(`[data-screen="${screen}"]`)!;

      expect(root.querySelector('[data-border-level="1"]')).not.toBeInTheDocument();
      expect(root.querySelector(".border .border")).not.toBeInTheDocument();
      expect(root.querySelectorAll("[data-ui-surface]")).toHaveLength(2);
    },
  );
});
