/**
 * TrialGuard
 *
 * Enforces Starter-tier document quotas for trial tenants.
 *
 * Quota rules:
 *   - 100 documents per calendar month.
 *   - Trial period: set by trialEndDate on the tenant record.
 *
 * When a tenant hits the limit:
 *   1. trialLimitReached is set to true in the database.
 *   2. A notification is sent to the tenant's connected Slack workspace or
 *      Teams channel explaining the limit and linking to the upgrade page.
 *   3. The scheduler skips future cycles for this tenant.
 *
 * When a trial expires:
 *   1. isTrialActive is set to false and the tenant is deactivated.
 *   2. An expiry notification is sent.
 *   3. The scheduler removes the tenant's polling loop.
 *
 * This service issues database writes directly via Prisma and posts
 * notifications via the Slack Web API or Teams webhook — bypassing the
 * per-tenant NotificationService so no changes to that interface are needed.
 */

import { WebClient } from "@slack/web-api";
import { getPrismaClient } from "../../lib/prisma.js";
import { TenantConfig, TRIAL_DOC_LIMIT } from "../../types/tenant.js";

const UPGRADE_URL = "https://trykaira.ai";

// ─── Public check result ──────────────────────────────────────────────────────

export type TrialBlockReason = "expired" | "limit_reached";

export interface TrialCheckResult {
  blocked: false;
}

export interface TrialBlockedResult {
  blocked: true;
  reason: TrialBlockReason;
}

export type TrialStatus = TrialCheckResult | TrialBlockedResult;

// ─── TrialGuard ───────────────────────────────────────────────────────────────

export class TrialGuard {
  /**
   * Check whether a trial tenant should be blocked from processing.
   * Reads fresh state from the database every call — do not rely on cached config.
   *
   * Returns `{ blocked: false }` for non-trial tenants.
   */
  static async check(tenantId: string): Promise<TrialStatus> {
    const db  = getPrismaClient();
    const row = await db.tenant.findUnique({
      where:  { id: tenantId },
      select: {
        planTier:          true,
        isTrialActive:     true,
        trialEndDate:      true,
        trialLimitReached: true,
      },
    });

    if (!row || row.planTier !== "trial" || !row.isTrialActive) {
      return { blocked: false };
    }

    if (row.trialEndDate && row.trialEndDate < new Date()) {
      return { blocked: true, reason: "expired" };
    }

    if (row.trialLimitReached) {
      return { blocked: true, reason: "limit_reached" };
    }

    return { blocked: false };
  }

  /**
   * If the stored monthlyDocResetAt is from a previous calendar month (or null),
   * reset monthlyDocCount to 0 and update monthlyDocResetAt to now.
   *
   * Call once per cycle before checking the count.
   * Returns the current count (after reset if applicable).
   */
  static async maybeResetMonthlyCount(tenantId: string): Promise<number> {
    const db  = getPrismaClient();
    const row = await db.tenant.findUnique({
      where:  { id: tenantId },
      select: { monthlyDocCount: true, monthlyDocResetAt: true },
    });

    if (!row) return 0;

    const now          = new Date();
    const resetAt      = row.monthlyDocResetAt;
    const isNewMonth   =
      !resetAt ||
      resetAt.getFullYear() !== now.getFullYear() ||
      resetAt.getMonth()    !== now.getMonth();

    if (isNewMonth) {
      await db.tenant.update({
        where: { id: tenantId },
        data: {
          monthlyDocCount:   0,
          monthlyDocResetAt: now,
          // Clear the limit flag on reset so the tenant can process again
          trialLimitReached: false,
        },
      });
      console.log(
        `[TrialGuard] Monthly document count reset for tenant ${tenantId}.`,
      );
      return 0;
    }

    return row.monthlyDocCount;
  }

  /**
   * Increment the monthly document count by `count` and return the new total.
   * Also returns whether the new total has hit or exceeded TRIAL_DOC_LIMIT.
   */
  static async incrementDocCount(
    tenantId: string,
    count: number,
  ): Promise<{ newCount: number; limitReached: boolean }> {
    const db  = getPrismaClient();
    const row = await db.tenant.update({
      where: { id: tenantId },
      data:  { monthlyDocCount: { increment: count } },
      select: { monthlyDocCount: true },
    });

    const limitReached = row.monthlyDocCount >= TRIAL_DOC_LIMIT;
    return { newCount: row.monthlyDocCount, limitReached };
  }

  /**
   * Mark the tenant's trial limit as reached in the database and send an
   * upgrade notification to their connected workspace.
   */
  static async handleLimitReached(tenantConfig: TenantConfig): Promise<void> {
    const db = getPrismaClient();

    await db.tenant.update({
      where: { id: tenantConfig.id },
      data:  { trialLimitReached: true },
    });

    console.log(
      `[TrialGuard] Trial limit reached for "${tenantConfig.name}" ` +
      `(${tenantConfig.id}) — processing paused.`,
    );

    await TrialGuard.sendNotification(tenantConfig, "limit_reached");
  }

  /**
   * Mark the tenant's trial as expired in the database, deactivate the tenant,
   * and send an expiry notification.
   */
  static async handleExpiry(tenantConfig: TenantConfig): Promise<void> {
    const db = getPrismaClient();

    await db.tenant.update({
      where: { id: tenantConfig.id },
      data:  { isTrialActive: false, isActive: false },
    });

    console.log(
      `[TrialGuard] Trial expired for "${tenantConfig.name}" ` +
      `(${tenantConfig.id}) — tenant deactivated.`,
    );

    await TrialGuard.sendNotification(tenantConfig, "expired");
  }

