import { describe, expect, it } from "vitest";
import { errorTranslationKey, userErrorMessage } from "@/application/errorMessage";
import { initI18n } from "@/infrastructure/i18n";

describe("errorTranslationKey", () => {
  it("maps stable backend codes to localized catalog keys", () => {
    expect(errorTranslationKey({ code: "repository_already_added", message: "raw sql" })).toBe(
      "errors.repository_already_added",
    );
    expect(errorTranslationKey({ code: "auth_failed", message: "raw git" })).toBe(
      "errors.auth_failed",
    );
  });

  it("never exposes unknown backend or JavaScript messages", () => {
    expect(errorTranslationKey({ code: "future_backend_error", message: "secret detail" })).toBe(
      "errors.unexpected",
    );
    expect(errorTranslationKey(new Error("technical detail"))).toBe("errors.unexpected");
  });

  it("returns the message in the active locale instead of the backend fallback", async () => {
    await initI18n("ru");

    expect(userErrorMessage({ code: "repository_already_added", message: "UNIQUE failed" })).toBe(
      "Этот репозиторий уже добавлен в выбранное рабочее пространство.",
    );
  });
});
