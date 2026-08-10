# Accessibility verification

## Status tones

Status text uses the `*-ink` token on the matching `*-tint` background. Ratios
were calculated from the sRGB values in `src/index.css` with the WCAG 2.x
relative-luminance formula. All combinations exceed the 4.5:1 AA requirement
for text-sized content.

| Tone | Light | Dark |
|---|---:|---:|
| fjord | 7.43:1 | 9.27:1 |
| moss | 7.36:1 | 9.70:1 |
| amber | 7.26:1 | 9.06:1 |
| rust | 7.47:1 | 9.38:1 |

## Non-color status contract

The Overview cards, sidebar rows, and repository toolbar keep the same glyphs:

- dirty: `●` plus the changed-file count;
- ahead: `↑` plus the commit count;
- behind: `↓` plus the commit count;
- conflict: `⚠` plus a localized Conflict label;
- synchronized: `✓` plus a localized Synced label where a summary badge is shown.

This preserves every state when rendered in grayscale. The manual grayscale
check covers a fixture row for dirty, ahead, behind, and conflict in both the
Overview and repository screens; each remains distinguishable by glyph, text,
and stable position without relying on its tone.

## Overlay focus contract

Modal overlays move focus inside on open, cycle `Tab`/`Shift+Tab` within the
overlay, close on `Esc`, and return focus to the invoking control on unmount.
Menus use their own roving focus and return focus to their trigger.
