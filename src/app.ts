import express, { Request, Response } from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { TenantScheduler } from "./services/tenant/TenantScheduler.js";
import { CLAIM_ACTION_ID } from "./services/notifications/SlackNotificationService.js";
import { POTracker } from "./services/po/POTracker.js";
import { createTenantsRouter } from "./routes/tenants.js";
import { createOnboardingRouter } from "./routes/onboarding.js";
import { createAdminRouter } from "./routes/admin.js";
import { createStripeRouter } from "./routes/stripe.js";
import { createSlackRouter } from "./routes/slack.js";
import { createDashboardRouter } from "./routes/dashboard.js";
import { createAccountRouter } from "./routes/account.js";
import { createTeamsRouter } from "./routes/teams.js";
import { createSlackCommandsRouter } from "./routes/slackCommands.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createApp(scheduler: TenantScheduler): express.Application {
  const app = express();

  // ─── Stripe webhook ───────────────────────────────────────────────────────
  // Must be mounted BEFORE express.json() — Stripe requires the raw request body.
  app.use("/stripe", createStripeRouter());

  app.use(express.json());

  // ─── Landing page ─────────────────────────────────────────────────────────

  const publicDir = join(__dirname, "public");
  app.use(express.static(publicDir));
  app.get("/", (_req: Request, res: Response) => {
    res.sendFile(join(publicDir, "index.html"));
  });
  app.get("/terms",   (_req: Request, res: Response) => res.sendFile(join(publicDir, "terms.html")));
  app.get("/privacy", (_req: Request, res: Response) => res.sendFile(join(publicDir, "privacy.html")));

  // ─── Admin dashboard ─────────────────────────────────────────────────────

  app.use("/admin", createAdminRouter(scheduler));

  // ─── Self-serve onboarding ────────────────────────────────────────────────
  // All onboarding pages and OAuth callbacks are under /onboarding.
  // Configure your OAuth app redirect URIs as:
  //   Microsoft: https://<host>/onboarding/auth/microsoft/callback
  //   Slack:     https://<host>/onboarding/auth/slack/callback

  app.use("/onboarding", createOnboardingRouter(scheduler));

  // ─── Slack OAuth connect (post-onboarding) ────────────────────────────────
  // Used from the dashboard to connect / reconnect Slack for an existing tenant.
  // Redirect URI registered in Slack app: https://trykaira.ai/auth/slack/callback

  app.use("/auth/slack", createSlackRouter(scheduler));

  // ─── Customer dashboard ────────────────────────────────────────────────────
  // GET  /dashboard?t=<tenantId>               — account overview
  // POST /dashboard/teams-webhook?t=<tenantId> — save Teams webhook URL

  app.use("/dashboard", createDashboardRouter(scheduler));

  // ─── My Account — email-based dashboard link recovery ────────────────────
  // GET  /account          — email input form
  // POST /account/lookup   — sends recovery email

  app.use("/account", createAccountRouter());

  // ─── Teams claim page ─────────────────────────────────────────────────────
  // GET  /teams/claim/:id  — view PO details and claim form
  // POST /teams/claim/:id  — submit claim (name required)

  app.use("/teams/claim", createTeamsRouter(scheduler));

  // ─── Tenant CRUD ─────────────────────────────────────────────────────────

  app.use("/tenants", createTenantsRouter(scheduler));

  // ─── Health ───────────────────────────────────────────────────────────────

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", service: "KAIRA", timestamp: new Date().toISOString() });
  });

  // ─── Status (all tenants) ─────────────────────────────────────────────────
  // Returns a snapshot of every registered tenant: cycle state, last results,
  // and a full PO claim summary with unclaimed/recently-claimed detail lists.

  app.get("/status", async (_req: Request, res: Response) => {
    const tenantStatuses = scheduler.getStatus();

    const enriched = await Promise.all(
      tenantStatuses.map(async (ts) => {
        const runtime = scheduler.getRuntime(ts.tenantId);
        const purchaseOrders = runtime ? await buildPoSummary(runtime.tracker) : null;
        return { ...ts, purchaseOrders };
      }),
    );

    res.json({
      service:     "KAIRA",
      tenantCount: enriched.length,
      tenants:     enriched,
    });
  });

  // ─── Status (single tenant) ───────────────────────────────────────────────
  // GET /status/:tenantId
  // Detailed view for one tenant — same shape as a single entry in /status.

  app.get("/status/:tenantId", async (req: Request, res: Response) => {
    const tenantId = req.params["tenantId"] as string;
    const runtime = scheduler.getRuntime(tenantId);

    if (!runtime) {
      res.status(404).json({ error: `Tenant not found or not active: ${tenantId}` });
      return;
    }

    const cycleStatus  = scheduler.getStatus().find((s) => s.tenantId === tenantId) ?? null;
    const purchaseOrders = await buildPoSummary(runtime.tracker);

    res.json({
      ...cycleStatus,
      purchaseOrders,
    });
  });

  // ─── Manual trigger ───────────────────────────────────────────────────────
  // POST /process/now                 — triggers all registered tenants
  // POST /process/now?tenantId=<id>   — triggers a single tenant

  app.post("/process/now", async (req: Request, res: Response) => {
    const { tenantId } = req.query as { tenantId?: string };

    if (tenantId) {
      const runtime = scheduler.getRuntime(tenantId);
      if (!runtime) {
        res.status(404).json({ error: `Tenant not found: ${tenantId}` });
        return;
      }
      // Fire and forget — respond immediately
      res.json({ message: `Processing cycle started for tenant ${tenantId}.` });
      void scheduler.runNow(tenantId);
      return;
    }

    // No tenantId — trigger all
    const runtimes = scheduler.getAllRuntimes();
    if (runtimes.length === 0) {
      res.status(503).json({ error: "No active tenants are registered." });
      return;
    }

    res.json({ message: `Processing cycle started for ${runtimes.length} tenant(s).` });
    for (const rt of runtimes) {
      void scheduler.runNow(rt.tenantId);
    }
  });

  // ─── Slack Slash Commands ─────────────────────────────────────────────────
  // POST /slack/commands — handles /orders (and future commands).
  // express.raw() is applied inside the router for signature verification.

  app.use("/slack/commands", createSlackCommandsRouter(scheduler));

  // ─── Slack Interactions ───────────────────────────────────────────────────
  // Uses express.raw() so the raw body bytes are available for HMAC-SHA256
  // signature verification before parsing.
  //
  // The Claim Order button value is "<trackingId>".  We look up which tenant
  // owns that order, then dispatch to that tenant's SlackInteractionService.

  app.post(
    "/slack/interactions",
    express.raw({ type: "*/*" }),
    async (req: Request, res: Response) => {
      // Respond 200 immediately — Slack requires a response within 3 seconds.
      res.sendStatus(200);

      const rawBody  = (req.body as Buffer).toString("utf8");
      const timestamp = (req.headers["x-slack-request-timestamp"] as string) ?? "";
      const signature = (req.headers["x-slack-signature"]          as string) ?? "";

      // Extract the tracking ID from the payload before tenant lookup so we
      // can route to the correct interactions service for signature verification.
      const trackingId = extractTrackingId(rawBody);
      if (!trackingId) {
        console.warn("[App] Could not extract tracking ID from Slack payload.");
        return;
      }

      const runtime = await scheduler.findRuntimeByOrderId(trackingId);
      if (!runtime) {
        console.warn(`[App] No runtime found for order ${trackingId}.`);
        return;
      }

      if (!runtime.interactions) {
        console.warn(
          `[App] Tenant "${runtime.config.name}" received a Slack interaction ` +
          `but SlackInteractionService is not configured.`,
        );
        return;
      }

      if (!runtime.interactions.verifySignature(rawBody, timestamp, signature)) {
        console.warn("[App] Slack interaction failed signature verification — ignoring.");
        return;
      }

      await runtime.interactions.handleInteraction(rawBody);
    },
  );

  return app;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a rich PO summary for a single tenant's tracker.
 * Returned as the `purchaseOrders` field in both /status and /status/:tenantId.
 */
