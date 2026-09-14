# P10-10 workspace health filter benchmark

Date: 2026-08-30

Platform: Windows, frontend Vitest/jsdom development test runtime

Scenario: client-side `WrongBranch` filtering over 100 already-loaded repository
rows and their `RepoHealth` projections.

## Method

`src/application/repoHealth.performance.test.ts` builds the synthetic `ws-100`
shape in memory. Ten repositories carry `WrongBranch`, including one detached
fixture with `actual: null`; the remaining 90 are clean. It applies the canonical
All Repositories filtering function 2,000 times and records one duration per
application. The benchmark contains no IPC mock, Git call, network operation, or
health recomputation.

## Result

| Metric | Duration |
|---|---:|
| p50 | 0.003 ms |
| p95 | 0.012 ms |
| max | 2.348 ms |

Command:

```powershell
npm test -- --run src/application/repoHealth.performance.test.ts --reporter=verbose
```

The algorithm is O(repositories × active filters), with the active-filter count
bounded at six. The measured `ws-100` application is comfortably interactive
and introduces no backend or Git work.
