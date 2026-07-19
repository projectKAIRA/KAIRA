# KAIRA — Landing Page Redesign

## Original Problem Statement
> Look at the landing page for Kaira. I want you to change it and make it better. You can redesign the logo if you'd like. Take inspiration from Apple.com and add some 3d visuals and fun images.

## User Choices
- Product: Kaira is a web design + digital-presence agency for local businesses (sites from $1,000, care from $75/mo, SEO). Astro + Tailwind on Cloudflare Pages, `trykaira.ai`.
- Mood: **Bright & airy** (Apple.com default)
- 3D: **Mix of Three.js and CSS/animated 3D**
- Content: **Refresh landing copy** — do NOT touch anything else besides the landing page
- Type: **SF Pro** (Apple system font stack)

## Architecture
- Astro 5 static site + Tailwind 4 + Three.js (already installed)
- Astro dev server on port 3000, `allowedHosts: true` (added for Emergent preview)
- All changes limited to `/app/src/pages/index.astro` (and `astro.config.mjs` for host allow)
- Landing-only style overrides scoped via `body:has(.kaira-landing)` selectors → other pages untouched

## What's Implemented (2026-01-19)
- New Apple-inspired bright/airy hero: big serif-less display type, gradient accent word "inevitable.", soft aurora blobs, subtle grid mask, animated CTA row, status pill "Now booking Spring '26 projects"
- **3D hero stage**:
  - Three.js: iridescent shader gem + wire icosahedron + two orbit rings + 3 orbiting spheres + particle field, pointer parallax
  - CSS 3D tilting mock browser window (perspective + mousemove) showing a mini KAIRA site
  - Three floating glass badges (Lighthouse 98, First-paint 0.4s, SEO #1)
- Marquee of local-business types (Cafés, Barbershops, Dentists…) — infinite scroll
- Big statement moment: "Your storefront never sleeps. Make it worth showing up to."
- Stat pill row: $1,000 · <1s · 95+ · 24/7 (gradient numbers, tabular)
- "Kaira family" product tiles (Websites, Local SEO, Care Plans) — Apple product-lineup style with custom gradient SVG illustrations + tilt-on-hover
- 4-step process cards (Discovery → Grow) with gradient step numbers
- Pricing teaser card ($1,000/site) with light pastel gradient
- Final CTA section with aurora blob backdrop
- Light-adapted Nav + Footer (only on landing) via `:has()` scoped overrides
- ButterflyRider hidden on landing for Apple-clean feel
- SF Pro Display font stack, refined type scale, text-wrap balance
- `prefers-reduced-motion` respected across all animations
- data-testid attributes on all interactive/critical elements

## Pages Untouched (verified)
- /services, /portfolio, /pricing, /about, /contact, /privacy, /terms — all keep original dark theme

## Backlog / Future
- P1: Extend the Apple-airy aesthetic to inner pages if the user likes the new direction
- P2: Add real portfolio thumbnails inside the hero browser mockup
- P2: Redesign logo mark (user offered) — currently the butterfly is unchanged on inner pages
- P3: Add case study cards / testimonials section on landing
- P3: Lottie or GLB models for even richer 3D on wider viewports

## Next Action Items
- Wait for user feedback on the new landing direction; iterate on copy/visuals if needed
- Optionally propagate the light theme to inner pages (currently dark)
