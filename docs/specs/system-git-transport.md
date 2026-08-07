# Spec: system Git transport

Referenced by: P5-01–P5-19, SDD §5.2, [`git-backend.md`](git-backend.md),
[`operation-events.md`](operation-events.md).

## Scope and dependency boundary

Fjord separates repository-local work from network transport:

- `GitBackend` owns reads and local mutations. `gix` serves status, refs, history,
  and committed diffs; `git2` serves working-tree/index mutations, commits,
  checkout, stash, and integration after a fetch.
- `GitRemoteBackend` owns fetch, refspec fetch, push, remote-branch deletion, and
  `ls-remote`. Its production implementation invokes the discovered system Git
  executable without a shell.
- `GitEnvironmentProvider` discovers and inspects Git and performs a read-only
  connection test.

`RepoService` receives the three ports separately. `GitBackend` contains no
network methods, and no production remote path uses libgit2 transport.

## Authentication

The system Git process inherits the user's normal, process-local environment and
therefore uses Git Credential Manager, configured credential helpers, SSH agent,
`~/.ssh/config`, proxy settings, and certificate configuration. Fjord does not
store passwords, tokens, credential-helper output, or private SSH keys.

Authentication order is:

1. the user's normal Git/SSH configuration and credential helpers;
2. helpers that launch their own browser or native UI;
3. the operation-scoped `fjord-askpass` broker, when Git or SSH requests input.

Askpass is a fallback prompt channel, never credential storage. Its token,
operation ID, prompt response, and broker address are operation-scoped and must
not be logged.

Without a credential helper, Git can prompt through Fjord's bundled askpass;
rejected or unavailable interaction is classified as `git_auth_required` or
`git_auth_failed` from sanitized Git diagnostics.

Automated coverage uses fake helpers against a loopback endpoint that demands
Basic auth (`crates/fjord-git/tests/credential_helper.rs`): a helper that
answers, a helper that stays silent, and a helper that fails, so helper
chaining and fall-through are verified without a real account or stored secret.
Provider-specific helpers — GCM, Keychain, libsecret — cannot be faked
meaningfully and stay in [`../manual-git-compatibility.md`](../manual-git-compatibility.md).

## Executable discovery

Discovery checks, in order:

1. the explicit `git_executable_path` setting;
2. `PATH`;
3. known OS installation paths.

Every candidate is verified by executing it directly with `--version`; success
requires exit code 0 and recognizable `git version` output. An invalid configured
path is reported to diagnostics and does not silently become a different stored
value. If no candidate is valid, remote commands fail with
`git_executable_not_found`; local Git features remain available.

Fjord never installs Git or changes global Git configuration automatically.

## Command execution

Commands are constructed with `tokio::process::Command` and individual arguments.
Shell strings (`sh -c`, `cmd /C`, or formatted `git ...` commands) are forbidden.
The runner:

- sets `current_dir`, null stdin, and piped stdout/stderr;
- reads stdout and stderr concurrently and lossily decodes invalid UTF-8;
- treats newline and carriage return as progress record boundaries;
- bounds retained stderr diagnostics;
- supports a timeout and cancellation while the process is running;
- places the process in an OS-specific process tree container (process group on
  Unix, Job Object or isolated `taskkill /T` fallback on Windows) and terminates
  the complete tree on cancellation/timeout;
- suppresses a console window on Windows.

For stable error classification, remote commands set process-local `LC_ALL=C` and
`LANG=C`. They do not alter user or global configuration.

## Progress contract

Runner output is converted to `GitProgress` and sent through the existing
`GitOperationContext`. Progress supports determinate object counts when Git emits
them and indeterminate phase messages otherwise. Events may be throttled/coalesced
before crossing Tauri IPC, but lifecycle and final events are never dropped.

The frontend contract remains `fjord-operation-progress`; see
[`operation-events.md`](operation-events.md). Cancellation must stop the process
tree before a final `cancelled` event is emitted and the operation is removed from
the registry.

## Stable remote failures

Frontend behavior depends only on these stable codes:

| Code | Meaning |
|---|---|
| `git_executable_not_found` | No valid system Git executable. |
| `git_process_spawn_failed` | The executable could not be started. |
| `git_auth_required` | Interactive credentials are required. |
| `git_auth_failed` | Supplied/stored credentials were rejected. |
| `git_permission_denied` | Authenticated identity lacks permission. |
| `git_repository_not_found` | Remote repository does not exist or is hidden. |
| `git_host_key_verification_failed` | SSH host-key validation failed. |
| `git_ssh_key_unavailable` | No usable SSH identity/key is available. |
| `git_certificate_failed` | TLS certificate validation failed. |
| `git_proxy_failed` | Proxy resolution/authentication/connect failed. |
| `git_network_unavailable` | DNS, routing, connection, or offline failure. |
| `git_non_fast_forward` | Push would not be a fast-forward. |
| `git_remote_rejected` | The server rejected the update. |
| `git_operation_timeout` | The configured process timeout elapsed. |
| `operation_cancelled` | The user/application cancelled the operation. |
| `git_remote_error` | Unclassified non-zero Git result. |

Classification uses exit status and sanitized stderr in the stable C locale.
Original sanitized diagnostics remain available as a bounded tail; a friendly
classification must not erase them.

## Redaction

Before diagnostics, tracing, IPC, or UI rendering, Fjord removes:

- URL userinfo (`scheme://user:secret@host`);
- authorization header values;
- credential-helper input/output;
- askpass tokens, addresses, operation IDs, and prompt responses;
- secret-bearing proxy userinfo.

Executable path, safe command/subcommand arguments, duration, and exit code may be
logged. Tokens and passwords are never process arguments.

## Remote operation semantics

- Fetch: `git fetch --prune <remote> [refspecs...]`.
- Push: `git push <remote> [refspecs...]`.
- Delete remote branch: `git push <remote> --delete <branch>`.
- Inspect remote: `git ls-remote` (and `--symref` for connection tests).
- Materialize a remote branch: targeted system-Git fetch followed by local
  checkout/branch creation.

Pull intentionally remains a composed operation:

```text
system git fetch
→ inspect configured upstream
→ fast-forward or merge through the local backend
```

Fjord must not replace this with `git pull`, because user `pull.rebase` and related
configuration would change existing behavior.

## Diagnostics and askpass milestones

Environment inspection is read-only and may reveal executable path/version,
credential-helper names and origins, sanitized SSH command presence, SSH-agent
availability, and proxy configured/not-configured. Connection testing uses
`git ls-remote --symref <remote> HEAD` and does not mutate the repository.

The broker listens only on `127.0.0.1` at an ephemeral port. Every operation has
a CSPRNG bearer token, expiry, and one-use prompt IDs. The sidecar sends one
newline-delimited JSON request and receives one response with `answered`,
`cancelled`, `timed-out`, or `operation-cancelled`; token/address never cross the
Tauri event boundary. Concurrent prompts are queued in the UI, and secret React
state is cleared before the answer IPC promise settles.

`fjord-askpass` is a minimal Tauri-free binary. Git receives its absolute path in
`GIT_ASKPASS` and `SSH_ASKPASS`; Unix additionally uses process-local OpenSSH
askpass variables. `GIT_TERMINAL_PROMPT` is deliberately not forced off so GCM
browser/MFA flows remain available. Release and bundle-smoke matrices build a
target-suffixed sidecar and fail if it is absent from the bundle.
