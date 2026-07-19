# Deployment — trykaira.ai

The site is a static Astro build deployed on **Cloudflare Pages**. The domain
`trykaira.ai` is registered at **Namecheap**.

## Cloudflare Pages settings

- Repo: `projectKAIRA/KAIRA`, branch `main`
- Framework preset: **Astro**
- Build command: `npm run build`
- Output directory: `dist`
- Quote form runs as a Pages Function: `functions/api/quote.ts`

### Environment variables (set in the Pages dashboard)

| Name | Purpose |
| --- | --- |
| `PUBLIC_TURNSTILE_SITE_KEY` | Turnstile site key (public) |
| `TURNSTILE_SECRET_KEY` | Turnstile secret key |
| `RESEND_API_KEY` | Resend API key |
| `LEAD_TO_EMAIL` | Inbox that receives quote requests |
| `LEAD_FROM_EMAIL` | Verified Resend sender |

## DNS migration (Railway → Cloudflare Pages)

The domain moved off Railway to Cloudflare Pages by switching Namecheap
nameservers to Cloudflare's. **All email + verification records were preserved;
only the Railway website records were removed.**

### Records to KEEP (Microsoft 365 email + verifications)

```
MX     @                    trykaira-ai.mail.protection.outlook.com   (priority 0)
TXT    @                    v=spf1 include:spf.protection.outlook.com -all
TXT    @                    MS=ms92915748
TXT    @                    google-site-verification=iBfZBUQIgn4oTa8zUwWOxtr9CMffnikt2EblJ5_ZoXs
TXT    _dmarc               v=DMARC1; p=none; rua=mailto:projectkaira.ai@gmail.com; ruf=mailto:projectkaira.ai@gmail.com
CNAME  selector1._domainkey selector1-trykaira-ai._domainkey.projectkaira.a-v1.dkim.mail.microsoft
CNAME  selector2._domainkey selector2-trykaira-ai._domainkey.projectkaira.a-v1.dkim.mail.microsoft
CNAME  autodiscover         autodiscover.outlook.com
```

### Records that were REMOVED (old Railway site)

```
A/CNAME  @     tibbq0i1.up.railway.app
CNAME    www   tibbq0i1.up.railway.app
```

### Custom domains in Cloudflare Pages

- `trykaira.ai`
- `www.trykaira.ai`

Cloudflare provisions the CNAME + SSL automatically once the domain is active.
