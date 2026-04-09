# K.A.I.R.A
**Knowledge-Aware Inbox Response Automation**

A multi-tenant SaaS platform that monitors Microsoft 365 inboxes, extracts structured Purchase Order data from emails and attachments using Claude AI, and routes each document to the customer's connected Slack workspace or Microsoft Teams channel — automatically.

---

## Features

- **Self-serve onboarding** — customers connect their Microsoft 365 inbox and Slack/Teams workspace via OAuth in under two minutes, with no manual setup required
- **Multi-tenant architecture** — each customer gets an isolated polling loop, credential store, and PO tracker; tenants can be added and removed at runtime without a restart
- **PDF & document extraction** — Claude reads PDF, DOCX, XLSX, and image attachments and returns structured PO data: PO number, line items, quantities, pricing, buyer/vendor info, delivery dates, and more
- **Email classification** — emails without recognised attachments are classified as:
  - Purchase Order (text-based)
  - Request for Quote (RFQ)
  - General Inquiry
- **Per-type notification routing** — each category is delivered to the customer's configured Slack channels or Teams webhook
- **Claim Order workflow** — agents click a "Claim Order" button on any Slack PO message; the message updates to show who claimed it, and the agent receives a DM with full PO details and the original document
- **OneDrive / SharePoint link support** — shared file links in email bodies are downloaded and processed like direct attachments
- **IMAP support** — customers not on Microsoft 365 can connect via standard IMAP (Gmail, Yahoo, any provider)
- **Trial management** — self-serve signups start a 14-day trial capped at 100 documents/month; KAIRA notifies the customer when the limit is hit and pauses processing until they upgrade
- **Admin dashboard** — password-protected overview of all tenants, plan tiers, trial status, and monthly usage
- **Swappable notification provider** — Slack or Microsoft Teams, selected per tenant

---

## Architecture

```
Customer browser
      │
      │  GET /onboarding
      ▼
 Onboarding wizard (Step 1: Microsoft OAuth, Step 2: Slack or Teams)
      │
      │  OAuth callbacks exchange tokens → TenantRegistry.create()
      ▼
 Tenant row in SQLite (Prisma)
      │
      │  TenantScheduler.addTenant()
      ▼
 TenantRuntime (per tenant)
      │
      │  polls every N seconds via Microsoft Graph delta query or IMAP
      ▼
 EmailProcessor
      │
      ├─ Recognised attachment (PDF / DOCX / XLSX / image)?
      │       └─ ClaudeService → structured PO data
      │               └─ POTracker (DB) → NotificationService → Slack / Teams
      │
      ├─ OneDrive / SharePoint link in body?
      │       └─ GraphService downloads → same path as attachment above
      │
      └─ Plain-text email
              └─ ClaudeService classifies → NotificationService → appropriate channel

When an agent clicks "Claim Order" in Slack:
  POST /slack/interactions
        ├─ Signature verified (HMAC-SHA256)
        ├─ PO claimed in DB
        ├─ Channel message updated (button → claimed banner)
        └─ DM sent to agent with full PO details + document

Trial enforcement (per cycle, before and after processing):
  TrialGuard.check() → skip cycle if expired or limit reached
  TrialGuard.incrementDocCount() → notify + pause if quota hit
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20+ |
| Language | TypeScript (ESM, NodeNext modules) |
| Database | SQLite via Prisma ORM (`better-sqlite3` adapter) |
| Email — Microsoft | Microsoft Graph API delta queries (`@azure/identity`, `@microsoft/microsoft-graph-client`) |
| Email — Generic | IMAP (`imapflow`) |
| AI / extraction | Anthropic Claude API (`claude-opus-4-6`) |
| Slack integration | Slack Web API (`@slack/web-api`) + OAuth 2.0 + Incoming Webhooks |
| Teams integration | Adaptive Cards via Incoming Webhook |
| HTTP server | Express |
| Auth — onboarding | OAuth 2.0 authorization code flow (Microsoft delegated + Slack) |
| Auth — app-only | Azure AD `ClientSecretCredential` (production tenants) |
| Document parsing | PDFs (native base64), DOCX (`mammoth`), XLSX (`SheetJS`), images (`sharp`) |

---

## Self-Serve Onboarding

Customers sign up without any manual provisioning:

1. Visit `/onboarding` — enter company name
2. Click **Connect Microsoft 365** → Microsoft OAuth consent screen → grants `Mail.Read`
3. Choose notification channel:
   - **Slack** — click **Add to Slack** → OAuth installs the KAIRA bot
   - **Teams** — paste an Incoming Webhook URL from any channel
4. KAIRA creates the tenant, starts monitoring, and posts the first results within one polling interval

Every self-serve tenant starts a **14-day trial** with a 100 document/month quota. When the quota is reached, KAIRA posts an upgrade notice to the customer's workspace and pauses processing until the next calendar month or an upgrade.

---

## Setup (self-hosted)

### Prerequisites

- Node.js 20+
- An **Azure App Registration** for OAuth onboarding:
  - Delegated permissions: `Mail.Read`, `User.Read`, `offline_access`
  - Redirect URI: `https://<your-domain>/onboarding/auth/microsoft/callback`
