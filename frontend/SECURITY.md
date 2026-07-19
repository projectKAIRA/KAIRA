# Security

## Credentials the agency site uses

The static site needs **no** secrets to build. The quote form (a Cloudflare
Pages Function) uses these, set in the Cloudflare Pages dashboard — never
committed:

- `PUBLIC_TURNSTILE_SITE_KEY` (build-time, public)
- `TURNSTILE_SECRET_KEY`
- `RESEND_API_KEY`
- `LEAD_TO_EMAIL`
- `LEAD_FROM_EMAIL`

No Stripe keys are used. Payments are handled manually via the Stripe Dashboard
(manual invoicing + manually created subscriptions) until the business is
validated. Do not add Stripe API keys or webhook secrets to this project until a
real Checkout/subscription flow is built.

## Rotate exposed legacy credentials

The old email-automation app's local `.env` held **live** credentials in
plaintext. That file was never committed (git history is clean — verified), but
the values were exposed locally and must be **rotated/revoked** at their source.
Removing them from the file does not revoke them. Check each off:

- [ ] **Stripe** — roll the live secret key (`sk_live_…`) in the Stripe Dashboard → Developers → API keys
- [ ] **Stripe** — regenerate the webhook signing secret (`whsec_…`), or delete the endpoint if unused
- [ ] **Anthropic** — revoke the API key (`sk-ant-…`) in the Anthropic Console
- [ ] **Microsoft / Azure AD** — rotate the app client secret (used for both `AZURE_CLIENT_SECRET` and the Microsoft OAuth secret)
- [ ] **Slack** — rotate the app client secret in the Slack app config
- [ ] **Admin** — retire the old plaintext admin password; do not reuse it anywhere
- [ ] **Database** — if the old Postgres instance is still reachable, rotate its credentials / shut it down

## Ongoing hygiene

- Secrets live only in the Cloudflare Pages dashboard (runtime) and local `.env` (gitignored) — never in source or committed files.
- `.env`, `.env.*`, `*.env`, and backup env files are gitignored; `.env.example` (no values) is the only committed template.
- Never paste real secret values into commits, issues, or docs.
