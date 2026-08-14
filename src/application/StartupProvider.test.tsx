import type { ReactNode } from "react";
import { act, render, screen } from "@testing-library/react";
import { useTranslation } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StartupProvider, useStartup } from "@/application/StartupProvider";
import type { Settings } from "@/domain/settings";
import { initI18n, setLocale } from "@/infrastructure/i18n";
import "@/index.css";

const ipc = vi.hoisted(() => ({
  activateAfterFirstPaint: vi.fn(),
  getSettings: vi.fn(),
}));

vi.mock("@/infrastructure/tauriClient", () => ipc);

const russianSettings: Settings = {
  locale: "ru",
  theme: "light",
  defaultIde: null,
  autoFetch: false,
  performanceDiagnostics: false,
  gitExecutablePath: null,
};

function Status() {
  const { activated } = useStartup();
  return <span>{activated ? "active" : "waiting"}</span>;
}

function LocalizedText() {
  const { t } = useTranslation();
  return <div>{t("errorBoundary.title")}</div>;
}

function renderStartup(children: ReactNode) {
  const root = document.createElement("div");
  root.id = "root";
  document.body.append(root);
  return render(
    <StartupProvider
      initialPreferences={{ locale: "en", theme: "light", performanceDiagnostics: false }}
    >
      {children}
    </StartupProvider>,
    { container: root },
  );
}

describe("startup fast path", () => {
  let paint: FrameRequestCallback;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      paint = callback;
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    ipc.activateAfterFirstPaint.mockResolvedValue(undefined);
    ipc.getSettings.mockResolvedValue(russianSettings);
    initI18n("en");
    await setLocale("en");
    document.documentElement.dataset.langPending = "true";
  });

  afterEach(() => {
    delete document.documentElement.dataset.langPending;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("orders the first-paint trace before runtime Git and watcher activation", async () => {
    const order: string[] = [];
    vi.spyOn(performance, "mark").mockImplementation((name) => {
      order.push(name);
      return {} as PerformanceMark;
    });
    ipc.activateAfterFirstPaint.mockImplementation(async () => {
      order.push("backend:git_and_watchers");
    });

    renderStartup(<Status />);

    expect(screen.getByText("waiting")).toBeInTheDocument();
    expect(ipc.activateAfterFirstPaint).not.toHaveBeenCalled();
    expect(ipc.getSettings).not.toHaveBeenCalled();

    await act(async () => {
      paint(16);
      await vi.runAllTimersAsync();
    });

    expect(screen.getByText("active")).toBeInTheDocument();
    expect(order.indexOf("fjord:startup:first_paint")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("fjord:startup:first_paint")).toBeLessThan(
      order.indexOf("backend:git_and_watchers"),
    );
  });

  it("never paints text in the bootstrap locale before the persisted locale is applied", async () => {
    renderStartup(<LocalizedText />);

    const english = screen.getByText("Something went wrong");
    expect(document.documentElement.dataset.langPending).toBe("true");
    expect(english).not.toBeVisible();

    await act(async () => {
      paint(16);
      await vi.runAllTimersAsync();
    });

    expect(screen.queryByText("Something went wrong")).not.toBeInTheDocument();
    expect(screen.getByText("Что-то пошло не так")).toBeVisible();
    expect(document.documentElement).not.toHaveAttribute("data-lang-pending");
  });
});
