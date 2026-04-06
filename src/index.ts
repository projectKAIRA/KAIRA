import "dotenv/config";
import cron from "node-cron";
import { config } from "./config/index.js";
import { TenantRuntime } from "./services/tenant/TenantRuntime.js";
import { TenantConfig } from "./types/tenant.js";
import { createApp } from "./app.js";

async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║   K.A.I.R.A — Inbox Response Automation          ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log();

  // ─── Build a TenantConfig from the single-tenant .env settings ───────────
  // This shim keeps the single-tenant workflow alive until Phase 6 (TenantScheduler)
  // loads tenants from the database instead.

  const singleTenantConfig: TenantConfig = {
    id:       "single-tenant",
    name:     "Default (single-tenant)",
    isActive: true,

    graph: {
      clientId:            config.graph.clientId,
      clientSecret:        config.graph.clientSecret,
      tenantId:            config.graph.tenantId,
      userEmail:           config.graph.userEmail,
      inboxFolder:         config.graph.inboxFolderName,
      pollIntervalSeconds: config.graph.pollIntervalSeconds,
    },

    notification: {
      provider: config.notification.provider,
    },

    slack: {
      botToken:       config.notification.slack.botToken       || null,
      signingSecret:  config.notification.slack.signingSecret  || null,
      webhookRfq:     config.notification.slack.webhookRfq     || null,
      webhookInquiry: config.notification.slack.webhookInquiry || null,
      poChannelId:    config.notification.slack.poChannel      || null,
      botName:        config.notification.slack.botName,
    },

    teams: {
      webhookUrl: config.notification.teams.webhookUrl || null,
    },

    createdAt: new Date(),
    updatedAt: new Date(),
  };

  // ─── Instantiate all services via TenantRuntime ───────────────────────────

  const runtime = new TenantRuntime(
    singleTenantConfig,
    config.claude.apiKey,
    config.claude.model,
  );

  console.log(`[KAIRA] Notification provider: ${runtime.notifier.name}`);
  if (runtime.interactions) {
    console.log("[KAIRA] Slack interactions enabled → POST /slack/interactions");
  } else if (config.notification.provider === "slack") {
    console.warn("[KAIRA] SLACK_SIGNING_SECRET not set — Claim Order button will not work.");
  }

  // ─── HTTP server ──────────────────────────────────────────────────────────

  const app = createApp(runtime.processor, runtime.tracker, runtime.interactions);
  const server = app.listen(config.server.port, config.server.host, () => {
    console.log(`[KAIRA] HTTP server listening on http://${config.server.host}:${config.server.port}`);
    console.log(`[KAIRA] Endpoints:`);
    console.log(`         GET  /health              — health check`);
    console.log(`         GET  /status              — run summary + PO claim status`);
    console.log(`         POST /process/now         — trigger a cycle manually`);
    console.log(`         POST /slack/interactions  — Slack button handler`);
    console.log();
  });

  // ─── Polling ──────────────────────────────────────────────────────────────

  const intervalSeconds = config.graph.pollIntervalSeconds;
  console.log(`[KAIRA] Polling every ${intervalSeconds}s for new messages in "${config.graph.inboxFolderName}"...`);

  let cycleRunning = false;

  await runCycle();

  cron.schedule(buildCronExpression(intervalSeconds), async () => {
    await runCycle();
  });

  async function runCycle() {
    if (cycleRunning) {
      console.log("[KAIRA] Previous cycle still running, skipping.");
      return;
    }
    cycleRunning = true;
    try {
      const results = await runtime.processor.runCycle();
      const summary = results.map((r) => `${r.action}:${r.details ?? r.error ?? "ok"}`).join(", ") || "none";
      console.log(`[KAIRA] Cycle complete. Results: [${summary}]`);
    } catch (err) {
      console.error("[KAIRA] Unhandled error in polling cycle:", err);
    } finally {
      cycleRunning = false;
    }
  }

  // ─── Graceful shutdown ────────────────────────────────────────────────────

  process.on("SIGTERM", () => { console.log("\n[KAIRA] Shutting down..."); server.close(() => process.exit(0)); });
  process.on("SIGINT",  () => { console.log("\n[KAIRA] Shutting down..."); server.close(() => process.exit(0)); });
}

function buildCronExpression(intervalSeconds: number): string {
  if (intervalSeconds < 60) return `*/${intervalSeconds} * * * * *`;
  const m = Math.floor(intervalSeconds / 60);
  if (m < 60) return `0 */${m} * * * *`;
  return `0 0 */${Math.floor(m / 60)} * * *`;
}

main().catch((err) => {
  console.error("[KAIRA] Fatal startup error:", err);
  process.exit(1);
});
