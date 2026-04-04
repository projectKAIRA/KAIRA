import express, { Request, Response } from "express";
import { EmailProcessor } from "./services/email/EmailProcessor.js";
import { SlackInteractionService } from "./services/notifications/SlackInteractionService.js";
import { POTracker } from "./services/po/POTracker.js";
import { ProcessingResult } from "./types/index.js";

export function createApp(
  processor: EmailProcessor,
  tracker: POTracker,
  interactions: SlackInteractionService | null
): express.Application {
  const app = express();
  app.use(express.json());

  let lastRunAt: string | null = null;
  let lastResults: ProcessingResult[] = [];
  let isRunning = false;

  // ─── Health ───────────────────────────────────────────────────────────────

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", service: "KAIRA", timestamp: new Date().toISOString() });
  });

  // ─── Status (includes PO claim summary) ──────────────────────────────────

  app.get("/status", (_req: Request, res: Response) => {
    const poSummary = tracker.summary();
    res.json({
      service: "KAIRA",
      isRunning,
      lastRunAt,
      lastResultCount: lastResults.length,
      lastResults: lastResults.slice(0, 20),
      purchaseOrders: {
        ...poSummary,
        unclaimed: tracker.getUnclaimed().map((po) => ({
          id: po.id,
          poNumber: po.purchaseOrder.poNumber,
          from: po.email.sender,
          receivedAt: po.receivedAt,
          total: po.purchaseOrder.total,
          currency: po.purchaseOrder.currency,
        })),
        recentlyClaimed: tracker.getClaimed().slice(0, 5).map((po) => ({
          id: po.id,
          poNumber: po.purchaseOrder.poNumber,
          claimedBy: po.claimedByName,
          claimedAt: po.claimedAt,
        })),
      },
    });
  });

  // ─── Manual trigger ───────────────────────────────────────────────────────

  app.post("/process/now", async (_req: Request, res: Response) => {
    if (isRunning) {
      res.status(409).json({ error: "A processing cycle is already running." });
      return;
    }
    isRunning = true;
    res.json({ message: "Processing cycle started. Check /status for results." });

    processor
      .runCycle()
      .then((results) => {
        lastRunAt = new Date().toISOString();
        lastResults = results;
      })
      .catch((err) => console.error("[App] Manual cycle error:", err))
      .finally(() => { isRunning = false; });
  });

  // ─── Slack Interactions ───────────────────────────────────────────────────
  // Uses express.raw() so we can verify the Slack request signature on the raw
  // bytes before the body is parsed.

  app.post(
    "/slack/interactions",
    express.raw({ type: "*/*" }),
    async (req: Request, res: Response) => {
      // Always respond 200 immediately — Slack requires a response within 3s
      res.sendStatus(200);

      if (!interactions) {
        console.warn("[App] Received Slack interaction but SlackInteractionService is not configured.");
        return;
      }

      const rawBody = (req.body as Buffer).toString("utf8");
      const timestamp = (req.headers["x-slack-request-timestamp"] as string) ?? "";
      const signature = (req.headers["x-slack-signature"] as string) ?? "";

      if (!interactions.verifySignature(rawBody, timestamp, signature)) {
        console.warn("[App] Slack interaction failed signature verification — ignoring.");
        return;
      }

      await interactions.handleInteraction(rawBody);
    }
  );

  return app;
}
