import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";

import { App } from "@/presentation/App";
import { ThemeProvider } from "@/infrastructure/theme/ThemeProvider";
import { i18n, initI18n } from "@/infrastructure/i18n";
import { getSettings } from "@/infrastructure/tauriClient";
import { DEFAULT_LOCALE } from "@/locales/registry";
import "@/index.css";

const queryClient = new QueryClient();

async function bootstrap() {
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
            <App />
          </ThemeProvider>
        </I18nextProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}

bootstrap();
