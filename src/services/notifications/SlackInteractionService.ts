import crypto from "crypto";
import { WebClient } from "@slack/web-api";
import { SlackNotificationService, CLAIM_ACTION_ID } from "./SlackNotificationService.js";
import { POTracker } from "../po/POTracker.js";

/**
 * Handles interactive payloads from Slack (button clicks).
 *
 * Responsibilities:
 *  1. Verify the request signature to confirm it came from Slack.
 *  2. Dispatch block_actions to the right handler.
 *  3. For "claim_po": claim the order, update the channel message, and DM the agent.
 */
export class SlackInteractionService {
  private web: WebClient;

  constructor(
    private readonly signingSecret: string,
    private readonly notifier: SlackNotificationService,
    private readonly tracker: POTracker
  ) {
    this.web = notifier.getWebClient();
  }

  // ─── Signature verification ───────────────────────────────────────────────

  verifySignature(rawBody: string, timestamp: string, signature: string): boolean {
    // Reject requests older than 5 minutes to prevent replay attacks
    const age = Math.abs(Date.now() / 1000 - parseInt(timestamp, 10));
    if (age > 300) return false;

    const base = `v0:${timestamp}:${rawBody}`;
    const expected = "v0=" + crypto.createHmac("sha256", this.signingSecret).update(base).digest("hex");
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  }

  // ─── Payload dispatch ─────────────────────────────────────────────────────

  async handleInteraction(rawBody: string): Promise<void> {
    const params = new URLSearchParams(rawBody);
    const payloadJson = params.get("payload");
    if (!payloadJson) {
      console.warn("[SlackInteractionService] No payload in interaction body.");
      return;
    }

    let payload: SlackBlockActionsPayload;
    try {
      payload = JSON.parse(payloadJson) as SlackBlockActionsPayload;
    } catch {
      console.error("[SlackInteractionService] Failed to parse interaction payload.");
      return;
    }

    if (payload.type !== "block_actions") return;

    for (const action of payload.actions) {
      if (action.action_id === CLAIM_ACTION_ID) {
        await this.handleClaimPO(action.value, payload);
      }
    }
  }

  // ─── Claim handler ────────────────────────────────────────────────────────

  private async handleClaimPO(trackingId: string, payload: SlackBlockActionsPayload): Promise<void> {
    const slackUserId = payload.user.id;
    const slackUserName = payload.user.name;
    const messageTs = payload.message.ts;
    const channelId = payload.channel.id;

    // Mark as claimed
    const tracked = this.tracker.claim(trackingId, slackUserId, slackUserName);
    if (!tracked) {
      // Already claimed — update the message to reflect current state and return
      const existing = this.tracker.get(trackingId);
      if (existing) await this.updateChannelMessage(existing, channelId, messageTs);
      return;
    }

    // Update the original channel message to replace the button with a claimed banner
    await this.updateChannelMessage(tracked, channelId, messageTs);

    // Open a DM and send full PO details + PDF
    await this.sendClaimDM(tracked, slackUserId);
  }

  private async updateChannelMessage(tracked: ReturnType<POTracker["get"]>, channelId: string, messageTs: string): Promise<void> {
    if (!tracked) return;
    try {
      await this.web.chat.update({
        channel: channelId,
        ts: messageTs,
        blocks: this.notifier.buildClaimedPOBlocks(tracked) as any,
        text: `PO claimed by ${tracked.claimedByName ?? tracked.claimedBy}`,
      });
    } catch (err) {
      console.error("[SlackInteractionService] Failed to update channel message:", err);
    }
  }

  private async sendClaimDM(tracked: NonNullable<ReturnType<POTracker["get"]>>, slackUserId: string): Promise<void> {
    // Open a DM channel with the claiming user
    let dmChannelId: string;
    try {
      const result = await this.web.conversations.open({ users: slackUserId });
      dmChannelId = result.channel?.id as string;
      if (!dmChannelId) throw new Error("No DM channel ID returned");
    } catch (err) {
      console.error("[SlackInteractionService] Failed to open DM:", err);
      return;
    }

    // Post PO detail blocks
    try {
      await this.web.chat.postMessage({
        channel: dmChannelId,
        blocks: this.notifier.buildPoDmBlocks(tracked) as any,
        text: `You claimed PO #${tracked.purchaseOrder.poNumber ?? "unknown"}`,
      });
    } catch (err) {
      console.error("[SlackInteractionService] Failed to send DM:", err);
      return;
    }

    // Upload the original PDF if we have it
    if (tracked.pdfBase64) {
      try {
        await this.web.filesUploadV2({
          channel_id: dmChannelId,
          file: Buffer.from(tracked.pdfBase64, "base64"),
          filename: tracked.pdfName,
          initial_comment: "Here is the original PDF attachment:",
        });
      } catch (err) {
        console.error("[SlackInteractionService] Failed to upload PDF:", err);
      }
    }

    console.log(`[SlackInteractionService] DM sent to ${slackUserId} for PO ${tracked.id}`);
  }
}

// ─── Slack payload types ──────────────────────────────────────────────────────

interface SlackBlockActionsPayload {
  type: "block_actions";
  user: { id: string; name: string };
  message: { ts: string };
  channel: { id: string };
  actions: Array<{ action_id: string; value: string }>;
}
