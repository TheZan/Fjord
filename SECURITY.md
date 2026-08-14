# Security policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's
**Report a vulnerability** private advisory form for this repository:

https://github.com/TheZan/Fjord/security/advisories/new

If private advisories are temporarily unavailable, contact the repository owner
through the private contact method shown on their GitHub profile and include only
enough information to establish a secure follow-up channel.

Never include real credentials, signing keys, private repository contents, full
diffs, or URLs containing userinfo in the initial report. Sanitized reproduction
steps, affected Fjord version, operating system, and the relevant stable error
code are useful.

We will acknowledge a report when it is received, coordinate validation and a
fix privately, and publish remediation information after affected users can
update. Early Preview response times are best-effort and no bounty program is
currently offered.

## Supported versions

Before the first public release there is no supported binary version. After
`v0.1.0` is published, only the latest Early Preview release receives security
fixes. This policy will be updated before a stable channel is introduced.

## Security model

Fjord operates on local repositories and delegates network Git operations to the
user's installed system Git. It does not store passwords, tokens, SSH private
keys, or askpass answers. See
[`docs/specs/system-git-transport.md`](docs/specs/system-git-transport.md) for
the credential, subprocess, cancellation, and diagnostic-redaction contract.
