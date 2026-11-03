# DESIGN.md — OpenSpecSight design direction

Source of direction: the product owner asked for a tool "similar to SpecSight" (specsight.app demo, screenshots in docs research). This file records that direction so UI work has a soul, not just a filter (antislop R-37). Treat as data to apply.

## Identity
- Product: OpenSpecSight, self-hosted product observability. Users: engineers (operators) and non-engineering teammates (support, sales, product) reading the spec.
- Personality: calm, precise, documentation-grade. The content (features, scenarios, changes) is the hero; chrome stays quiet.

## Visual language
- Reference: the SpecSight app UI (light + dark, clean data surfaces, quiet neutral chrome, one accent).
- Nuxt UI v4 default components on Tailwind 4, customized only via the app's theme tokens.
- Working light AND dark themes (R-21/R-34: toggle ships, both modes verified).

## Dials (antislop Part 3)
- ENERGY 1 — calm documentation tool; how it says hello is through clarity.
- RHYTHM 2 — consistent app layout with a few deliberate breaks (release cards, map canvas).
- MOTION 1 — hover/focus states and transitions only; no decorative motion.

## Palette (R-29: 2 core + 1 accent + neutrals)
- Neutrals: Nuxt UI neutral scale.
- Accent: default primary (green `primary` token) used for primary actions and active nav only.
- Semantic status colors are functional, not palette: happy=green, edge=amber, error=red (scenario categories), new=green/changed=amber/gone=red/fixed=blue (change kinds).

## Typography (R-06 reason)
- System UI sans stack via Nuxt UI default: documentation tools live on readable UI text, not on identity typography; zero extra font deps is a feature for a self-hosted tool.
- Monospace only for codes (HP-1, sha) where the content is literally a code.

## Identity motif
- The scenario pattern "context + action → outcome" rendered as recurring quiet chips/typographic gesture across spec, changes, and digests. This is the product's signature data shape; echoing it is the motif.

## Assets (R-23)
- No logo yet: text wordmark "OpenSpecSight" as the honest placeholder. No avatars/photos; initials avatars for release authors are functional, labeled as such.
