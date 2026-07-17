# KAIRA

Marketing site for KAIRA — a web design and digital presence agency for local businesses.
Built with [Astro](https://astro.build) + Tailwind CSS, deployed on Cloudflare Pages.

> The previous email-automation application is archived at git tag `legacy-email-automation`
> and branch `archive/email-automation`.

## Develop

```sh
npm install
npm run dev        # http://localhost:4321
npm run build      # static build to ./dist
```

## Deploy (Cloudflare Pages)

- Build command: `npm run build`
- Output directory: `dist`
- The quote form is handled by a Pages Function at `functions/api/quote.ts`
  (Turnstile verification + lead email via Resend).

### Environment variables

| Where | Name | Purpose |
| --- | --- | --- |
| Build | `PUBLIC_TURNSTILE_SITE_KEY` | Turnstile site key (public) |
| Function secret | `TURNSTILE_SECRET_KEY` | Turnstile secret key |
| Function secret | `RESEND_API_KEY` | Resend API key |
| Function secret | `LEAD_TO_EMAIL` | Inbox receiving quote requests |
| Function secret | `LEAD_FROM_EMAIL` | Verified Resend sender |

Without keys set, the form renders with Cloudflare's always-pass Turnstile **test** site key,
and submissions will fail at the email step — set all variables before launch.

Also update the production domain in `astro.config.mjs` (`SITE_URL`) and `public/robots.txt`.
