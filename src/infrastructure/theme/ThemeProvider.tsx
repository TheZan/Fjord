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

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Default to "system" while settings are still loading, so there's no
  // flash of an arbitrary theme before the first paint settles.
  const [choice, setChoiceState] = useState<Theme>("system");
  const [effective, setEffective] = useState<EffectiveTheme>(() => resolve("system"));

  useEffect(() => {
    applyToDocument(effective);
  }, [effective]);

  useEffect(() => {
    getSettings().then((settings) => {
      setChoiceState(settings.theme);
      setEffective(resolve(settings.theme));
    });
  }, []);

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
