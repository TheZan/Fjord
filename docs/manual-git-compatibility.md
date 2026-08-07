# Manual Git compatibility sign-off

This release gate requires real user accounts, credential stores, SSH keys,
corporate proxy/certificate environments, and interactive browser/MFA flows. It
cannot be replaced by local bare-remote or fake-helper automation. Record the
release candidate, tester, date, and result for every applicable row.

## Platform matrix

| Platform | HTTPS credential flow | SSH / agent flow | Result |
|---|---|---|---|
| Windows | Git Credential Manager | Windows OpenSSH / agent | Pending |
| macOS | GCM or Keychain helper | OpenSSH / agent | Pending |
| Linux | GCM or libsecret helper | OpenSSH / agent | Pending |

## Hosting matrix

| Hosting | Saved credentials | First login / browser MFA | Expired or revoked credential | Result |
|---|---|---|---|---|
| GitHub | Pending | Pending | Pending | Pending |
| GitLab | Pending | Pending | Pending | Pending |
| Azure DevOps | Pending | Pending | Pending | Pending |
| Self-hosted HTTPS | Pending | Pending | Pending | Pending |
| Self-hosted SSH | Pending | Pending | Pending | Pending |

## Failure and cancellation scenarios

- [ ] No credential helper: Fjord askpass receives username and secret prompts.
- [ ] SSH key with passphrase: Fjord askpass receives a hidden secret prompt.
- [ ] SSH key without passphrase: operation completes without a Fjord prompt.
- [ ] Unknown host key: verification fails; Fjord does not auto-accept it.
- [ ] Proxy authentication/failure is classified and diagnostics are redacted.
- [ ] Invalid certificate is classified; Fjord does not disable verification.
- [ ] VPN/network disconnect is classified without hanging.
- [ ] Cancellation during network transfer leaves no Git/helper/SSH process.
- [ ] Cancellation while a prompt is open closes it and terminates the operation.

P5-19 and a public release are signed off only after this document contains the
results for the intended release environments.
