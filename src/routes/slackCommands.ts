/**
 * Slack Slash Commands handler.
 *
 * Mounted at POST /slack/commands in app.ts.
 *
 * Supported commands:
 *   /orders — ephemeral list of all unclaimed POs for this workspace
 *
 * Setup required in Slack app settings:
 *   Slash Commands → Create New Command
 *     Command:       /orders
 *     Request URL:   https://trykaira.ai/slack/commands
 *     Short Desc:    Show unclaimed purchase orders
 *     Usage Hint:    (none)
 */

import crypto from "crypto";
import express, { Router, Request, Response } from "express";
import { TenantRegistry } from "../services/tenant/TenantRegistry.js";
import { TenantScheduler } from "../services/tenant/TenantScheduler.js";
import { SlackNotificationService } from "../services/notifications/SlackNotificationService.js";
import { config } from "../config/index.js";

const registry = new TenantRegistry();

export function createSlackCommandsRouter(scheduler: TenantScheduler): Router {
  const router = Router();

  // Raw body needed for signature verification — mounted in app.ts with express.raw()
  router.post(
    "/",
    express.raw({ type: "*/*" }),
    async (req: Request, res: Response) => {
      const rawBody  = (req.body as Buffer).toString("utf8");
      const timestamp = (req.headers["x-slack-request-timestamp"] as string) ?? "";
      const signature = (req.headers["x-slack-signature"]          as string) ?? "";

      // ── Signature verification ────────────────────────────────────────────
      // Slash commands use the same HMAC-SHA256 scheme as interactions.
      const signingSecret = config.oauth.slack.signingSecret;
      if (!signingSecret || !verifySlackSignature(rawBody, timestamp, signature, signingSecret)) {
        console.warn("[SlackCommands] Signature verification failed — ignoring.");
        res.status(403).send("Forbidden");
        return;
      }

      // ── Parse command payload (application/x-www-form-urlencoded) ─────────
      const params   = new URLSearchParams(rawBody);
      const command  = params.get("command") ?? "";
      const teamId   = params.get("team_id") ?? "";
      const userId   = params.get("user_id") ?? "";
      const userName = params.get("user_name") ?? "";

      if (command !== "/orders") {
        res.json({ response_type: "ephemeral", text: `Unknown command: ${command}` });
        return;
      }

      // ── Tenant lookup by Slack workspace ID ──────────────────────────────
      const tenant = await registry.findBySlackTeamId(teamId);
      if (!tenant) {
        res.json({
          response_type: "ephemeral",
          text: "⚠️ KAIRA could not find an account linked to this Slack workspace. Contact your administrator.",
        });
        return;
      }

      const runtime = scheduler.getRuntime(tenant.id);
      if (!runtime || !(runtime.notifier instanceof SlackNotificationService)) {
        res.json({
          response_type: "ephemeral",
          text: "⚠️ KAIRA is not fully configured for this workspace.",
        });
        return;
      }

      // ── Fetch unclaimed orders and respond ───────────────────────────────
      const unclaimed = await runtime.tracker.getUnclaimed();
      const blocks    = runtime.notifier.buildOrdersEphemeral(unclaimed);

      console.log(
        `[SlackCommands] /orders for "${tenant.name}" by ${userName} (${userId}) — ` +
        `${unclaimed.length} unclaimed.`,
      );

      res.json({
        response_type: "ephemeral",
        blocks,
        text: `${unclaimed.length} unclaimed order(s)`,
      });
    },
  );

  return router;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function verifySlackSignature(
  rawBody: string,
  timestamp: string,
  signature: string,
  signingSecret: string,
): boolean {
  const age = Math.abs(Date.now() / 1000 - parseInt(timestamp, 10));
  if (age > 300) return false;

  const base     = `v0:${timestamp}:${rawBody}`;
  const expected = "v0=" + crypto.createHmac("sha256", signingSecret).update(base).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}
