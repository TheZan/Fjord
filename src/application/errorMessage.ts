import { i18n } from "@/infrastructure/i18n";

const USER_ERROR_CODES = new Set([
  "auth_failed",
  "branch_exists",
  "clone_destination_exists",
  "clone_destination_invalid",
  "clone_registration_failed",
  "clone_request_invalid",
  "database_error",
  "git_error",
  "git_auth_failed",
  "git_auth_required",
  "git_certificate_failed",
  "git_environment_error",
  "git_executable_invalid",
  "git_executable_not_found",
  "git_force_lease_failed",
  "git_host_key_verification_failed",
  "git_network_unavailable",
  "git_non_fast_forward",
  "git_operation_timeout",
  "git_permission_denied",
  "git_process_spawn_failed",
  "git_proxy_failed",
  "git_remote_error",
  "git_remote_rejected",
  "git_repository_ownership",
  "git_repository_not_found",
  "git_ssh_key_unavailable",
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
  "operation_has_conflicts",
  "operation_not_in_progress",
  "operation_step_failed",
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
