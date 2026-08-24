import { i18n } from "@/infrastructure/i18n";

const USER_ERROR_CODES = new Set([
  "auth_failed",
  "branch_exists",
  "clone_destination_exists",
  "clone_destination_invalid",
  "clone_registration_failed",
  "clone_request_invalid",
  "create_repository_destination_invalid",
  "create_repository_destination_not_empty",
  "create_repository_registration_failed",
  "create_repository_request_invalid",
  "database_error",
  "diff_tool_name_invalid",
  "diff_tool_not_configured",
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
  "remote_name_exists",
  "remote_request_invalid",
  "stash_empty",
  "stash_not_found",
  "stash_ambiguous",
  "stash_file_conflicted",
  "stash_file_unsupported_git",
  "stash_scope_empty",
  "stash_concurrent_update",
  "stash_scope_unrepresentable",
  "workspace_not_found",
]);

export function errorTranslationKey(error: unknown): string {
  const code = readErrorCode(error);
  return `errors.${code && USER_ERROR_CODES.has(code) ? code : "unexpected"}`;
}

export function userErrorMessage(error: unknown): string {
  return i18n.t(errorTranslationKey(error), { ns: "common", tool: readErrorTool(error), path: readErrorPath(error) });
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

function readErrorTool(error: unknown): string | null {
  if (error && typeof error === "object" && "tool" in error && typeof error.tool === "string") {
    return error.tool;
  }
  return null;
}

function readErrorPath(error: unknown): string | null {
  if (error && typeof error === "object" && "paths" in error && Array.isArray(error.paths) && error.paths.length > 0) {
    return String(error.paths[0]);
  }
  return null;
}
