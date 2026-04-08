import { getPrismaClient } from "../../lib/prisma.js";
import { TenantRegistry } from "./TenantRegistry.js";
import { TenantRuntime } from "./TenantRuntime.js";
import { TenantConfig } from "../../types/tenant.js";
import { ProcessingResult } from "../../types/index.js";
import { TrialGuard } from "./TrialGuard.js";

// ─── Per-tenant state ─────────────────────────────────────────────────────────

interface TenantEntry {
  runtime:     TenantRuntime;
  timer:       ReturnType<typeof setInterval>;
  isRunning:   boolean;
  lastRunAt:   Date | null;
  lastResults: ProcessingResult[];
}

// ─── Public status shape (used by the HTTP status endpoint) ──────────────────

export interface TenantSchedulerStatus {
  tenantId:    string;
  tenantName:  string;
  isRunning:   boolean;
  lastRunAt:   string | null;
  lastResults: ProcessingResult[];
}

/**
 * TenantScheduler
 *
 * Owns the lifecycle of every TenantRuntime. Replaces the single hard-coded
 * cron job that existed in index.ts with an independent polling loop per
 * tenant, each respecting its own pollIntervalSeconds setting.
 *
 * Runtime operations (add / remove) take effect immediately without a
 * process restart — the scheduler starts or stops the timer for that
 * tenant on the spot.
 */
export class TenantScheduler {
  private readonly entries  = new Map<string, TenantEntry>();
  private readonly registry = new TenantRegistry();

  constructor(
    private readonly claudeApiKey: string,
    private readonly claudeModel:  string,
  ) {}

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Load all active tenants from the database and start a polling loop for
   * each one.  Call once at process startup.
   */
  async start(): Promise<void> {
    const tenants = await this.registry.findActive();

    if (tenants.length === 0) {
      console.warn("[TenantScheduler] No active tenants found in the database.");
      console.warn("[TenantScheduler] Add a tenant via the admin API to begin processing.");
      return;
    }

    for (const tenantConfig of tenants) {
      this.addTenant(tenantConfig);
    }

    console.log(`[TenantScheduler] Started ${tenants.length} tenant(s).`);
  }

  /**
   * Register a new tenant, create its runtime, and start polling immediately.
   * Safe to call at any time — if the tenant is already registered the call
   * is a no-op.
   */
  addTenant(tenantConfig: TenantConfig): void {
    if (this.entries.has(tenantConfig.id)) {
      console.warn(`[TenantScheduler] Tenant "${tenantConfig.name}" (${tenantConfig.id}) is already registered.`);
      return;
    }

    let runtime: TenantRuntime;
    try {
      runtime = new TenantRuntime(tenantConfig, this.claudeApiKey, this.claudeModel);
    } catch (err) {
      console.error(
        `[TenantScheduler] Failed to initialise runtime for tenant "${tenantConfig.name}":`,
        err,
      );
      return;
    }

    const intervalMs = tenantConfig.graph.pollIntervalSeconds * 1000;
    const entry: TenantEntry = {
      runtime,
      isRunning:   false,
      lastRunAt:   null,
      lastResults: [],
      // Assigned below — TypeScript requires the property to be initialised
      // so we use a placeholder then overwrite immediately.
      timer: setInterval(() => {}, 0),
    };

    // Overwrite with the real timer now that `entry` exists in scope
    clearInterval(entry.timer);
    entry.timer = setInterval(() => { void this.runCycle(tenantConfig.id); }, intervalMs);

    this.entries.set(tenantConfig.id, entry);

    console.log(
      `[TenantScheduler] Tenant "${tenantConfig.name}" registered — ` +
      `polling every ${tenantConfig.graph.pollIntervalSeconds}s.`,
    );

    // Fire an immediate cycle so the first results appear without waiting
    // for the first interval tick.
    void this.runCycle(tenantConfig.id);
  }

  /**
   * Stop the polling loop for a tenant and discard its runtime.
   * The tenant's data in the database is unaffected.
   */
  removeTenant(tenantId: string): void {
    const entry = this.entries.get(tenantId);
    if (!entry) {
      console.warn(`[TenantScheduler] Attempted to remove unknown tenant: ${tenantId}`);
      return;
    }

    clearInterval(entry.timer);
    this.entries.delete(tenantId);
    console.log(`[TenantScheduler] Tenant "${entry.runtime.config.name}" (${tenantId}) removed.`);
  }

  /**
   * Stop all polling loops.  Call during graceful shutdown.
   */
  stopAll(): void {
    for (const [tenantId] of this.entries) {
      this.removeTenant(tenantId);
    }
    console.log("[TenantScheduler] All tenants stopped.");
  }

