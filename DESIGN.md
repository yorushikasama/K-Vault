# Design

The visual system for YoruVault after the "de-slop" pass. The one rule that overrides everything: **a colour exists in exactly one place — the token layer. Everything else derives from it.** When you meet an AI tell, keep the structure and change the treatment.

## Color

Every brand colour is defined once, in `theme.css`, and everything else is derived from it with `color-mix()`. A literal hex outside the token blocks is a second source of truth that the theme swap cannot reach — that is the defect this file exists to prevent.

Brand (`theme.css` `--ui-brand*`):

- **Blue** `#1a5fa8` (light) / `#79b8ff` (dark) — index, login, gallery, webdav, admin, notice pages
- **Teal** `#0f766e` / `#0f8f8a` — preview, admin-waterfall
- These two are deliberately 35° apart in hue so they stay distinguishable, while both sitting in the logo's cool family. The logo itself measures hue 180/195/210 — the old violet brand was never related to it.
- Element UI semantic colors (success/warning/danger/info) — keep
- Surface + ink neutrals from theme.css `--ui-*` tokens — keep the hue, may adjust opacity/lightness

Deriving, not restating:

- **Tints and borders:** `color-mix(in srgb, var(--ui-brand) N%, transparent)`. Never a hard-coded `rgba(…)` of the brand hue — those do not follow the theme.
- **Text on a brand-tinted surface:** `color-mix(in srgb, var(--ui-brand) N%, var(--ui-ink))`, which darkens on light and lightens on dark automatically. A literal dark tint only works in one theme and then needs a hand-written mirror rule, which is how the palette forked in the first place.
- **Focus rings, soft fills, hover states:** read the derived tokens (`--ui-brand-soft`, `--ui-brand-ring`), not new literals.

Every brand pair must clear WCAG AA (4.5:1 for text, 3:1 for non-text) as text on canvas, as text on surface, and as the ground for `--ui-brand-ink`. Measured for the current pair — light `#1a5fa8`: 6.19 / 6.47 / 6.47; dark `#79b8ff`: 9.11 / 8.33 / 9.07. Re-measure before changing either value.

Treatment rules (this is where AI-ness is removed):
- **Gradients → flat.** Replace every decorative `linear-gradient` / `radial-gradient` (bodies, buttons, icon chips, cards, headers, batch buttons) with a *solid fill of the same hue*. Use the gradient's dominant/first stop as the solid. A tonal two-stop of the same hue is only allowed on a single hero-scale element if truly needed; default is flat.
- **No gradient text.** No `background-clip: text`. Solid brand color; emphasis via weight/size.
- **No colored glows.** Remove `box-shadow` that uses a brand hue (teal glows included). Shadows are neutral only.
- **Accent is for action/state, not decoration.** Brand color on primary buttons, current selection, focus ring, active state. Neutrals carry surfaces and chrome.
- **Never gray-on-color.** Muted text on a tinted surface uses a darker shade of that surface's hue, not a gray.

## Surfaces (kill glassmorphism)

- Surfaces are **opaque**. `--ui-card-opacity: 1`, `--ui-card-backdrop-filter: none`. Remove `backdrop-filter: blur()` / `-webkit-backdrop-filter` everywhere it is used decoratively (cards, headers, panels, toolbars, dialogs, gates). Glass is allowed only on a genuinely floating overlay above busy content (at most a sticky top bar or a modal scrim) — not the reading surface.
- A surface is: a solid background color + a **1px hairline border** + at most one restrained shadow. Never pair a 1px border with a big soft shadow (the "ghost card"): pick one.
- Do not wrap everything in a card. Let content sit on the page; group with borders, dividers, and whitespace. Never nest cards.

## Shape (radius scale)

Replace the global 16-22px rounding with a deliberate scale, applied by role:
- `--radius-sm: 6px` — inputs, small buttons, chips, tags-as-rects
- `--radius-md: 10px` — cards, panels, list items, dialogs
- `--radius-lg: 14px` — large modals / full media stages (ceiling; never exceed 16px on a rectangular container)
- Full pill (`9999px`) only for true pills: status dots, toggle switches, count badges, chip tags.
- Do not round full-bleed images/sections by default.

## Depth (elevation scale)

Neutral, tight, low-alpha. No colored glows, no `0 8px 32px` floaters.
- `--shadow-1: 0 1px 2px rgba(15,23,42,.06), 0 1px 1px rgba(15,23,42,.04)` — resting cards/panels (or use border alone)
- `--shadow-2: 0 4px 12px rgba(15,23,42,.08)` — dropdowns, popovers, sticky bars
- `--shadow-3: 0 12px 28px rgba(15,23,42,.14)` — modals only
- Dark theme: same structure, `rgba(0,0,0,...)` at ~2× alpha.

## Typography

Product UI: keep the system/sans stack already in use (`system-ui`-based). Do not add display fonts to labels/buttons/data. Improve hierarchy through scale + weight, not decoration:
- Fixed rem scale, ratio ~1.2. Body 14-15px. Reduce heaviest weights (900→700, 700→600) where they shout.
- `line-height` ~1.6 for prose, tighter for headings. Prose measure 65-75ch.
- No all-caps sentences; uppercase only for short labels/eyebrows, and drop decorative eyebrows.

## Motion

- 150-250ms, `ease-out` (`cubic-bezier(0.22,1,0.36,1)` or similar). Motion conveys state only.
- **Remove**: entrance choreography (page-load fade/slide reflex applied to everything), shimmer sweeps, pulsing/gradient-shift animations, and the universal hover-lift (`transform: translateY(-Npx)` + bigger shadow) on cards/toggles/buttons.
- Replace hover-lift with a border/background/color shift.
- Keep functional transitions (focus ring, open/close, selection). Every animation needs a `@media (prefers-reduced-motion: reduce)` fallback (already present in several files; keep it).

## Components (consistency)

- One button vocabulary: solid brand primary, neutral secondary (surface + border), solid danger. Same radius (`--radius-sm`), same height, same states (default/hover/focus/active/disabled) across every page.
- Inputs: surface bg, 1px border, `--radius-sm`, visible focus ring in brand hue (no glow).
- Cards/panels: `--radius-md`, opaque surface, hairline border, `--shadow-1` or none.
- Icons: FontAwesome set already in use; uniform size/weight, monochrome in ink or brand. No emoji in chrome.

## Scope note

`theme.css` is loaded first on every page and owns the shared tokens + neutralizers. Per-page inline `<style>` blocks and `admin-imgtc.css` / `mobile-refactor.css` must be swept to remove local gradients/glass/glows/over-rounding/lift and to reference these tokens where practical. Keep behavior and layout identical; this pass is visual treatment only.
