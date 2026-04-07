/**
 * End-to-end smoke test for the multi-tenant KAIRA pipeline.
 *
 * What it does:
 *   1. Reads credentials from .env
 *   2. Creates a "KAIRA Test Account" tenant in the database (skips if it
 *      already exists so it's safe to re-run)
 *   3. Builds a TenantRuntime and runs one full processing cycle
 *   4. Prints the results
 *   5. Disconnects cleanly — does NOT delete the tenant so you can inspect
 *      the database afterwards or continue testing via the HTTP API
 *
 * Usage:
 *   npm run test:e2e
 *   -- or --
 *   npx tsx scripts/test-e2e.ts
 */

import "dotenv/config";
import { TenantRegistry } from "../src/services/tenant/TenantRegistry.js";
import { TenantRuntime } from "../src/services/tenant/TenantRuntime.js";
import { disconnectPrisma } from "../src/lib/prisma.js";
import { CreateTenantInput } from "../src/types/tenant.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function require_env(key: string): string {
  const v = process.env[key];
  if (!v) {
    console.error(`[test-e2e] Missing required env var: ${key}`);
    process.exit(1);
  }
  return v;
}

function section(title: string) {
  const bar = "─".repeat(52);
  console.log(`\n┌${bar}┐`);
  console.log(`│  ${title.padEnd(50)} │`);
  console.log(`└${bar}┘`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║   K.A.I.R.A — End-to-End Smoke Test              ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  // ── 1. Validate environment ──────────────────────────────────────────────
  section("Step 1 — Validate environment");

  const clientId     = require_env("AZURE_CLIENT_ID");
  const clientSecret = require_env("AZURE_CLIENT_SECRET");
  const userEmail    = require_env("GRAPH_USER_EMAIL");
  const anthropicKey = require_env("ANTHROPIC_API_KEY");
  const claudeModel  = process.env["CLAUDE_MODEL"] ?? "claude-opus-4-6";

  // Azure uses "consumers" for personal Microsoft accounts; for work/school
  // accounts set AZURE_TENANT_ID to the directory (tenant) UUID.
  const azureTenantId = process.env["AZURE_TENANT_ID"] ?? "consumers";
  const inboxFolder   = process.env["GRAPH_INBOX_FOLDER"] ?? "inbox";
  const pollInterval  = parseInt(process.env["POLL_INTERVAL_SECONDS"] ?? "60", 10);
  const authMode      = (process.env["GRAPH_AUTH_MODE"] === "device_code" ? "device_code" : "app_only") as "app_only" | "device_code";

  console.log(`  Azure client ID : ${clientId}`);
  console.log(`  Azure tenant ID : ${azureTenantId}`);
  console.log(`  Auth mode       : ${authMode}`);
  console.log(`  Mailbox         : ${userEmail}`);
  console.log(`  Inbox folder    : ${inboxFolder}`);
  console.log(`  Poll interval   : ${pollInterval}s`);
  console.log(`  Claude model    : ${claudeModel}`);
  console.log(`  Notification    : ${process.env["NOTIFICATION_PROVIDER"] ?? "slack"}`);
  console.log("  ✓ All required vars present");

  // ── 2. Create or reuse tenant ────────────────────────────────────────────
  section("Step 2 — Create tenant in database");

  const registry = new TenantRegistry();
  const all      = await registry.findAll();
  const existing = all.find((t) => t.name === "KAIRA Test Account");

  let tenantConfig = existing ?? null;

  if (existing) {
    console.log(`  Tenant already exists — reusing "${existing.name}" (${existing.id})`);
    tenantConfig = existing;
  } else {
    const input: CreateTenantInput = {
      name: "KAIRA Test Account",
      isActive: true,
      graph: {
        clientId,
        clientSecret,
        tenantId: azureTenantId,
        authMode,
        userEmail,
        inboxFolder,
        pollIntervalSeconds: pollInterval,
      },
      notification: {
        provider: (process.env["NOTIFICATION_PROVIDER"] as "slack" | "teams") ?? "slack",
      },
      slack: {
        botToken:      process.env["SLACK_BOT_TOKEN"]      ?? null,
        signingSecret: process.env["SLACK_SIGNING_SECRET"] ?? null,
        webhookRfq:    process.env["SLACK_WEBHOOK_RFQ"]    ?? null,
        webhookInquiry: process.env["SLACK_WEBHOOK_INQUIRY"] ?? null,
        poChannelId:   process.env["SLACK_PO_CHANNEL"]     ?? null,
        botName:       process.env["SLACK_BOT_NAME"]       ?? "KAIRA",
      },
      teams: {
        webhookUrl: process.env["TEAMS_WEBHOOK_URL"] ?? null,
      },
    };

    tenantConfig = await registry.create(input);
    console.log(`  ✓ Created tenant "${tenantConfig.name}" (${tenantConfig.id})`);
  }

  // ── 3. Build runtime ─────────────────────────────────────────────────────
  section("Step 3 — Build TenantRuntime");

  let runtime: TenantRuntime;
  try {
    runtime = new TenantRuntime(tenantConfig, anthropicKey, claudeModel);
    console.log("  ✓ Runtime initialised");
    console.log(`  Interactions    : ${runtime.interactions ? "enabled" : "disabled (no signing secret)"}`);
  } catch (err) {
    console.error("  ✗ Failed to build runtime:", err);
    await disconnectPrisma();
    process.exit(1);
  }

  // ── 4. Run one processing cycle ──────────────────────────────────────────
  section("Step 4 — Run processing cycle");
  console.log("  This authenticates to Microsoft Graph, fetches new emails,");
  console.log("  classifies them with Claude, and sends Slack notifications.\n");

  const start = Date.now();
  let results;
  try {
    results = await runtime.processor.runCycle();
  } catch (err) {
    console.error("  ✗ Cycle threw an unhandled error:", err);
    await disconnectPrisma();
    process.exit(1);
  }
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  // ── 5. Print results ─────────────────────────────────────────────────────
  section("Step 5 — Results");

  if (results.length === 0) {
    console.log(`  No new emails processed (cycle took ${elapsed}s).`);
    console.log("  The inbox is either empty or every message was already tracked.");
  } else {
    console.log(`  Processed ${results.length} email(s) in ${elapsed}s:\n`);
    for (const r of results) {
      const status = r.error ? "✗" : "✓";
      const detail = r.error ?? r.details ?? "ok";
      console.log(`  ${status}  [${r.action.padEnd(12)}]  ${detail}`);
    }
  }

  // ── 6. PO summary ────────────────────────────────────────────────────────
  section("Step 6 — PO tracker summary");

  const [summary, unclaimed] = await Promise.all([
    runtime.tracker.summary(),
    runtime.tracker.getUnclaimed(),
  ]);

  console.log(`  Total tracked : ${summary.total}`);
  console.log(`  Unclaimed     : ${summary.unclaimed}`);
  console.log(`  Claimed       : ${summary.claimed}`);

  if (unclaimed.length > 0) {
    console.log("\n  Unclaimed orders:");
    for (const po of unclaimed) {
      console.log(
        `    • ${po.purchaseOrder.poNumber.padEnd(20)} ` +
        `from ${po.email.sender}  (received ${po.receivedAt})`,
      );
    }
  }

  // ── Done ─────────────────────────────────────────────────────────────────
  section("Done");
  console.log(`  Tenant ID : ${tenantConfig.id}`);
  console.log("  The tenant remains in the database.");
  console.log("  Start the server with `npm run dev` to use the full HTTP API.\n");

  await disconnectPrisma();
}

main().catch((err) => {
  console.error("\n[test-e2e] Fatal error:", err);
  process.exit(1);
});