  // ─── Manual trigger ───────────────────────────────────────────────────────

  /**
   * Trigger an immediate processing cycle for a specific tenant, outside its
   * regular interval.  Returns the results once the cycle completes.
   * Throws if the tenant is not registered.
   */
  async runNow(tenantId: string): Promise<ProcessingResult[]> {
    const entry = this.entries.get(tenantId);
    if (!entry) throw new Error(`Tenant not registered: ${tenantId}`);
    await this.runCycle(tenantId);
    return entry.lastResults;
  }

  // ─── Accessors ────────────────────────────────────────────────────────────

  getRuntime(tenantId: string): TenantRuntime | undefined {
    return this.entries.get(tenantId)?.runtime;
  }

  getAllRuntimes(): TenantRuntime[] {
    return Array.from(this.entries.values()).map((e) => e.runtime);
  }

  /**
   * Locate which tenant owns a given TrackedOrder ID.
   * Used by the Slack interaction handler to route a claim button click
   * to the correct tenant's SlackInteractionService.
   */
  async findRuntimeByOrderId(orderId: string): Promise<TenantRuntime | undefined> {
    const db  = getPrismaClient();
    const row = await db.trackedOrder.findUnique({
      where:  { id: orderId },
      select: { tenantId: true },
    });
    if (!row) return undefined;
    return this.entries.get(row.tenantId)?.runtime;
  }

  /** Snapshot of every registered tenant's current state — for the status endpoint. */
  getStatus(): TenantSchedulerStatus[] {
    return Array.from(this.entries.entries()).map(([tenantId, entry]) => ({
      tenantId,
      tenantName:  entry.runtime.config.name,
      isRunning:   entry.isRunning,
      lastRunAt:   entry.lastRunAt?.toISOString() ?? null,
      lastResults: entry.lastResults,
    }));
  }

  // ─── Private cycle runner ─────────────────────────────────────────────────

  private async runCycle(tenantId: string): Promise<void> {
    const entry = this.entries.get(tenantId);
    if (!entry) return;

    if (entry.isRunning) {
      console.log(
        `[TenantScheduler] Tenant "${entry.runtime.config.name}" — ` +
        `previous cycle still running, skipping.`,
      );
      return;
    }

    entry.isRunning = true;
    try {
      // ── Trial enforcement (pre-cycle) ──────────────────────────────────────
      const isTrial = entry.runtime.config.planTier === "trial" &&
                      entry.runtime.config.isTrialActive;

      if (isTrial) {
        // Reset monthly count if we've crossed a calendar month boundary.
        await TrialGuard.maybeResetMonthlyCount(tenantId);

        const status = await TrialGuard.check(tenantId);

        if (status.blocked && status.reason === "expired") {
          console.log(
            `[TenantScheduler] Trial expired for "${entry.runtime.config.name}" — ` +
            `deactivating tenant.`,
          );
          await TrialGuard.handleExpiry(entry.runtime.config);
          this.removeTenant(tenantId);
          return;
        }

        if (status.blocked && status.reason === "limit_reached") {
          console.log(
            `[TenantScheduler] Trial limit already reached for ` +
            `"${entry.runtime.config.name}" — skipping cycle.`,
          );
          return;
        }
      }

      // ── Run the processing cycle ───────────────────────────────────────────
      const results = await entry.runtime.processor.runCycle();
      entry.lastRunAt   = new Date();
      entry.lastResults = results;

      const summary =
        results.map((r) => `${r.action}:${r.details ?? r.error ?? "ok"}`).join(", ") || "none";
      console.log(
        `[TenantScheduler] Tenant "${entry.runtime.config.name}" — ` +
        `cycle complete. Results: [${summary}]`,
      );

      // ── Trial enforcement (post-cycle) ─────────────────────────────────────
      if (isTrial) {
        const processed = results.filter(
          (r) => r.success && r.action !== "error",
        ).length;

        if (processed > 0) {
          const { newCount, limitReached } = await TrialGuard.incrementDocCount(
            tenantId,
            processed,
          );

          console.log(
            `[TenantScheduler] Trial usage for "${entry.runtime.config.name}": ` +
            `${newCount}/${entry.runtime.config.monthlyDocCount + processed} docs this month.`,
          );

          if (limitReached) {
            await TrialGuard.handleLimitReached(entry.runtime.config);
            // Leave the polling loop running — the pre-cycle guard will skip
            // future cycles until the monthly count resets or they upgrade.
          }
        }
      }
    } catch (err) {
      console.error(
        `[TenantScheduler] Tenant "${entry.runtime.config.name}" — ` +
        `unhandled error in cycle:`,
        err,
      );
    } finally {
      entry.isRunning = false;
    }
  }
}
