import { useTranslation } from "react-i18next";
import { useTheme } from "@/infrastructure/theme/ThemeProvider";
import { setLocale } from "@/infrastructure/i18n";
import { SUPPORTED_LOCALES } from "@/locales/registry";
import type { Theme } from "@/domain/settings";
import { FjordMark } from "@/presentation/FjordMark";
import { useRepositories } from "@/application/useRepositories";

const THEME_CHOICES: Theme[] = ["light", "dark", "system"];

export function App() {
  const { t, i18n } = useTranslation();
  const { t: tw } = useTranslation("workspace");
  const { choice, setChoice } = useTheme();
  const { repositories, error, openRepository } = useRepositories();

  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-8 px-6">
      <div className="text-center">
        <FjordMark size={32} className="mx-auto mb-3" style={{ color: "var(--brand)" }} />
        <h1 className="text-2xl font-medium" style={{ color: "var(--ink)" }}>
          {t("app.title")}
        </h1>
        <p className="mt-2 text-sm" style={{ color: "var(--slate)" }}>
          {t("app.tagline")}
        </p>
      </div>

      <div className="flex flex-col items-center gap-3">
        <span className="text-xs font-medium uppercase tracking-wide" style={{ color: "var(--mist)" }}>
          {t("settings.theme.label")}
        </span>
        <div className="flex gap-2">
          {THEME_CHOICES.map((themeChoice) => (
            <button
              key={themeChoice}
              type="button"
              onClick={() => setChoice(themeChoice)}
              className="h-9 rounded-lg border px-3 text-sm"
              style={{
                borderColor: choice === themeChoice ? "var(--fjord)" : "var(--hairline)",
                background: choice === themeChoice ? "var(--fjord-tint)" : "var(--paper)",
                color: choice === themeChoice ? "var(--fjord-ink)" : "var(--ink)",
              }}
            >
              {t(`settings.theme.${themeChoice}`)}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col items-center gap-3">
        <span className="text-xs font-medium uppercase tracking-wide" style={{ color: "var(--mist)" }}>
          {t("settings.locale.label")}
        </span>
        <div className="flex gap-2">
          {SUPPORTED_LOCALES.map((locale) => (
            <button
              key={locale.code}
              type="button"
              onClick={() => setLocale(locale.code)}
              className="h-9 rounded-lg border px-3 text-sm"
              style={{
                borderColor: i18n.language === locale.code ? "var(--fjord)" : "var(--hairline)",
                background: i18n.language === locale.code ? "var(--fjord-tint)" : "var(--paper)",
                color: i18n.language === locale.code ? "var(--fjord-ink)" : "var(--ink)",
              }}
            >
              {locale.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col items-center gap-3">
        <span className="text-xs font-medium uppercase tracking-wide" style={{ color: "var(--mist)" }}>
          {tw("repositories.label")}
        </span>
        <button
          type="button"
          onClick={openRepository}
          className="h-9 rounded-lg border px-3 text-sm"
          style={{ borderColor: "var(--fjord)", background: "var(--fjord-tint)", color: "var(--fjord-ink)" }}
        >
          {tw("repositories.openButton")}
        </button>
        {error && (
          <p className="text-sm" style={{ color: "var(--rust-ink)" }}>
            {tw("repositories.notAGitRepository")}
          </p>
        )}
        {repositories.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--slate)" }}>
            {tw("repositories.empty")}
          </p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm" style={{ color: "var(--ink)" }}>
            {repositories.map((repo) => (
              <li key={repo.id}>
                <span className="font-medium">{repo.name}</span>{" "}
                <span style={{ color: "var(--mist)" }}>{repo.path}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
