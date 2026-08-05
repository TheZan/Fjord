import { useTranslation } from "react-i18next";
import { setLocale } from "@/infrastructure/i18n";
import { useTheme } from "@/infrastructure/theme/ThemeProvider";
import { SUPPORTED_LOCALES } from "@/locales/registry";
import { Button, GroupLabel } from "@/presentation/ui";
import type { Theme } from "@/domain/settings";

const THEME_CHOICES: Theme[] = ["light", "dark", "system"];

/**
 * Theme and locale used to occupy the bottom third of the sidebar
 * permanently. They're set-once preferences, so they live behind a dialog
 * now and the sidebar keeps its space for things that change during work.
 */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const { t: tw } = useTranslation("workspace");
  const { choice, setChoice } = useTheme();

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center pt-[18vh]"
      style={{ background: "rgba(8, 12, 16, 0.45)" }}
      onClick={onClose}
    >
      <div
        className="w-[380px] rounded-xl border p-5 shadow-2xl"
        style={{
          borderWidth: "0.5px",
          borderColor: "var(--hairline-strong)",
          background: "var(--paper)",
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="mb-4 text-[15px] font-medium">{tw("settings.title")}</h2>

        <div className="mb-4 flex flex-col gap-2">
          <GroupLabel>{t("settings.theme.label")}</GroupLabel>
          <div className="grid grid-cols-3 gap-1.5">
            {THEME_CHOICES.map((themeChoice) => (
              <Button
                key={themeChoice}
                size="sm"
                variant={choice === themeChoice ? "primary" : "secondary"}
                onClick={() => setChoice(themeChoice)}
              >
                {t(`settings.theme.${themeChoice}`)}
              </Button>
            ))}
          </div>
        </div>

        <div className="mb-5 flex flex-col gap-2">
          <GroupLabel>{t("settings.locale.label")}</GroupLabel>
          <div className="grid grid-cols-2 gap-1.5">
            {SUPPORTED_LOCALES.map((locale) => (
              <Button
                key={locale.code}
                size="sm"
                variant={i18n.language === locale.code ? "primary" : "secondary"}
                onClick={() => setLocale(locale.code)}
              >
                {locale.label}
              </Button>
            ))}
          </div>
        </div>

        <div className="flex justify-end">
          <Button onClick={onClose}>{tw("settings.close")}</Button>
        </div>
      </div>
    </div>
  );
}
