import crypto from "crypto";
import { TrackedPO, PurchaseOrderData, EmailMessage } from "../../types/index.js";

/**
 * In-memory store for purchase orders, tracking claim status.
 * A single instance is shared across the app (wired in index.ts).
 */
export class POTracker {
  private orders = new Map<string, TrackedPO>();

  /** Register a new incoming PO. Returns the tracking record with a fresh UUID. */
  track(data: {
    emailId: string;
    purchaseOrder: PurchaseOrderData;
    email: EmailMessage;
    pdfBase64: string;
    pdfName: string;
  }): TrackedPO {
    const id = crypto.randomUUID();
    const po: TrackedPO = {
      ...data,
      id,
      status: "unclaimed",
      receivedAt: new Date().toISOString(),
    };
    this.orders.set(id, po);
    console.log(`[POTracker] Tracking PO ${id} (PO#: ${data.purchaseOrder.poNumber ?? "unknown"})`);
    return po;
  }

  /** Store the Slack message ts + channel after posting, so we can update it later. */
  setSlackMessage(id: string, messageTs: string, channelId: string): void {
    const po = this.orders.get(id);
    if (po) {
      po.slackMessageTs = messageTs;
      po.slackChannelId = channelId;
    }
  }

  get(id: string): TrackedPO | undefined {
    return this.orders.get(id);
  }

  /**
   * Mark a PO as claimed. Returns null if the PO is already claimed or not found.
   */
  claim(id: string, slackUserId: string, slackUserName: string): TrackedPO | null {
    const po = this.orders.get(id);
    if (!po) {
      console.warn(`[POTracker] Claim attempt for unknown PO id: ${id}`);
      return null;
    }
    if (po.status === "claimed") {
      console.warn(`[POTracker] PO ${id} already claimed by ${po.claimedByName}`);
      return null;
    }
    po.status = "claimed";
    po.claimedBy = slackUserId;
    po.claimedByName = slackUserName;
    po.claimedAt = new Date().toISOString();
    console.log(`[POTracker] PO ${id} claimed by ${slackUserName} (${slackUserId})`);
    return po;
  }

  getAll(): TrackedPO[] {
    return Array.from(this.orders.values()).sort(
      (a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime()
    );
  }

  getUnclaimed(): TrackedPO[] {
    return this.getAll().filter((po) => po.status === "unclaimed");
  }

  getClaimed(): TrackedPO[] {
    return this.getAll().filter((po) => po.status === "claimed");
  }

  summary(): { total: number; unclaimed: number; claimed: number } {
    const all = this.getAll();
    const unclaimed = all.filter((p) => p.status === "unclaimed").length;
    return { total: all.length, unclaimed, claimed: all.length - unclaimed };
  }
}
