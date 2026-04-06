import "dotenv/config";
import cron from "node-cron";
import { config } from "./config/index.js";
import { GraphService } from "./services/graph/GraphService.js";
import { ClaudeService } from "./services/claude/ClaudeService.js";
import { POTracker } from "./services/po/POTracker.js";
import { createNotificationService } from "./services/notifications/createNotificationService.js";
import { SlackNotificationService } from "./services/notifications/SlackNotificationService.js";
import { SlackInteractionService } from "./services/notifications/SlackInteractionService.js";
import { EmailProcessor } from "./services/email/EmailProcessor.js";
import { createApp } from "./app.js";

async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║   K.A.I.R.A — Inbox Response Automation          ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log();

  // ─── Core services ────────────────────────────────────────────────────────

  // "single-tenant" is a stable placeholder key used for the DeltaLink FK
  // until the multi-tenant scheduler (Phase 4) takes over wiring.
  const graphService = new GraphService("single-tenant", {
    tenantId:           config.graph.tenantId,
    clientId:           config.graph.clientId,
    clientSecret:       config.graph.clientSecret,
    userEmail:          config.graph.userEmail,
    inboxFolder:        config.graph.inboxFolderName,
    pollIntervalSeconds: config.graph.pollIntervalSeconds,
  });

  const claudeService = new ClaudeService(config.claude.apiKey, config.claude.model);

  const tracker = new POTracker();

  const notifier = createNotificationService(tracker);
  console.log(`[KAIRA] Notification provider: ${notifier.name}`);

  // ─── Slack interaction service (only when using Slack) ────────────────────

  let interactions: SlackInteractionService | null = null;
  if (notifier instanceof SlackNotificationService) {
    const { signingSecret } = config.notification.slack;
    if (signingSecret) {
      interactions = new SlackInteractionService(signingSecret, notifier, tracker);
      console.log("[KAIRA] Slack interactions enabled → POST /slack/interactions");
    } else {
      console.warn("[KAIRA] SLACK_SIGNING_SECRET not set — Claim Order button will not work.");
    }
  }

  const processor = new EmailProcessor(graphService, claudeService, notifier);

  // ─── HTTP server ──────────────────────────────────────────────────────────

  const app = createApp(processor, tracker, interactions);
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
      const results = await processor.runCycle();
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
