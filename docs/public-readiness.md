# Fjord public repository readiness

Review date: 2026-08-14. Scope: the `develop` publication tree and all reachable
Git patch history. This document records preparation; it does not change GitHub
visibility, default branch, description, or topics.

## Publication-tree evidence

| Check | Evidence | Result |
|---|---|---|
| English README and Russian parity | `README.md`, `README.ru.md` contain the same Early Preview warning, install/source-build paths, supported platforms, shipped scope/limitations, screenshot, contribution/security links, and dual license | Pass |
| Product visual | `assets/screenshots/fjord-workspace-overview.png`, rendered at 1440×900 from the current `OverviewView`/`RepoCard` UI with explicitly seeded local demo data | Pass |
| Download/install near top | Both READMEs link Releases and state Windows 11 x64, macOS 13+ Intel/Apple Silicon, Ubuntu 22.04+ x64, plus source prerequisites | Pass |
| Honest Early Preview claims | Broad “fast” and stale roadmap claims were replaced by bounded/measured implementation language and a concrete included/not-included list | Pass |
| Contribution path | `CONTRIBUTING.md` documents setup, checks, architecture, localization, security, and focused work | Pass |
| Issue reporting | Structured bug and feature forms; public blanks disabled; private advisory link is first in `config.yml` | Pass |
| Security guidance | `SECURITY.md` defines private reporting, supported-version policy, sensitive-data rules, and links the transport threat contract | Pass |
| License consistency | Root MIT and Apache-2.0 texts, Cargo `MIT OR Apache-2.0`, and both README license sections agree | Pass |
| Internal working files | `.testagent/` research/plan artifacts removed from the publication tree; `AGENTS.md` is retained as non-secret contributor/automation guidance | Pass |
| Automated current-tree/history scan | `npm run audit:public`; scans current tracked/untracked publication files and full reachable patch history for high-confidence credential/key patterns and credential-bearing URLs; CI uses full checkout history | Pass locally; CI evidence required at launch |

The screenshot is not a claim about a packaged build. Clean-machine package
screenshots remain part of [`v0.1-fresh-install-smoke.md`](v0.1-fresh-install-smoke.md).
A video/GIF was judged non-essential for v0.1 and is deferred until a signed
candidate can be recorded without developer chrome.

## GitHub settings for human review

Recommended repository description:

> A workspace-first, cross-platform Git client for managing multiple repositories.

Recommended topics:

`git`, `git-client`, `desktop`, `tauri`, `rust`, `react`, `workspace`,
`cross-platform`, `open-source`.

The local remote advertises `origin/master` as the default branch while release
work is committed to `develop`. Before public visibility, a human must review and
merge the exact launch commit so the GitHub default branch presents this tree;
the automation must not switch or force-update it. The repository owner must
also confirm the recommended description/topics and that the commit-author email
visible in history (`msochnev@softproduct.pro`) is acceptable for publication.

## Remaining external launch evidence

- GitHub description and topics confirmed.
- Default branch contains the reviewed launch commit.
- Full-history `audit:public` CI job URL recorded.
- Signed candidate package screenshots and fresh-install notes recorded.
- Repository remains private until the separate `P9R-13` decision is reviewed.

Any unchecked external item is a launch blocker, not permission for automation
to mutate visibility or rewrite history.
