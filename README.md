# K.A.I.R.A
**Knowledge-Aware Inbox Response Automation**

An AI-powered email monitoring system built for **Lee Spring**. KAIRA watches a Microsoft Outlook inbox, classifies incoming emails using Claude AI, extracts structured Purchase Order data from PDF attachments, and routes each message to the appropriate Slack channel — automatically.

---

## Features

- **Automated inbox monitoring** via Microsoft Graph API delta queries (polls on a configurable interval)
- **PDF Purchase Order extraction** — when a PDF attachment is detected, Claude reads it and returns structured data: PO number, line items, quantities, pricing, buyer/vendor info, delivery dates, and more
- **Email classification** — emails without PDF attachments are classified as one of:
  - Purchase Order (text-based)
  - Request for Quote (RFQ)
  - General Inquiry
- **Per-type Slack routing** — each category is delivered to its own channel:
  - `#purchase-orders` — PDF purchase orders with full structured data
  - `#request-for-quote` — RFQ emails
  - `#general-inquiry` — general inquiries
- **Claim Order workflow** — agents can click a "Claim Order" button on any PO message; the message updates to show who claimed it and when, and the agent receives a Slack DM with the full PO details and the original PDF
- **Claim status tracking** — unclaimed and claimed POs are tracked in memory and visible at the `/status` endpoint
- **Swappable notification provider** — Slack can be replaced with Microsoft Teams by changing one environment variable (`NOTIFICATION_PROVIDER=teams`)
- **HTTP API** for health checks, status inspection, and manual processing triggers

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20+ |
| Language | TypeScript (NodeNext modules) |
| Email access | Microsoft Graph API (`@azure/identity`, `@microsoft/microsoft-graph-client`) |
| AI / extraction | Anthropic Claude API (`claude-opus-4-6`, adaptive thinking) |
| Slack integration | Slack Web API (`@slack/web-api`) + Incoming Webhooks |
| HTTP server | Express |
| Scheduling | node-cron |
| Auth flow | Azure AD Device Code (delegated, for personal Outlook accounts) |

---

## How It Works

```
Outlook Inbox (Microsoft Graph API)
        │
        │  polls every N seconds via delta query
        ▼
 EmailProcessor
        │
        ├─ PDF attachment detected?
        │       │
        │       ▼
        │   ClaudeService — extracts structured PO data from PDF
        │       │
        │       ▼
        │   POTracker — assigns tracking ID, stores PO in memory
        │       │
        │       ▼
        │   SlackNotificationService — posts to #purchase-orders
        │       with a "Claim Order" button
        │
        └─ No PDF?
                │
                ▼
            ClaudeService — classifies email (RFQ / Text PO / General Inquiry)
                │
                ▼
            SlackNotificationService — posts to the appropriate channel
                via Incoming Webhook

When an agent clicks "Claim Order" in Slack:
  POST /slack/interactions
        │
        ▼
  SlackInteractionService
        ├─ Verifies Slack request signature (HMAC-SHA256)
        ├─ Claims the PO in POTracker
        ├─ Updates the original channel message (button → claimed banner)
        └─ Opens a DM to the agent with full PO details + PDF attachment
```

---

## Setup

### Prerequisites

- Node.js 20+
- An **Azure App Registration** with:
  - `Mail.Read` delegated permission
  - "Allow public client flows" enabled (for device code auth)
- A **Slack App** with:
  - Bot token scopes: `chat:write`, `im:write`, `im:open`, `files:write`, `channels:read`
  - Interactivity enabled, with Request URL pointing to `/slack/interactions`
  - Incoming Webhooks configured for each channel
  - Bot added as a member of `#purchase-orders`
- An **Anthropic API key**

### Installation

```bash
git clone <repo-url>
cd K.A.I.R.A
npm install
```

### Configuration

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

| Variable | Description |
|---|---|
| `AZURE_CLIENT_ID` | Azure App Registration client ID |
| `AZURE_TENANT_ID` | Tenant ID (`consumers` for personal Outlook accounts) |
| `GRAPH_INBOX_FOLDER` | Inbox folder to monitor (default: `inbox`) |
| `POLL_INTERVAL_SECONDS` | How often to check for new emails (default: `60`) |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `CLAUDE_MODEL` | Claude model to use (default: `claude-opus-4-6`) |
| `NOTIFICATION_PROVIDER` | `slack` or `teams` |
| `SLACK_BOT_TOKEN` | Bot User OAuth Token (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | From Slack App → Basic Information → App Credentials |
| `SLACK_PO_CHANNEL` | Channel ID for purchase orders (e.g. `C0AP8UPMWPM`) |
| `SLACK_WEBHOOK_PO` | Incoming Webhook URL for `#purchase-orders` |
| `SLACK_WEBHOOK_RFQ` | Incoming Webhook URL for `#request-for-quote` |
| `SLACK_WEBHOOK_INQUIRY` | Incoming Webhook URL for `#general-inquiry` |
| `SLACK_BOT_NAME` | Display name for the bot (default: `KAIRA`) |
| `PORT` | HTTP server port (default: `3000`) |
| `HOST` | HTTP server host (default: `0.0.0.0`) |
| `TEAMS_WEBHOOK_URL` | Teams Incoming Webhook URL (only if using Teams) |

### Running

```bash
# Development
npm run dev

# Watch mode (auto-restarts on file changes)
npm run watch
```

On first run, KAIRA will print a device code authentication URL. Open it in a browser, sign in with the monitored Outlook account, and KAIRA will begin polling automatically.

### Exposing the Slack Interactions Endpoint (local development)

Slack requires a publicly accessible URL for the "Claim Order" button to work. Use [ngrok](https://ngrok.com) to expose your local server:

```bash
ngrok http 3000
```

Then set the Interactivity Request URL in your Slack App settings to:
```
https://<your-ngrok-id>.ngrok-free.app/slack/interactions
```

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `GET` | `/status` | Processing summary + unclaimed/claimed PO list |
| `POST` | `/process/now` | Manually trigger a processing cycle |
| `POST` | `/slack/interactions` | Slack button interaction handler |

---

## Switching to Microsoft Teams

Set `NOTIFICATION_PROVIDER=teams` and `TEAMS_WEBHOOK_URL=<your-webhook-url>` in `.env`. No code changes required.

---

*Built for Lee Spring — powered by Claude AI and Microsoft Graph*
