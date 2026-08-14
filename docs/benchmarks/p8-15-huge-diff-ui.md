# P8-15 Huge-Diff UI Remeasurement

Date: 2026-08-12

Fixture: packed `diff-giant` on Windows 11, warm operator-asserted cache,
release backend profile. Both measurements discard 3 warmups and retain 20
samples. The backend machine-readable record is
[`p8-15-diff-window.json`](p8-15-diff-window.json).

| Contribution | P50 | P95 | Max |
| --- | ---: | ---: | ---: |
| first bounded backend response | 34.165 ms | **41.788 ms** | 47.715 ms |
| React/jsdom `tooLarge` metadata viewport render | 1.178 ms | **1.268 ms** | 2.266 ms |
| conservative P95 sum | — | **43.056 ms** | — |

The backend response describes the 500,000-line target without content and is
243 serialized bytes. The UI loop mounts and commits `FileDiffView` with that
authoritative metadata, including totals and the explicit load-anyway action,
then unmounts it for each sample. Its assertion keeps the UI contribution below
the 600 ms SLO-10 target.

The two samples are separate clocks, so their sum is a conservative diagnostic,
not an action-to-paint trace. It puts both the real fixture backend and React UI
work in the P8-15 measurement and remains comfortably inside SLO-10, while the
formal packaged Tauri/WebView interaction driver and failing gate remain owned
by P11-01.
