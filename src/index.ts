import "dotenv/config";
import { config } from "./config/index.js";
import { TenantScheduler } from "./services/tenant/TenantScheduler.js";
import { disconnectPrisma } from "./lib/prisma.js";
import { createApp } from "./app.js";

async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║   K.A.I.R.A — Inbox Response Automation          ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log();

  // ─── Scheduler ────────────────────────────────────────────────────────────
  // Loads all active tenants from the database, creates a TenantRuntime for
  // each, and starts an independent polling loop per tenant.

  const scheduler = new TenantScheduler(config.claude.apiKey, config.claude.model);
  await scheduler.start();

  // ─── HTTP server ──────────────────────────────────────────────────────────

  const app    = createApp(scheduler);
  const server = app.listen(config.server.port, config.server.host, () => {
    console.log(`[KAIRA] HTTP server listening on http://${config.server.host}:${config.server.port}`);
    console.log(`[KAIRA] Endpoints:`);
    console.log(`         GET  /health                        — health check`);
    console.log(`         GET  /status                        — per-tenant run summary + PO status`);
    console.log(`         GET  /status/:tenantId              — single-tenant detail`);
    console.log(`         POST /process/now                   — trigger a cycle (all or ?tenantId=)`);
    console.log(`         POST /slack/interactions            — Slack button handler`);
    console.log(`         GET  /tenants                       — list all tenants`);
    console.log(`         POST /tenants                       — create tenant`);
    console.log(`         GET  /tenants/:id                   — get tenant`);
    console.log(`         PATCH /tenants/:id                  — update tenant`);
    console.log(`         DELETE /tenants/:id                 — delete tenant`);
    console.log(`         POST /tenants/:id/activate          — activate tenant`);
    console.log(`         POST /tenants/:id/deactivate        — deactivate tenant`);
    console.log();
  });

  // ─── Graceful shutdown ────────────────────────────────────────────────────

  const shutdown = async () => {
    console.log("\n[KAIRA] Shutting down...");
    scheduler.stopAll();
    await disconnectPrisma();
    server.close(() => process.exit(0));
  };

  process.on("SIGTERM", () => { void shutdown(); });
  process.on("SIGINT",  () => { void shutdown(); });
}

main().catch((err) => {
  console.error("[KAIRA] Fatal startup error:", err);
  process.exit(1);
});
