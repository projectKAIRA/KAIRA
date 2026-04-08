import { Router, Request, Response } from "express";
import { TenantRegistry } from "../services/tenant/TenantRegistry.js";
import { TenantScheduler } from "../services/tenant/TenantScheduler.js";
import { TenantConfig, CreateTenantInput, UpdateTenantInput } from "../types/tenant.js";

/**
 * Tenant CRUD router.
 *
 * Mounted at /tenants in app.ts.
 *
 * Every mutating operation that changes a tenant's active state or credentials
 * is reflected in the scheduler immediately — no restart required.
 *
 * Sensitive credential fields (clientSecret, botToken, signingSecret) are
 * stripped from all responses.
 */
export function createTenantsRouter(scheduler: TenantScheduler): Router {
  const router   = Router();
  const registry = new TenantRegistry();

  // ─── GET /tenants ─────────────────────────────────────────────────────────
  // List all tenants (active and inactive).

  router.get("/", async (_req: Request, res: Response) => {
    const tenants = await registry.findAll();
    res.json(tenants.map(sanitize));
  });

  // ─── GET /tenants/:id ─────────────────────────────────────────────────────

  router.get("/:id", async (req: Request, res: Response) => {
    const tenant = await registry.findById(req.params["id"] as string);
    if (!tenant) {
      res.status(404).json({ error: "Tenant not found." });
      return;
    }
    res.json(sanitize(tenant));
  });

  // ─── POST /tenants ────────────────────────────────────────────────────────
  // Create a new tenant. If isActive is true (the default) the tenant is
  // immediately registered with the scheduler and polling begins.

  router.post("/", async (req: Request, res: Response) => {
    const body = req.body as Partial<CreateTenantInput>;

    const missing = validateCreate(body);
    if (missing.length > 0) {
      res.status(400).json({ error: `Missing required fields: ${missing.join(", ")}` });
      return;
    }

    const input = body as CreateTenantInput;
    const tenant = await registry.create(input);

    if (tenant.isActive) {
      scheduler.addTenant(tenant);
    }

    res.status(201).json(sanitize(tenant));
  });

  // ─── PATCH /tenants/:id ───────────────────────────────────────────────────
  // Partial update. If the tenant is currently running in the scheduler its
  // runtime is rebuilt with the new config (brief polling gap is acceptable).

  router.patch("/:id", async (req: Request, res: Response) => {
    const id     = req.params["id"] as string;
    const exists = await registry.findById(id);
    if (!exists) {
      res.status(404).json({ error: "Tenant not found." });
      return;
    }

    const updated = await registry.update(id, req.body as UpdateTenantInput);

    // Rebuild the runtime if the tenant is registered so new credentials /
    // settings take effect immediately.
    if (scheduler.getRuntime(id)) {
      scheduler.removeTenant(id);
      if (updated.isActive) {
        scheduler.addTenant(updated);
      }
    }

    res.json(sanitize(updated));
  });

  // ─── DELETE /tenants/:id ──────────────────────────────────────────────────
  // Permanently deletes the tenant and all related orders / delta links
  // (cascades via the Prisma schema). Removes from scheduler first.

  router.delete("/:id", async (req: Request, res: Response) => {
    const id     = req.params["id"] as string;
    const exists = await registry.findById(id);
    if (!exists) {
      res.status(404).json({ error: "Tenant not found." });
      return;
    }

    scheduler.removeTenant(id);   // no-op if not registered
    await registry.delete(id);
    res.sendStatus(204);
  });

  // ─── POST /tenants/:id/activate ───────────────────────────────────────────
  // Mark active in DB and start polling.

  router.post("/:id/activate", async (req: Request, res: Response) => {
    const id     = req.params["id"] as string;
    const exists = await registry.findById(id);
    if (!exists) {
      res.status(404).json({ error: "Tenant not found." });
      return;
    }

    const tenant = await registry.activate(id);

    if (!scheduler.getRuntime(id)) {
      scheduler.addTenant(tenant);
    }

    res.json(sanitize(tenant));
  });

  // ─── POST /tenants/:id/deactivate ─────────────────────────────────────────
  // Stop polling and mark inactive in DB. Data is preserved.

  router.post("/:id/deactivate", async (req: Request, res: Response) => {
    const id     = req.params["id"] as string;
    const exists = await registry.findById(id);
    if (!exists) {
      res.status(404).json({ error: "Tenant not found." });
      return;
    }

    scheduler.removeTenant(id);   // stops the poll loop
    const tenant = await registry.deactivate(id);
    res.json(sanitize(tenant));
  });

  return router;
}

// ─── Input validation ─────────────────────────────────────────────────────────

function validateCreate(body: Partial<CreateTenantInput>): string[] {
  const missing: string[] = [];
  if (!body.name) missing.push("name");

  const provider = body.providerType ?? "microsoft";

  if (provider === "imap") {
    if (!body.imap?.host)     missing.push("imap.host");
    if (!body.imap?.port)     missing.push("imap.port");
    if (!body.imap?.username) missing.push("imap.username");
    if (!body.imap?.password) missing.push("imap.password");
    if (!body.imap?.inboxFolder) missing.push("imap.inboxFolder");
    if (body.imap?.pollIntervalSeconds == null) missing.push("imap.pollIntervalSeconds");
  } else {
    if (!body.graph?.clientId)           missing.push("graph.clientId");
    if (!body.graph?.clientSecret)       missing.push("graph.clientSecret");
    if (!body.graph?.tenantId)           missing.push("graph.tenantId");
    if (!body.graph?.userEmail)          missing.push("graph.userEmail");
    if (!body.graph?.inboxFolder)        missing.push("graph.inboxFolder");
    if (body.graph?.pollIntervalSeconds == null) missing.push("graph.pollIntervalSeconds");
  }

  return missing;
}

// ─── Response sanitiser ───────────────────────────────────────────────────────
// Strips sensitive credential fields before sending to the caller.

function sanitize(tenant: TenantConfig) {
  const { clientSecret: _cs, ...graphSafe } = tenant.graph;
  const { botToken: _bt, signingSecret: _ss, ...slackSafe } = tenant.slack;

  // Strip IMAP password if present
  const imapSafe = tenant.imap
    ? (({ password: _pw, ...rest }) => rest)(tenant.imap)
    : null;

  return { ...tenant, graph: graphSafe, imap: imapSafe, slack: slackSafe };
}