async function buildPoSummary(tracker: POTracker) {
  const [summary, unclaimed, claimed] = await Promise.all([
    tracker.summary(),
    tracker.getUnclaimed(),
    tracker.getClaimed(),
  ]);

  return {
    total:    summary.total,
    unclaimed: summary.unclaimed,
    claimed:  summary.claimed,
    unclaimedOrders: unclaimed.map((po) => ({
      id:         po.id,
      poNumber:   po.purchaseOrder.poNumber,
      from:       po.email.sender,
      receivedAt: po.receivedAt,
      total:      po.purchaseOrder.total,
      currency:   po.purchaseOrder.currency,
    })),
    recentlyClaimed: claimed.slice(0, 5).map((po) => ({
      id:        po.id,
      poNumber:  po.purchaseOrder.poNumber,
      claimedBy: po.claimedByName,
      claimedAt: po.claimedAt,
    })),
  };
}

/**
 * Pull the tracking ID out of a URL-encoded Slack interaction payload without
 * fully parsing the JSON — used for early tenant routing before verification.
 */
function extractTrackingId(rawBody: string): string | null {
  try {
    const params      = new URLSearchParams(rawBody);
    const payloadJson = params.get("payload");
    if (!payloadJson) return null;

    const payload = JSON.parse(payloadJson) as {
      type?: string;
      actions?: Array<{ action_id?: string; value?: string }>;
    };

    if (payload.type !== "block_actions") return null;

    const claimAction = payload.actions?.find((a) => a.action_id === CLAIM_ACTION_ID);
    return claimAction?.value ?? null;
  } catch {
    return null;
  }
}
