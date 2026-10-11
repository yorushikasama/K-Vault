# Product

## Register

product

## Users

Self-hosters and small teams who run YoruVault as their own image/file hosting and paste service. They arrive to do one concrete job: upload a file or image, get a link, and later browse, manage, block, or delete what they stored. The admin surfaces (dashboard, WebDAV, waterfall gallery, token management) are used by the operator, not the public.

## Product Purpose

YoruVault is a file/image host that runs on Cloudflare Pages or as a self-hosted Node server, backed by pluggable storage (S3, R2, GitHub, Discord, Telegram, Hugging Face, WebDAV). Success is: the upload/link flow is fast and obvious, the management surfaces are legible under real data density, and the whole thing looks like a deliberate tool rather than a generated template.

## Brand Personality

Calm, competent, unfussy. A utility that gets out of the way. Three words: restrained, legible, trustworthy. The interface should feel like it was made by someone with taste who cared about the defaults, not assembled from trend parts.

## Anti-references

The "AI-generated SaaS template" look: diagonal purple/violet gradient washes, gradient text, frosted-glass cards floating over gradient backgrounds, everything rounded to 16-22px, big soft drop shadows and colored glows, buttons with shimmer sweeps, every card lifting on hover, fade-in/slide-in on everything. We keep our existing brand hues but reject every one of these *treatments*.

## Design Principles

- **Keep the hue, kill the tell.** Brand colors are fixed. AI-ness lives in treatment (gradient, glass, glow, over-round, lift), not in the hue. Change treatment, never the palette.
- **Flat and opaque beats floating glass.** Solid surfaces with hairline borders. Elevation only where it means something (dropdown, modal).
- **One deliberate scale, not one global value.** Radius, spacing, shadow, and type each follow a small intentional scale applied by role, not a single 16px/blur/gradient stamped everywhere.
- **Motion conveys state, not decoration.** 150-250ms, ease-out, on real state changes. No entrance choreography, no hover levitation, no shimmer.
- **Earned familiarity.** The tool should disappear into the task; consistency across screens is a virtue, surprise is not.

## Accessibility & Inclusion

Body text ≥ 4.5:1 contrast against its surface (opaque surfaces make this checkable; glass did not). Full `prefers-reduced-motion` support. Touch targets ≥ 40px on mobile. Keep both light and dark themes working.
