# KAIRA — React + Vite + Tailwind + shadcn/ui Rewrite

## Original Problem Statement (last major turn)
> Rewrite this app using React with Vite, Tailwind, and shadcn/ui. Remove all Astro-specific code and configuration. Keep exactly the same design, layout, and visual style.

## Architecture
- **Frontend** (`/app/frontend/`): React 18 + Vite 5 + Tailwind CSS 3 + shadcn/ui (Radix primitives, class-variance-authority, tailwind-merge, clsx). react-router-dom for routing. three.js retained for potential 3D work.
- **Backend** (`/app/backend/`): FastAPI 0.115 + uvicorn. Endpoints: `/api/health`, `/api/quote`. No DB writes (marketing site).
- **Deployment**: `/app/backend` + `/app/frontend` layout matches Emergent expectations. Vite `envPrefix: ['VITE_', 'REACT_APP_']` so `REACT_APP_BACKEND_URL` is exposed to the client.

## What's Implemented
- All 9 routes (Home, Services, Portfolio, Pricing, About, Contact, Privacy, Terms, NotFound) ported to JSX with pixel-parity to the previous Astro version.
- Home landing has: split hero + rotating showcase (Café / Dental / Barber, 3.8s cycle), cursor-following spotlight, magnetic primary CTA, tilt on the browser frame, marquee, bento grid (speed gauge, map pin, care shield, device stack, palette, timeline turnaround), animated count-up stats, family tiles, 4-step process, pricing teaser, final CTA.
- Geometric K logo (`Logo.jsx`) — gradient-filled, replaces the butterfly across nav + footer + favicon.
- shadcn `Button` (primary/ghost/outline/link × sm/default/lg), `Input`, `Textarea`, `Select`, `Label`.
- `useReveal` hook re-runs on every route change, splits `.reveal-words` text nodes into `<span class="w">` while preserving inline gradient spans.
- Contact form submits to `${REACT_APP_BACKEND_URL}/api/quote`. Turnstile removed (Cloudflare-only; can be reintroduced later if needed).
- `robots.txt`, `favicon.svg` (K monogram) preserved in `public/`.

## Removed
- Astro 5 + all `*.astro` files
- `astro.config.mjs`, `tsconfig.json`, Astro sitemap integration
- Cloudflare Pages Function `functions/api/quote.ts`
- `wrangler.toml`
- Butterfly-rider (sci-fi) component and orphan HeroScene/RenderScene/ScrollScene/BigStatement/ChipLineup

## Deployment Status
- Deployment agent: **PASS**, 0 blockers, 0 warnings
- Backend: `curl :8001/api/health` → 200
- Frontend: `yarn build` → 259 KB gzipped JS + 51 KB CSS
- Preview site verified visually on all 9 pages
