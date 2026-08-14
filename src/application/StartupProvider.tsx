import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Settings, Theme } from "@/domain/settings";
import { setLocale } from "@/infrastructure/i18n";
import { activateAfterFirstPaint, getSettings } from "@/infrastructure/tauriClient";
import { setInteractionDiagnosticsEnabled } from "@/presentation/performance";

export interface StartupPreferences {
  locale: string;
  theme: Theme;
  performanceDiagnostics: boolean;
}

interface StartupContextValue {
  activated: boolean;
  settings: Settings | null;
}

// Isolated component and hook tests do not need to model desktop startup.
// The real application always supplies StartupProvider, whose initial value
// deliberately keeps every workspace/Git query disabled until first paint.
const StartupContext = createContext<StartupContextValue>({
  activated: true,
  settings: null,
});

export function scheduleAfterFirstPaint(callback: () => void): () => void {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const frameId = requestAnimationFrame(() => {
    timeoutId = setTimeout(callback, 0);
  });
  return () => {
    cancelAnimationFrame(frameId);
    if (timeoutId !== null) clearTimeout(timeoutId);
  };
}

function markStartup(phase: string) {
  performance.mark(`fjord:startup:${phase}`);
}

export function StartupProvider({
  children,
  initialPreferences,
}: {
  children: ReactNode;
  initialPreferences: StartupPreferences;
}) {
  const [activated, setActivated] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [localeReady, setLocaleReady] = useState(false);
  const activationStarted = useRef(false);

  useEffect(() => {
    return scheduleAfterFirstPaint(() => {
      if (activationStarted.current) return;
      activationStarted.current = true;
      markStartup("first_paint");

      // Queries may start now: even their cached-status refresh is safely on
      // the far side of the first paint boundary.
      setActivated(true);
      markStartup("runtime_activation_requested");
      void activateAfterFirstPaint().catch(() => undefined);

      void getSettings()
        .then(async (resolved) => {
          setInteractionDiagnosticsEnabled(resolved.performanceDiagnostics);
          document.documentElement.dataset.theme = resolveTheme(resolved.theme);
          await setLocale(resolved.locale);
          setSettings(resolved);
        })
        .catch(() => {
          setInteractionDiagnosticsEnabled(initialPreferences.performanceDiagnostics);
        })
        .finally(() => {
          // Until locale resolution, CSS paints a text-free structural shell.
          // Revealing happens in-place; the React root and App never remount.
          delete document.documentElement.dataset.langPending;
          setLocaleReady(true);
          markStartup("locale_revealed");
        });
    });
  }, [initialPreferences.performanceDiagnostics]);

  const value = useMemo(() => ({ activated, settings }), [activated, settings]);
  return (
    <StartupContext.Provider value={value}>
      <div
        data-startup-content
        aria-hidden={!localeReady}
        style={{ display: "contents", visibility: localeReady ? "visible" : "hidden" }}
      >
        {children}
      </div>
    </StartupContext.Provider>
  );
}

export function useStartup(): StartupContextValue {
  return useContext(StartupContext);
}

export function resolveTheme(choice: Theme): "light" | "dark" {
  return choice === "system"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light"
    : choice;
}