  // ─── Private notification dispatch ─────────────────────────────────────────

  private static async sendNotification(
    config: TenantConfig,
    reason: TrialBlockReason,
  ): Promise<void> {
    try {
      if (config.notification.provider === "slack" && config.slack.botToken) {
        await TrialGuard.sendSlackNotification(config, reason);
      } else if (config.notification.provider === "teams" && config.teams.webhookUrl) {
        await TrialGuard.sendTeamsNotification(config, reason);
      } else {
        console.warn(
          `[TrialGuard] No notification channel configured for "${config.name}" — ` +
          `could not send ${reason} notice.`,
        );
      }
    } catch (err) {
      // Notification failure must never crash the scheduler.
      console.error(
        `[TrialGuard] Failed to send ${reason} notification for "${config.name}":`,
        err,
      );
    }
  }

  // ─── Slack ─────────────────────────────────────────────────────────────────

  private static async sendSlackNotification(
    config: TenantConfig,
    reason: TrialBlockReason,
  ): Promise<void> {
    const web     = new WebClient(config.slack.botToken!);
    const channel = config.slack.poChannelId ?? "";

    if (!channel) {
      console.warn(
        `[TrialGuard] Slack poChannelId not set for "${config.name}" — cannot send trial notice.`,
      );
      return;
    }

    const blocks =
      reason === "limit_reached"
        ? TrialGuard.buildSlackLimitBlocks(config.name)
        : TrialGuard.buildSlackExpiredBlocks(config.name, config.trialEndDate);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await web.chat.postMessage({ channel, blocks: blocks as any, text: "KAIRA trial notice" });
    console.log(`[TrialGuard] Sent Slack ${reason} notice to channel ${channel} for "${config.name}".`);
  }

  private static buildSlackLimitBlocks(companyName: string): object[] {
    return [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `⚠️ *${companyName} has reached the 100-document trial limit*\n\n` +
            `You've reached your 100 document trial limit. Upgrade to a paid plan at ` +
            `<${UPGRADE_URL}|trykaira.ai> to keep KAIRA running — your team won't miss another order.`,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Upgrade now →", emoji: true },
            style: "primary",
            url: UPGRADE_URL,
            action_id: "trial_upgrade",
          },
        ],
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `KAIRA has paused monitoring until you upgrade. Documents received in the meantime will not be processed.`,
          },
        ],
      },
    ];
  }

  private static buildSlackExpiredBlocks(companyName: string, trialEndDate: Date | null): object[] {
    const endStr = trialEndDate
      ? trialEndDate.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
      : "recently";

    return [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `⏰ *${companyName}'s KAIRA trial has ended*\n\n` +
            `Your 14-day trial expired on ${endStr}. Upgrade to a paid plan at ` +
            `<${UPGRADE_URL}|trykaira.ai> to resume monitoring — don't let purchase orders go unnoticed.`,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Upgrade now →", emoji: true },
            style: "primary",
            url: UPGRADE_URL,
            action_id: "trial_upgrade",
          },
        ],
      },
    ];
  }

  // ─── Teams ─────────────────────────────────────────────────────────────────

  private static async sendTeamsNotification(
    config: TenantConfig,
    reason: TrialBlockReason,
  ): Promise<void> {
    const card =
      reason === "limit_reached"
        ? TrialGuard.buildTeamsLimitCard(config.name)
        : TrialGuard.buildTeamsExpiredCard(config.name, config.trialEndDate);

    const res = await fetch(config.teams.webhookUrl!, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ type: "message", attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content: card }] }),
    });

    if (!res.ok) {
      throw new Error(`Teams webhook returned ${res.status}`);
    }

    console.log(`[TrialGuard] Sent Teams ${reason} notice for "${config.name}".`);
  }

  private static buildTeamsLimitCard(companyName: string): object {
    return {
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      type:    "AdaptiveCard",
      version: "1.5",
      body: [
        {
          type:   "TextBlock",
          text:   `⚠️ ${companyName} — Trial limit reached`,
          weight: "Bolder",
          size:   "Medium",
          wrap:   true,
        },
        {
          type: "TextBlock",
          text: `You've reached your 100 document trial limit. Upgrade to a paid plan at ${UPGRADE_URL} to keep KAIRA running — your team won't miss another order.`,
          wrap: true,
        },
        {
          type: "TextBlock",
          text: "KAIRA has paused monitoring until you upgrade.",
          wrap:   true,
          isSubtle: true,
        },
      ],
      actions: [
        {
          type:  "Action.OpenUrl",
          title: "Upgrade now →",
          url:   UPGRADE_URL,
          style: "positive",
        },
      ],
    };
  }

  private static buildTeamsExpiredCard(companyName: string, trialEndDate: Date | null): object {
    const endStr = trialEndDate
      ? trialEndDate.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
      : "recently";

    return {
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      type:    "AdaptiveCard",
      version: "1.5",
      body: [
        {
          type:   "TextBlock",
          text:   `⏰ ${companyName} — Trial expired`,
          weight: "Bolder",
          size:   "Medium",
          wrap:   true,
        },
        {
          type: "TextBlock",
          text: `Your 14-day trial expired on ${endStr}. Upgrade to a paid plan at ${UPGRADE_URL} to resume monitoring.`,
          wrap: true,
        },
      ],
      actions: [
        {
          type:  "Action.OpenUrl",
          title: "Upgrade now →",
          url:   UPGRADE_URL,
          style: "positive",
        },
      ],
    };
  }
}
