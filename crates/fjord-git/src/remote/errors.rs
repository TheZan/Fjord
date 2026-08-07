use std::sync::OnceLock;

use fjord_ports::GitRemoteError;
use regex::Regex;

const STDERR_TAIL_LIMIT: usize = 64 * 1024;

pub fn classify_failure(exit_code: Option<i32>, stdout: &str, stderr: &str) -> GitRemoteError {
    let combined = sanitize_diagnostics(&format!("{stderr}\n{stdout}"));
    let stderr_tail = tail(&combined, STDERR_TAIL_LIMIT);
    let lowered = combined.to_ascii_lowercase();
    let summary = combined
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("Git remote command failed")
        .to_string();

    if contains_any(
        &lowered,
        &[
            "host key verification failed",
            "remote host identification has changed",
        ],
    ) {
        GitRemoteError::HostKeyVerificationFailed { stderr_tail }
    } else if contains_any(
        &lowered,
        &[
            "permission denied (publickey",
            "no such identity",
            "sign_and_send_pubkey",
            "could not open a connection to your authentication agent",
        ],
    ) {
        GitRemoteError::SshKeyUnavailable { stderr_tail }
    } else if contains_any(
        &lowered,
        &[
            "ssl certificate problem",
            "certificate verify failed",
            "server certificate verification failed",
            "schannel: next initializeSecurityContext failed",
            "unable to get local issuer certificate",
        ],
    ) {
        GitRemoteError::CertificateFailed { stderr_tail }
    } else if contains_any(
        &lowered,
        &[
            "could not resolve proxy",
            "proxy authentication required",
            "failed to connect to proxy",
            "unable to access proxy",
        ],
    ) {
        GitRemoteError::ProxyFailed { stderr_tail }
    } else if contains_any(
        &lowered,
        &[
            "remote rejected",
            "pre-receive hook declined",
            "update hook declined",
            "hook declined",
            "protected branch",
        ],
    ) {
        // Checked before non-fast-forward: a hook rejection also prints the
        // generic "failed to push some refs" summary line.
        GitRemoteError::RemoteRejected {
            summary,
            stderr_tail,
        }
    } else if contains_any(
        &lowered,
        &[
            "non-fast-forward",
            "! [rejected]",
            "updates were rejected because",
            "fetch first",
        ],
    ) {
        GitRemoteError::NonFastForward { stderr_tail }
    } else if contains_any(
        &lowered,
        &[
            "repository not found",
            "does not appear to be a git repository",
            "the project you were looking for could not be found",
        ],
    ) {
        GitRemoteError::RepositoryNotFound { stderr_tail }
    } else if contains_any(
        &lowered,
        &[
            "could not read username",
            "could not read password",
            "terminal prompts disabled",
            "authentication required",
        ],
    ) {
        GitRemoteError::AuthenticationRequired { stderr_tail }
    } else if contains_any(
        &lowered,
        &[
            "authentication failed",
            "invalid username or password",
            "invalid credentials",
            "access denied: invalid token",
        ],
    ) {
        GitRemoteError::AuthenticationFailed { stderr_tail }
    } else if contains_any(
        &lowered,
        &[
            "requested url returned error: 403",
            "permission denied",
            "you are not allowed to push code",
        ],
    ) {
        GitRemoteError::PermissionDenied { stderr_tail }
    } else if contains_any(
        &lowered,
        &[
            "could not resolve host",
            "network is unreachable",
            "failed to connect",
            "connection timed out",
            "connection reset",
            "couldn't connect to server",
            "temporary failure in name resolution",
        ],
    ) {
        GitRemoteError::NetworkUnavailable { stderr_tail }
    } else if contains_any(&lowered, &["remote: error:"]) {
        // Last resort before the generic failure: the remote said something
        // went wrong but none of the specific families matched.
        GitRemoteError::RemoteRejected {
            summary,
            stderr_tail,
        }
    } else {
        GitRemoteError::ProcessFailed {
            exit_code,
            summary,
            stderr_tail,
        }
    }
}

pub fn sanitize_diagnostics(value: &str) -> String {
    static URL_USERINFO: OnceLock<Regex> = OnceLock::new();
    static AUTHORIZATION: OnceLock<Regex> = OnceLock::new();
    static BROKER_ENV: OnceLock<Regex> = OnceLock::new();
    static CREDENTIAL_VALUE: OnceLock<Regex> = OnceLock::new();

    let value = URL_USERINFO
        .get_or_init(|| {
            Regex::new(r"(?i)\b([a-z][a-z0-9+.-]*://)([^\s/@]+)@").expect("valid URL regex")
        })
        .replace_all(value, "$1[REDACTED]@");
    let value = AUTHORIZATION
        .get_or_init(|| Regex::new(r"(?im)^(\s*authorization\s*:).*$").expect("valid auth regex"))
        .replace_all(&value, "$1 [REDACTED]");
    let value = BROKER_ENV
        .get_or_init(|| {
            Regex::new(r"(?im)^(\s*FJORD_ASKPASS_(?:ADDRESS|TOKEN|OPERATION_ID)\s*=).*$")
                .expect("valid broker regex")
        })
        .replace_all(&value, "$1[REDACTED]");
    CREDENTIAL_VALUE
        .get_or_init(|| {
            Regex::new(r"(?im)^(\s*(?:password|oauth_token|token)\s*=).*$")
                .expect("valid credential regex")
        })
        .replace_all(&value, "$1[REDACTED]")
        .into_owned()
}

