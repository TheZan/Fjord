import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";

import { isPrimaryShortcut } from "@/application/keyboardShortcut";
import { App } from "@/presentation/App";
import { ErrorBoundary } from "@/presentation/ErrorBoundary";
import { ThemeProvider } from "@/infrastructure/theme/ThemeProvider";
import { i18n, initI18n } from "@/infrastructure/i18n";
import { getSettings } from "@/infrastructure/tauriClient";
import { DEFAULT_LOCALE } from "@/locales/registry";
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
      (["KeyP", "KeyR", "KeyS", "KeyU"] as const).some((code) =>
        isPrimaryShortcut(event, code),
      ) ||
      (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight"));
    if (browserCommand) event.preventDefault();
  });
}

async function bootstrap() {
  installDesktopWebviewBehavior();
  // Resolve the initial locale before the first render so there's no
  // flash of the wrong language (docs/specs/i18n.md — locale detection).
  const locale = await getSettings()
    .then((settings) => settings.locale)
    .catch(() => DEFAULT_LOCALE);

  await initI18n(locale);

  createRoot(document.getElementById("root") as HTMLElement).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <I18nextProvider i18n={i18n}>
          <ThemeProvider>
            <ErrorBoundary>
              <App />
            </ErrorBoundary>
          </ThemeProvider>
        </I18nextProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}

bootstrap();