- A **Slack App** for OAuth onboarding:
  - Bot scopes: `chat:write`, `incoming-webhook`, `files:write`, `channels:read`
  - Redirect URI: `https://<your-domain>/onboarding/auth/slack/callback`
  - Interactivity enabled, Request URL: `https://<your-domain>/slack/interactions`
- An **Anthropic API key**

### Installation

```bash
git clone <repo-url>
cd K.A.I.R.A
npm install
npx prisma migrate deploy
```

### Configuration

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

#### Core

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `CLAUDE_MODEL` | Claude model (default: `claude-opus-4-6`) |
| `DATABASE_URL` | Prisma database URL (default: `file:./prisma/dev.db`) |
| `PORT` | HTTP server port (default: `3000`) |
| `HOST` | HTTP server host (default: `0.0.0.0`) |
| `APP_BASE_URL` | Public URL of this server (e.g. `https://app.kaira.io`) |

#### OAuth — Microsoft (onboarding)

| Variable | Description |
|---|---|
| `OAUTH_MICROSOFT_CLIENT_ID` | Azure App Registration client ID |
| `OAUTH_MICROSOFT_CLIENT_SECRET` | Azure App Registration client secret |
| `OAUTH_MICROSOFT_REDIRECT_URI` | Callback URL (default: `http://localhost:3000/onboarding/auth/microsoft/callback`) |

#### OAuth — Slack (onboarding)

| Variable | Description |
|---|---|
| `OAUTH_SLACK_CLIENT_ID` | Slack App client ID |
| `OAUTH_SLACK_CLIENT_SECRET` | Slack App client secret |
| `OAUTH_SLACK_REDIRECT_URI` | Callback URL (default: `http://localhost:3000/onboarding/auth/slack/callback`) |
| `OAUTH_SLACK_SIGNING_SECRET` | Slack App signing secret (same for all installs) |

#### Admin dashboard

| Variable | Description |
|---|---|
| `ADMIN_PASSWORD` | Password for the `/admin` dashboard (HTTP Basic Auth) |

#### Manual tenant provisioning (optional)

These variables configure a single tenant at startup — useful for development or migrating existing installations. Self-serve tenants created via `/onboarding` do not use these.

