import { describe, expect, it } from "vitest";
import { errorTranslationKey, userErrorMessage } from "@/application/errorMessage";
import { initI18n, setLocale } from "@/infrastructure/i18n";

describe("errorTranslationKey", () => {
  it("maps stable backend codes to localized catalog keys", () => {
    expect(errorTranslationKey({ code: "repository_already_added", message: "raw sql" })).toBe(
      "errors.repository_already_added",
    );
    expect(errorTranslationKey({ code: "auth_failed", message: "raw git" })).toBe(
      "errors.auth_failed",
    );
    expect(errorTranslationKey({ code: "git_repository_ownership", message: "raw path" })).toBe(
      "errors.git_repository_ownership",
    );
    expect(errorTranslationKey({ code: "operation_step_failed", message: "raw git" })).toBe(
      "errors.operation_step_failed",
    );
    expect(errorTranslationKey({ code: "clone_destination_exists", message: "raw path" })).toBe(
      "errors.clone_destination_exists",
    );
    expect(errorTranslationKey({ code: "git_auth_failed", message: "raw git" })).toBe(
      "errors.git_auth_failed",
    );
    expect(errorTranslationKey({ code: "git_network_unavailable", message: "raw git" })).toBe(
      "errors.git_network_unavailable",
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

  it("explains an ownership refusal without exposing the backend path", async () => {
    await initI18n("en");
    await setLocale("en");

    const message = userErrorMessage({
      code: "git_repository_ownership",
      message: "repository path '/secret/repo' is not owned by current user",
    });

    expect(message).toContain("owned by another account");
    expect(message).toContain("safe.directory");
    expect(message).not.toContain("/secret/repo");
  });
});
