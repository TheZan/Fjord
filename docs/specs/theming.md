# Spec: theming

Referenced by: P0-06.

## Modes

Three user-facing choices — **Light**, **Dark**, **System** — default **System**. What gets persisted via `SettingsStore` is the *choice* (`'light' | 'dark' | 'system'`), never the resolved value; resolution happens at runtime so an OS-level theme change is picked up live without touching settings.

## Token set

CSS custom properties, validated against the interactive dashboard prototype — this list is not aspirational, it's already been built and looked at in both modes:

| Token | Role |
|---|---|
| `--page-bg` | App background |
| `--paper` | Card / panel surface |
| `--ink` | Primary text |
| `--slate` | Secondary text |
| `--mist` | Muted text / placeholders |
| `--hairline`, `--hairline-strong` | Borders |
| `--fjord`, `--fjord-ink`, `--fjord-tint` | Brand accent (buttons, current-branch, active nav) |
| `--moss`, `--moss-ink`, `--moss-tint` | Semantic: clean / synced / added |
| `--amber`, `--amber-ink`, `--amber-tint` | Semantic: dirty / modified / needs attention |
| `--rust`, `--rust-ink`, `--rust-tint` | Semantic: conflict / removed / error |

Semantic colors (`moss`/`amber`/`rust`) are a separate axis from the brand accent (`fjord`) — a component never reaches for the accent color to mean "warning," and never reaches for amber to mean "this is clickable." This separation is what let the commit-graph lanes (main = fjord, feature branch = amber) stay legible next to the status pills (dirty = amber) without the two meanings colliding — the shared amber deliberately reinforces "this is the branch currently marked dirty," not a coincidence to design around later.

The light palette uses muted mineral-grey surfaces instead of pure white. The dark palette uses raised graphite surfaces instead of a near-black canvas, with a restrained blue-grey interaction accent kept separate from the fixed teal brand mark. Both themes preserve visible surface hierarchy without taking on the high-contrast black-and-teal appearance common to Git clients.

## Density and typography

`src/presentation/ui.tsx` owns the shell's four-step `TYPOGRAPHY` scale:
`screenTitle` (17 px), `body` (13 px), `caption` (11 px), and `microLabel`
(10 px uppercase). Shell components consume these named steps instead of
introducing adjacent one-off sizes.

The same module owns `Surface` and `ScreenSurface`. A screen surface uses the
page background and never draws a card border around the whole screen. Any
panel or card composed inside it automatically suppresses its full border;
owners may still use `--hairline` separators for real pane or section
boundaries. This makes “one border level per surface” structural rather than a
per-component styling convention.

## Resolution and persistence

```
effective_theme =
  choice == 'system'
    ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : choice
```

`ThemeProvider` (frontend, `infrastructure/theme`):

1. Reads the persisted `choice` via `get_settings` on boot.
2. Resolves `effective_theme`, sets `data-theme` on `<html>`.
3. Subscribes to **both**: the `matchMedia` change event (WebView-level) **and** Tauri's native window theme-change event — the second one matters because it's what keeps the native window chrome (title bar, traffic lights/min-max-close) in sync with the WebView content when `choice == 'system'` and the OS theme flips while the app is open. Missing this is the failure mode where the window frame and the page content disagree.
4. On explicit user change, calls `update_settings` and re-resolves immediately — no reload, no flicker (CSS variable swap only).

## Non-goals

No per-component theme overrides, no user-defined custom palettes in v1 — three modes, one token set, applied consistently. Revisit only if there's a real request for it, not preemptively.
