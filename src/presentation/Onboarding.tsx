import { useState } from "react";
import { useTranslation } from "react-i18next";
import { FjordMark } from "@/presentation/FjordMark";
import { Button, Input } from "@/presentation/ui";

/**
 * First run. Previously this was a bordered card wedged above the dashboard
 * chrome, so an empty app showed onboarding, a toolbar, three zeroed metric
 * tiles and two empty lists at once. With no workspaces there's nothing else
 * to show, so it gets the screen.
 */
export function Onboarding({
  onCreate,
}: {
  onCreate: (name: string, withImport: boolean) => Promise<void>;
}) {
  const { t } = useTranslation("workspace");
  const [name, setName] = useState("");
  const [pending, setPending] = useState<string | null>(null);

  async function submit(withImport: boolean) {
    setPending(withImport ? "import" : "create");
    try {
      await onCreate(name, withImport);
    } finally {
      setPending(null);
    }
  }

  return (
    <div
      className="flex h-screen flex-col items-center justify-center px-6"
      style={{ background: "var(--page-bg)", color: "var(--ink)" }}
    >
      <div className="w-full max-w-md">
        <FjordMark size={26} style={{ color: "var(--brand)" }} />
        <h1 className="mt-4 text-xl font-medium">{t("onboarding.title")}</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed" style={{ color: "var(--slate)" }}>
          {t("onboarding.body")}
        </p>

        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void submit(false);
          }}
          placeholder={t("onboarding.workspacePlaceholder")}
          className="mt-5 w-full"
        />

        <div className="mt-3 flex gap-2">
          <Button variant="primary" disabled={pending !== null} onClick={() => void submit(true)}>
            {pending === "import" ? t("onboarding.importing") : t("onboarding.createAndImport")}
          </Button>
          <Button disabled={pending !== null} onClick={() => void submit(false)}>
            {pending === "create" ? t("onboarding.creating") : t("onboarding.createOnly")}
          </Button>
        </div>
      </div>
    </div>
  );
}
