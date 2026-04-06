import crypto from "crypto";
import { PrismaClient, OrderStatus } from "@prisma/client";
import { getPrismaClient } from "../../lib/prisma.js";
import { TrackedPO, POStatus, PurchaseOrderData, EmailMessage } from "../../types/index.js";

type TrackedOrderRow = Awaited<ReturnType<PrismaClient["trackedOrder"]["findUniqueOrThrow"]>>;

/**
 * POTracker — database-backed purchase order store.
 *
 * Each instance is scoped to a single KAIRA tenant via the kairaTenantId
 * passed to the constructor. All queries are automatically filtered to that
 * tenant, providing full data isolation between customers.
 *
 * All methods are async — they execute DB queries rather than reading from
 * an in-memory Map.
 */
export class POTracker {
  private readonly db: PrismaClient;

  constructor(private readonly kairaTenantId: string) {
    this.db = getPrismaClient();
  }

  // ─── Write operations ─────────────────────────────────────────────────────

  /** Register a new incoming PO. Returns the persisted tracking record. */
  async track(data: {
    emailId: string;
    purchaseOrder: PurchaseOrderData;
    email: EmailMessage;
    pdfBase64: string;
    pdfName: string;
  }): Promise<TrackedPO> {
    const id = crypto.randomUUID();
    const row = await this.db.trackedOrder.create({
      data: {
        id,
        tenantId:          this.kairaTenantId,
        emailId:           data.emailId,
        purchaseOrderJson: JSON.stringify(data.purchaseOrder),
        emailJson:         JSON.stringify(data.email),
        pdfBase64:         data.pdfBase64,
        pdfName:           data.pdfName,
        receivedAt:        new Date().toISOString(),
        status:            OrderStatus.UNCLAIMED,
      },
    });

    console.log(`[POTracker] Tracking PO ${id} (PO#: ${data.purchaseOrder.poNumber ?? "unknown"})`);
    return rowToTrackedPO(row);
  }

  /** Store the Slack message ts + channel after posting, enabling later updates. */
  async setSlackMessage(id: string, messageTs: string, channelId: string): Promise<void> {
    await this.db.trackedOrder.updateMany({
      where: { id, tenantId: this.kairaTenantId },
      data:  { slackMessageTs: messageTs, slackChannelId: channelId },
    });
  }

  /**
   * Mark a PO as claimed by a Slack user.
   * Returns null if the PO is not found, belongs to another tenant, or is
   * already claimed.
   */
  async claim(
    id: string,
    slackUserId: string,
    slackUserName: string,
  ): Promise<TrackedPO | null> {
    const existing = await this.db.trackedOrder.findUnique({ where: { id } });

    if (!existing || existing.tenantId !== this.kairaTenantId) {
      console.warn(`[POTracker] Claim attempt for unknown or cross-tenant PO id: ${id}`);
      return null;
    }
    if (existing.status === OrderStatus.CLAIMED) {
      console.warn(`[POTracker] PO ${id} already claimed by ${existing.claimedByName}`);
      return null;
    }

    const updated = await this.db.trackedOrder.update({
      where: { id },
      data: {
        status:        OrderStatus.CLAIMED,
        claimedBy:     slackUserId,
        claimedByName: slackUserName,
        claimedAt:     new Date(),
      },
    });

    console.log(`[POTracker] PO ${id} claimed by ${slackUserName} (${slackUserId})`);
    return rowToTrackedPO(updated);
  }

  // ─── Read operations ──────────────────────────────────────────────────────

  async get(id: string): Promise<TrackedPO | undefined> {
    const row = await this.db.trackedOrder.findUnique({ where: { id } });
    if (!row || row.tenantId !== this.kairaTenantId) return undefined;
    return rowToTrackedPO(row);
  }

  async getAll(): Promise<TrackedPO[]> {
    const rows = await this.db.trackedOrder.findMany({
      where:   { tenantId: this.kairaTenantId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(rowToTrackedPO);
  }

  async getUnclaimed(): Promise<TrackedPO[]> {
    const rows = await this.db.trackedOrder.findMany({
      where:   { tenantId: this.kairaTenantId, status: OrderStatus.UNCLAIMED },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(rowToTrackedPO);
  }

  async getClaimed(): Promise<TrackedPO[]> {
    const rows = await this.db.trackedOrder.findMany({
      where:   { tenantId: this.kairaTenantId, status: OrderStatus.CLAIMED },
      orderBy: { claimedAt: "desc" },
    });
    return rows.map(rowToTrackedPO);
  }

  async summary(): Promise<{ total: number; unclaimed: number; claimed: number }> {
    const [total, unclaimed] = await Promise.all([
      this.db.trackedOrder.count({ where: { tenantId: this.kairaTenantId } }),
      this.db.trackedOrder.count({
        where: { tenantId: this.kairaTenantId, status: OrderStatus.UNCLAIMED },
      }),
    ]);
    return { total, unclaimed, claimed: total - unclaimed };
  }
}

// ─── Row mapper ───────────────────────────────────────────────────────────────

function rowToTrackedPO(row: TrackedOrderRow): TrackedPO {
  return {
    id:            row.id,
    tenantId:      row.tenantId,
    emailId:       row.emailId,
    purchaseOrder: JSON.parse(row.purchaseOrderJson) as PurchaseOrderData,
    email:         JSON.parse(row.emailJson) as EmailMessage,
    pdfBase64:     row.pdfBase64,
    pdfName:       row.pdfName,
    status:        row.status === OrderStatus.CLAIMED ? "claimed" : "unclaimed",
    claimedBy:     row.claimedBy     ?? undefined,
    claimedByName: row.claimedByName ?? undefined,
    claimedAt:     row.claimedAt?.toISOString() ?? undefined,
    slackMessageTs: row.slackMessageTs  ?? undefined,
    slackChannelId: row.slackChannelId  ?? undefined,
    receivedAt:    row.receivedAt,
  };
}
