# P6-16 Bounded Diff Transport

Date: 2026-08-10

Fixture: packed `diff-giant`, release profile on Windows 11, warm
operator-asserted cache, 3 discarded warmups and 20 measured repetitions.
Machine-readable result: [`p6-16-diff-window.json`](p6-16-diff-window.json).

| Metric | P50 | P95 | Max | Budget |
| --- | ---: | ---: | ---: | ---: |
| first bounded response | 28.224 ms | **34.592 ms** | 34.896 ms | SLO-10: 600 ms |

The selected 500k-line file is above the 10 MB display ceiling, so its first
response is the intended `tooLarge` metadata state: `totalLines = 500000`, no
hunks/content, and 184 serialized bytes. The separate 50 MB text target also
returned `tooLarge = true`. Before P6-16, the 50 MB target took 611 ms in the
backend and attempted to send 2,694,458 `DiffLine` objects.

For files below the display ceiling, transport uses at most 1000 lines per
frontend request (backend hard maximum 2000), carries total hunk/line counts and
an opaque numeric continuation offset, and enforces a 2 MB serialized-response
ceiling with the typed `diff_window_too_large` error. The committed-diff
collector walks all diff output for exact totals but allocates strings only for
the selected window.

`diff_list` remains a separate full changed-file statistics operation and
measured P95 787.387 ms. It is not on the first-window content transport and is
not counted against this result.
