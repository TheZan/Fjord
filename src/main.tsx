import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";

import { isPrimaryShortcut } from "@/application/keyboardShortcut";
import { App } from "@/presentation/App";
import { resolveTheme, StartupProvider } from "@/application/StartupProvider";
import { ErrorBoundary } from "@/presentation/ErrorBoundary";
import { ThemeProvider } from "@/infrastructure/theme/ThemeProvider";
import { i18n, initI18n } from "@/infrastructure/i18n";
import { readStartupPreferences } from "@/infrastructure/startupPreferences";
import {
  InteractionPerformanceBoundary,
  installInteractionCapture,
  setInteractionDiagnosticsEnabled,
} from "@/presentation/performance";
import "@/index.css";

const queryClient = new QueryClient();

function installDesktopWebviewBehavior() {
  document.addEventListener("contextmenu", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("input, textarea, [contenteditable='true'], [data-native-context-menu='true']")) {
      return;
    }
    event.preventDefault();
  });

  document.addEventListener("dragstart", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest("[draggable='true']")) event.preventDefault();
  });

  window.addEventListener("keydown", (event) => {
    const browserCommand =
      event.key === "F5" ||
      (["KeyF", "KeyP", "KeyR", "KeyS", "KeyU"] as const).some((code) =>
        isPrimaryShortcut(event, code),
      ) ||
      (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight"));
    if (browserCommand) event.preventDefault();
  });
}

function bootstrap() {
  installDesktopWebviewBehavior();
  const initialPreferences = readStartupPreferences();
  document.documentElement.dataset.langPending = "true";
  document.documentElement.dataset.theme = resolveTheme(initialPreferences.theme);
  setInteractionDiagnosticsEnabled(initialPreferences.performanceDiagnostics);
  installInteractionCapture();
  initI18n(initialPreferences.locale);
  performance.mark("fjord:startup:shell_render");

  createRoot(document.getElementById("root") as HTMLElement).render(
    <StrictMode>
      <StartupProvider initialPreferences={initialPreferences}>
        <QueryClientProvider client={queryClient}>
          <I18nextProvider i18n={i18n}>
            <ThemeProvider initialChoice={initialPreferences.theme}>
              <ErrorBoundary>
                <InteractionPerformanceBoundary>
                  <App />
                </InteractionPerformanceBoundary>
              </ErrorBoundary>
            </ThemeProvider>
          </I18nextProvider>
        </QueryClientProvider>
      </StartupProvider>
    </StrictMode>,
  );
}

bootstrap();