fn contains_any(value: &str, patterns: &[&str]) -> bool {
    patterns.iter().any(|pattern| value.contains(pattern))
}

fn tail(value: &str, limit: usize) -> String {
    if value.len() <= limit {
        return value.to_string();
    }
    let mut start = value.len() - limit;
    while !value.is_char_boundary(start) {
        start += 1;
    }
    value[start..].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_all_stable_failure_families() {
        let cases: &[(&str, &str)] = &[
            (
                "fatal: could not read Username for 'https://host'",
                "git_auth_required",
            ),
            (
                "fatal: Authentication failed for 'https://host'",
                "git_auth_failed",
            ),
            ("requested URL returned error: 403", "git_permission_denied"),
            ("ERROR: Repository not found.", "git_repository_not_found"),
            (
                "Host key verification failed.",
                "git_host_key_verification_failed",
            ),
            ("Permission denied (publickey).", "git_ssh_key_unavailable"),
            (
                "SSL certificate problem: unable to get local issuer certificate",
                "git_certificate_failed",
            ),
            ("Could not resolve proxy: proxy.example", "git_proxy_failed"),
            (
                "Could not resolve host: example.invalid",
                "git_network_unavailable",
            ),
            (
                "! [rejected] main -> main (non-fast-forward)",
                "git_non_fast_forward",
            ),
            (
                "! [remote rejected] main -> main (hook declined)",
                "git_remote_rejected",
            ),
        ];

        for (diagnostic, expected) in cases {
            assert_eq!(
                classify_failure(Some(1), "", diagnostic).code(),
                *expected,
                "diagnostic: {diagnostic}"
            );
        }
        assert_eq!(
            classify_failure(Some(128), "", "unexpected failure").code(),
            "git_remote_error"
        );
    }

    /// Real Git output, not one-line excerpts: every push rejection ends with
    /// the same generic `failed to push some refs` summary, so classification
    /// has to key off the specific line above it.
    #[test]
    fn classifies_realistic_multiline_push_rejections() {
        let hook_declined = "remote: error: hook declined to update refs/heads/main\n\
             To https://example.test/team/app.git\n\
             ! [remote rejected] main -> main (pre-receive hook declined)\n\
             error: failed to push some refs to 'https://example.test/team/app.git'";
        assert_eq!(
            classify_failure(Some(1), "", hook_declined).code(),
            "git_remote_rejected"
        );

        let protected_branch = "remote: error: GH006: Protected branch update failed for refs/heads/main.\n\
             To https://example.test/team/app.git\n\
             ! [remote rejected] main -> main (protected branch hook declined)\n\
             error: failed to push some refs to 'https://example.test/team/app.git'";
        assert_eq!(
            classify_failure(Some(1), "", protected_branch).code(),
            "git_remote_rejected"
        );

        let stale_tip = "To https://example.test/team/app.git\n\
             ! [rejected]        main -> main (fetch first)\n\
             error: failed to push some refs to 'https://example.test/team/app.git'\n\
             hint: Updates were rejected because the remote contains work that you do not have locally.";
        assert_eq!(
            classify_failure(Some(1), "", stale_tip).code(),
            "git_non_fast_forward"
        );

        let behind_tip = "To https://example.test/team/app.git\n\
             ! [rejected]        main -> main (non-fast-forward)\n\
             error: failed to push some refs to 'https://example.test/team/app.git'\n\
             hint: Updates were rejected because the tip of your current branch is behind its remote counterpart.";
        assert_eq!(
            classify_failure(Some(1), "", behind_tip).code(),
            "git_non_fast_forward"
        );

        let permission_denied = "remote: Permission to team/app.git denied to someone.\n\
             fatal: unable to access 'https://example.test/team/app.git/': \
             The requested URL returned error: 403";
        assert_eq!(
            classify_failure(Some(1), "", permission_denied).code(),
            "git_permission_denied"
        );
    }

    #[test]
    fn redacts_urls_headers_broker_values_and_credentials() {
        let sanitized = sanitize_diagnostics(
            "https://user:password@example.com/repo.git\n\
             https://token@example.com/repo.git\n\
             Authorization: Bearer secret\n\
             FJORD_ASKPASS_TOKEN=secret\n\
             password=secret",
        );
        assert!(!sanitized.contains("password@example"));
        assert!(!sanitized.contains("token@example"));
        assert!(!sanitized.contains("Bearer secret"));
        assert!(!sanitized.contains("TOKEN=secret"));
        assert!(!sanitized.contains("password=secret"));
        assert!(sanitized.contains("[REDACTED]"));
    }

    #[test]
    fn diagnostics_are_bounded_without_breaking_utf8() {
        let diagnostic = "я".repeat(STDERR_TAIL_LIMIT);
        let error = classify_failure(Some(1), "", &diagnostic);
        assert!(error.diagnostics().unwrap().len() <= STDERR_TAIL_LIMIT);
    }
}