| Variable | Description |
|---|---|
| `AZURE_CLIENT_ID` | Azure App client ID (app-only auth) |
| `AZURE_CLIENT_SECRET` | Azure App client secret |
| `AZURE_TENANT_ID` | Azure directory tenant ID |
| `GRAPH_USER_EMAIL` | Mailbox UPN to monitor |
| `GRAPH_INBOX_FOLDER` | Folder to watch (default: `inbox`) |
| `POLL_INTERVAL_SECONDS` | Poll interval in seconds (default: `60`) |
| `NOTIFICATION_PROVIDER` | `slack` or `teams` |
| `SLACK_BOT_TOKEN` | Bot User OAuth Token (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | Slack signing secret |
| `SLACK_PO_CHANNEL` | Channel ID for POs |
| `SLACK_WEBHOOK_RFQ` | Incoming Webhook URL for RFQs |
| `SLACK_WEBHOOK_INQUIRY` | Incoming Webhook URL for inquiries |
| `TEAMS_WEBHOOK_URL` | Teams Incoming Webhook URL |

### Running

```bash
# Development (tsx, no build step)
npm run dev

# Watch mode (restarts on file changes)
npm run watch

# Production
npm run build && npm start
```

---

## API Reference

### Tenant management

| Method | Path | Description |
|---|---|---|
| `GET` | `/tenants` | List all tenants |
| `POST` | `/tenants` | Create a tenant manually |
| `GET` | `/tenants/:id` | Get a single tenant |
| `PATCH` | `/tenants/:id` | Update tenant config (runtime rebuild, no restart) |
| `DELETE` | `/tenants/:id` | Delete tenant and all related data |
| `POST` | `/tenants/:id/activate` | Start polling |
| `POST` | `/tenants/:id/deactivate` | Stop polling (data preserved) |

### Monitoring & operations

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `GET` | `/status` | All tenants — cycle state, last results, PO summary |
| `GET` | `/status/:tenantId` | Single tenant detail |
| `POST` | `/process/now` | Trigger all tenants immediately |
| `POST` | `/process/now?tenantId=<id>` | Trigger a single tenant |

### Onboarding

| Method | Path | Description |
|---|---|---|
| `GET` | `/onboarding` | Step 1 — company name form |
| `POST` | `/onboarding/start` | Begin Microsoft OAuth flow |
| `GET` | `/onboarding/auth/microsoft/callback` | Microsoft OAuth callback |
| `GET` | `/onboarding/step2` | Step 2 — notification channel |
| `GET` | `/onboarding/auth/slack/start` | Begin Slack OAuth flow |
| `GET` | `/onboarding/auth/slack/callback` | Slack OAuth callback |
| `POST` | `/onboarding/teams` | Connect Teams via webhook URL |
| `GET` | `/onboarding/complete` | Success page |

### Other

| Method | Path | Description |
|---|---|---|
| `GET` | `/admin` | Admin dashboard (Basic Auth) |
| `POST` | `/slack/interactions` | Slack button interaction handler |

---

## Database

KAIRA uses SQLite via Prisma. The schema has three models:

- **`Tenant`** — all per-customer config: credentials, notification settings, trial state, monthly usage
- **`TrackedOrder`** — every PO detected, with claim status and Slack message coordinates
- **`DeltaLink`** — Microsoft Graph delta query bookmarks, persisted so polling survives restarts

Run migrations:

```bash
npx prisma migrate deploy   # production
npx prisma migrate dev      # development (also regenerates client)
```

---

## Trial & Billing

Self-serve tenants are created on the **Trial** tier:

- 14-day trial period
- 100 documents per calendar month
- When the limit is hit: `trialLimitReached` is set on the tenant, processing pauses, and a notification is posted to the customer's workspace
- When the trial expires: the tenant is deactivated and an expiry notification is sent
- Monthly counts reset automatically on the first day of each calendar month
- Upgrade a tenant by setting `planTier` to `starter`, `growth`, or `enterprise` and `isTrialActive` to `false` via `PATCH /tenants/:id`

---

## Notification Providers

Set per tenant via `notificationProvider` (`SLACK` or `TEAMS`). No code changes required to switch.

**Slack** — full feature set:
- Rich Block Kit messages with line-item tables
- Interactive "Claim Order" button
- Message updates on claim
- DM with full PO details and document upload

**Microsoft Teams** — Adaptive Card messages:
- Full PO details and line items
- No interactive claim button (Teams webhooks are one-way)
