# Design

The visual system for K-Vault after the "de-slop" pass. The one rule that overrides everything: **brand hues are fixed, only their treatment changes.** When you meet an AI tell, keep the color and change the structure.

## Color

Hues are frozen. Do not introduce new hues, do not change existing ones. What changes is *how* color is applied.

Existing brand hues (keep exactly):
- Purple brand `#8a4bff` (light) / `#9aa9ff` (dark) — index, login, gallery, webdav, notice pages
- Teal brand `#0f766e` / `#0f8f8a` — preview, admin-waterfall, admin UI panel
- Element UI semantic colors (success/warning/danger/info) — keep
- Surface + ink neutrals from theme.css `--ui-*` tokens — keep the hue, may adjust opacity/lightness

Treatment rules (this is where AI-ness is removed):
- **Gradients → flat.** Replace every decorative `linear-gradient` / `radial-gradient` (bodies, buttons, icon chips, cards, headers, batch buttons) with a *solid fill of the same hue*. Use the gradient's dominant/first stop as the solid. A tonal two-stop of the same hue is only allowed on a single hero-scale element if truly needed; default is flat.
- **No gradient text.** No `background-clip: text`. Solid brand color; emphasis via weight/size.
- **No colored glows.** Remove `box-shadow` that uses a brand hue (e.g. `rgba(138,75,255,.2)`, teal glows). Shadows are neutral only.
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
