import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import schema from "../schema";
import { member } from "./validators";
import { rejectRequest } from "../lib/observability/errors";
import { log } from "../lib/observability/log";

const connectionDoc = v.object({
  ...schema.tables.tenantFathomConnections.validator.fields,
  _id: v.id("tenantFathomConnections"),
  _creationTime: v.number(),
});
export const connection = internalQuery({
  args: { connectionId: v.id("tenantFathomConnections") },
  returns: v.union(v.null(), connectionDoc),
  handler: (ctx, a) => ctx.db.get("tenantFathomConnections", a.connectionId),
});
export const byTenant = internalQuery({
  args: { tenantId: v.id("tenants") },
  returns: v.union(v.null(), connectionDoc),
  handler: (ctx, a) =>
    ctx.db
      .query("tenantFathomConnections")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", a.tenantId))
      .unique(),
});
export const begin = internalMutation({
  args: { tenantId: v.id("tenants"), userId: v.id("users"), token: v.string() },
  returns: connectionDoc,
  handler: async (ctx, a) => {
    const row = await ctx.db
      .query("tenantFathomConnections")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", a.tenantId))
      .unique();
    if (row?.operationUntil && row.operationUntil > Date.now())
      throw rejectRequest(
        "fathom.connection_busy",
        "A Fathom connection change is already running.",
      );
    const patch = {
      operationToken: a.token,
      operationUntil: Date.now() + 120_000,
    };
    const id =
      row?._id ??
      (await ctx.db.insert("tenantFathomConnections", {
        tenantId: a.tenantId,
        apiKey: "",
        keyLast4: "",
        triggeredFor: [],
        connectionStatus: "disconnected",
        connectedByUserId: a.userId,
        connectedAt: Date.now(),
      }));
    await ctx.db.patch("tenantFathomConnections", id, patch);
    return (await ctx.db.get("tenantFathomConnections", id))!;
  },
});
export const finish = internalMutation({
  args: {
    connectionId: v.id("tenantFathomConnections"),
    token: v.string(),
    apiKey: v.optional(v.string()),
    webhookId: v.optional(v.string()),
    webhookSecret: v.optional(v.string()),
    triggeredFor: v.optional(v.array(v.string())),
    accountAdmin: v.optional(v.boolean()),
    disconnected: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    const row = await ctx.db.get("tenantFathomConnections", a.connectionId);
    if (!row || row.operationToken !== a.token)
      throw new Error("Fathom connection operation superseded");
    if (a.disconnected) {
      await ctx.db.patch("tenantFathomConnections", row._id, {
        apiKey: "",
        keyLast4: "",
        webhookId: undefined,
        webhookSecret: undefined,
        connectionStatus: "disconnected",
        operationToken: undefined,
        operationUntil: undefined,
        reconcileToken: undefined,
        reconcileUntil: undefined,
      });
    } else if (a.apiKey && a.webhookId && a.webhookSecret) {
      await ctx.db.patch("tenantFathomConnections", row._id, {
        apiKey: a.apiKey,
        keyLast4: a.apiKey.slice(-4),
        webhookId: a.webhookId,
        webhookSecret: a.webhookSecret,
        triggeredFor: a.triggeredFor ?? [],
        keyHolderIsAccountAdmin: a.accountAdmin,
        connectionStatus: "connected",
        connectedAt: Date.now(),
        reconcileToken: undefined,
        reconcileUntil: undefined,
        lastError: undefined,
        operationToken: undefined,
        operationUntil: undefined,
      });
    } else
      await ctx.db.patch("tenantFathomConnections", row._id, {
        operationToken: undefined,
        operationUntil: undefined,
      });
    return null;
  },
});
// One persisted request clock covers sync, import and enrichment, including overlapping actions.
export const reserveRequest = internalMutation({
  args: { connectionId: v.id("tenantFathomConnections") },
  returns: v.number(),
  handler: async (ctx, a) => {
    const row = await ctx.db.get("tenantFathomConnections", a.connectionId);
    if (!row) throw new Error("Fathom connection missing");
    const at = Math.max(Date.now(), row.nextRequestAt ?? 0);
    // Don't build an unbounded queue of reservations during rate limiting.
    if (at > Date.now() + 45_000) return at;
    await ctx.db.patch("tenantFathomConnections", row._id, {
      nextRequestAt: at + 2100,
    });
    return at;
  },
});
export const failure = internalMutation({
  args: {
    connectionId: v.id("tenantFathomConnections"),
    status: v.optional(v.number()),
    apiKey: v.optional(v.string()),
    retryAt: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    const row = await ctx.db.get("tenantFathomConnections", a.connectionId);
    if (row && (!a.apiKey || a.apiKey === row.apiKey))
      await ctx.db.patch("tenantFathomConnections", row._id, {
        lastError: a.status
          ? `Fathom request failed: HTTP ${a.status}`
          : "Fathom is temporarily unavailable. Retrying automatically.",
        ...(a.status === 401
          ? { connectionStatus: "invalid_key" as const }
          : {}),
        ...(a.retryAt
          ? { nextRequestAt: Math.max(row.nextRequestAt ?? 0, a.retryAt) }
          : {}),
      });
    return null;
  },
});
export const syncMembers = internalMutation({
  args: {
    connectionId: v.id("tenantFathomConnections"),
    members: v.array(member),
    accountAdmin: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    const c = await ctx.db.get("tenantFathomConnections", a.connectionId);
    if (!c || c.connectionStatus === "disconnected") return null;
    for (const m of a.members) {
      const email = m.email.trim().toLowerCase();
      const row = await ctx.db
        .query("fathomOrgMembers")
        .withIndex("by_tenantId_and_email", (q) =>
          q.eq("tenantId", c.tenantId).eq("email", email),
        )
        .unique();
      const user =
        !row?.matchedUserId && !row?.ignored
          ? await ctx.db
              .query("users")
              .withIndex("by_tenantId_and_email", (q) =>
                q.eq("tenantId", c.tenantId).eq("email", email),
              )
              .first()
          : null;
      const patch = {
        name: m.name,
        ...(m.viewAccessLevel !== undefined
          ? {
              viewAccessLevel: m.viewAccessLevel,
              settingsAccessLevel: m.settingsAccessLevel,
            }
          : {}),
        lastSyncedAt: Date.now(),
        ...(user?.isActive ? { matchedUserId: user._id } : {}),
      };
      if (row) await ctx.db.patch("fathomOrgMembers", row._id, patch);
      else
        await ctx.db.insert("fathomOrgMembers", {
          tenantId: c.tenantId,
          email,
          ignored: false,
          ...patch,
        });
    }
    await ctx.db.patch("tenantFathomConnections", c._id, {
      lastMemberSyncAt: Date.now(),
      ...(a.accountAdmin !== undefined
        ? { keyHolderIsAccountAdmin: a.accountAdmin }
        : {}),
    });
    await ctx.scheduler.runAfter(0, internal.fathom.processor.retryHeld, {
      tenantId: c.tenantId,
      cursor: null,
    });
    log.info("fathom.members.synced", {
      tenantId: c.tenantId,
      count: a.members.length,
    });
    return null;
  },
});
