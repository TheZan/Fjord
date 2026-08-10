// See docs/specs/theming.md. `choice` is what's persisted; `effective` is
// what's actually applied — resolved from `choice` plus (when `choice` is
// "system") both the WebView's own matchMedia signal and Tauri's native
// window theme-change event, so the OS-native window chrome and the
// WebView content never disagree.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useStartup } from "@/application/StartupProvider";
import type { Theme } from "@/domain/settings";
import { getSettings, updateSettings } from "@/infrastructure/tauriClient";

type EffectiveTheme = "light" | "dark";

interface ThemeContextValue {
  choice: Theme;
  effective: EffectiveTheme;
  setChoice: (choice: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function resolveSystemPreference(): EffectiveTheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function resolve(choice: Theme): EffectiveTheme {
  return choice === "system" ? resolveSystemPreference() : choice;
}

function applyToDocument(effective: EffectiveTheme) {
  document.documentElement.dataset.theme = effective;
}

export function ThemeProvider({
  children,
  initialChoice = "system",
}: {
  children: ReactNode;
  initialChoice?: Theme;
}) {
  const { settings } = useStartup();
  const [choice, setChoiceState] = useState<Theme>(initialChoice);
  const [effective, setEffective] = useState<EffectiveTheme>(() => resolve(initialChoice));

  useEffect(() => {
    applyToDocument(effective);
  }, [effective]);

  useEffect(() => {
    if (!settings) return;
    setChoiceState(settings.theme);
    setEffective(resolve(settings.theme));
  }, [settings]);

  useEffect(() => {
    if (choice !== "system") return;

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onMediaChange = () => setEffective(resolveSystemPreference());
    media.addEventListener("change", onMediaChange);

    const unlistenPromise = getCurrentWindow().onThemeChanged(() => {
      setEffective(resolveSystemPreference());
    });

    return () => {
      media.removeEventListener("change", onMediaChange);
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [choice]);

  const setChoice = useCallback((next: Theme) => {
    setChoiceState(next);
    setEffective(resolve(next));
    getSettings().then((current) => updateSettings({ ...current, theme: next }));
  }, []);

  const value = useMemo(() => ({ choice, effective, setChoice }), [choice, effective, setChoice]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}
