import { i18n } from "@/infrastructure/i18n";

const USER_ERROR_CODES = new Set([
  "auth_failed",
  "branch_exists",
  "database_error",
  "git_error",
  "ide_launch_failed",
  "ide_not_allowed",
  "merge_conflict",
  "merge_tool_failed",
  "no_conflicts",
  "no_ide_available",
  "no_terminal_available",
  "no_upstream",
  "not_a_git_repository",
  "nothing_to_commit",
  "nothing_to_stash",
  "operation_cancelled",
  "repository_already_added",
  "repository_discovery_failed",
  "repository_not_found",
  "stash_empty",
  "workspace_not_found",
]);

export function errorTranslationKey(error: unknown): string {
  const code = readErrorCode(error);
  return `errors.${code && USER_ERROR_CODES.has(code) ? code : "unexpected"}`;
}

export function userErrorMessage(error: unknown): string {
  return i18n.t(errorTranslationKey(error), { ns: "common" });
}

function readErrorCode(error: unknown): string | null {
  if (error && typeof error === "object" && "code" in error) {
    return String(error.code);
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return "operation_cancelled";
  }
  return null;
}
