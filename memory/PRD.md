# KAIRA — Full Site Bright/Airy Apple Redesign

## Original Problem Statement
> Look at the landing page for Kaira. I want you to change it and make it better. You can redesign the logo if you'd like. Take inspiration from Apple.com and add some 3d visuals and fun images.
> **Follow-up:** Ok, the landing page is still very buggy. But after fix that, please modify all of the rest of the pages to match

## User Choices
- Product: Kaira — web design + digital-presence agency for local businesses
- Mood: **Bright & airy** (Apple.com default)
- 3D: Mix of Three.js and CSS
- Content: refresh landing copy
- Font: SF Pro

## Architecture
- Astro 5 static site, Tailwind 4, Three.js
- Astro dev on port 3000, `allowedHosts: true`
- Global theme in `/app/src/styles/global.css` (single source of truth for tokens)
- Landing page uses custom Apple-hero components inline in `/app/src/pages/index.astro`
- Inner pages reuse legacy structure but auto-adapt to the new light tokens

## Bug Fixes This Iteration
- **[Latest]** New geometric "K" logo replaces the butterfly across nav, footer, favicon
- **[Latest]** Bento grid section added (speed gauge, map pin, care shield, device art, palette, timeline)
- **[Latest]** Live count-up on stats (0 → target on scroll into view)
- **[Latest]** Device stack: floating phone alongside the hero browser mockup
- **Invisible headline words** on landing (e.g. "small business in town?") — the reveal-words script split each word into a `<span class="w">`, but `.k-grad` used `background-clip:text` + `color:transparent`, making inner spans invisible. Fixed by renaming `.k-grad` → `.grad-text` so the script treats it as a single revealed unit.
- Removed `body:has(.kaira-landing)` scoped overrides — no longer needed since global theme is now light.

## Global Theme Migration (this iteration)
- `global.css` flipped: `--color-ink` (dark on light), Apple SF Pro font stack, Apple blue accent (`#0071e3`), `--color-violet` → Apple black `#1d1d1f` (so all `bg-violet` CTAs are now Apple-black pills), spectrum gradient blue→violet→red.
- `.glass` → light white glassmorphism
- `.mesh-bg` → bright aurora + subtle grid
- `.grad-border` → light card with colored hairline
- `.hud-label`, `.pill`, `.status-dot` → light-friendly Apple caption styling
- New `.dark-panel` utility for intentional dark showcase surfaces (used by portfolio mockups and services RenderScene)
- Removed film grain (`body::after`) — didn't fit Apple aesthetic
- Removed reflexive `[class*="text-white/"]` fallback (would have broken dark-panel children)

## Component Updates
- **Nav.astro**: light bg with 70% white/blur, Apple-black CTA button, spectrum underline hover
- **Footer.astro**: `#f5f5f7` bg (Apple's classic footer gray), spectrum hairline, subtle transitions
- **ButterflyRider.astro**: hidden site-wide via `.hidden` class (sci-fi purple butterfly didn't fit)
- **RenderScene.astro**: wrapper switched from `.glass` → `.dark-panel` so its 3D holographic content sits on a dark rounded "device" against the light page — reads intentional
- **Base.astro** unchanged (reveal engine still works)

## Per-Page Updates
- **index.astro**: k-grad → grad-text fix, removed scoped landing overrides, kept Apple hero with Three.js gem, tilting browser mock, floating badges, marquee, stat pills, product tiles, process cards, pricing teaser, aurora CTA
- **services.astro**: dark divider → light, dark-panel RenderScene, keeps all copy/structure
- **portfolio.astro**: dark mockup screens wrapped in `.dark-panel` (intentional showcase devices), concept badge lightened, all outer text uses light tokens
- **pricing.astro**: "MOST POPULAR" badge flipped to light, CTA buttons updated (featured = Apple black, others = white with border)
- **about.astro**: token-driven, works out of the box
- **contact.astro**: entire form rewritten with `.kaira-input` (white inputs, black focus ring), Turnstile switched to `data-theme="light"`, service pills styled for light, submit is Apple-black
- **privacy.astro / terms.astro**: divider chars replaced with `·`, tokens do the rest
- **404.astro**: divider replaced, keeps existing structure

## Verified Working (visual pass)
- /  /services  /portfolio  /pricing  /about  /contact  /privacy  /terms  /404 — all bright, airy, consistent

## Backlog
- P2: Real portfolio thumbnails inside the hero browser mockup
- P2: New logo mark (butterfly kept for continuity)
- P3: Testimonials section on landing
- P3: Case study deep dives on portfolio items

## Next Action Items
- User feedback on the new site-wide direction
- Optionally replace hero mockup with an actual client-site carousel
