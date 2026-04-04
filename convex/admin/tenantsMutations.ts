import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

const CLEANUP_BATCH_SIZE = 128;

export const insertTenant = internalMutation({
  args: {
    companyName: v.string(),
    contactEmail: v.string(),
    workosOrgId: v.string(),
    notes: v.optional(v.string()),
    createdBy: v.string(),
    inviteTokenHash: v.string(),
    inviteExpiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    console.log("[Admin] insertTenant called", {
      companyName: args.companyName,
      contactEmail: args.contactEmail,
      workosOrgId: args.workosOrgId,
    });
    const id = await ctx.db.insert("tenants", {
      ...args,
      status: "pending_signup",
    });
    console.log("[Admin] insertTenant completed", { insertedId: id });
    return id;
  },
});

export const patchInviteToken = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    inviteTokenHash: v.string(),
    inviteExpiresAt: v.number(),
  },
  handler: async (ctx, { tenantId, ...fields }) => {
    console.log("[Admin] patchInviteToken called", { tenantId });
    await ctx.db.patch(tenantId, fields);
  },
});

export const deleteTenant = internalMutation({
  args: {
    tenantId: v.id("tenants"),
  },
  handler: async (ctx, { tenantId }) => {
    console.log("[Admin] deleteTenant called", { tenantId });
    const tenant = await ctx.db.get(tenantId);
    if (!tenant) {
      console.error("[Admin] deleteTenant: tenant not found", { tenantId });
      throw new Error("Tenant not found");
    }
    console.log("[Admin] deleteTenant: tenant found, deleting", {
      tenantId,
      companyName: tenant.companyName,
      status: tenant.status,
    });

    await ctx.db.delete(tenantId);
    console.log("[Admin] deleteTenant completed", { tenantId });
  },
});

export const deleteTenantRuntimeDataBatch = internalMutation({
  args: {
    tenantId: v.id("tenants"),
  },
  handler: async (ctx, { tenantId }) => {
    console.log("[Admin] deleteTenantRuntimeDataBatch called", { tenantId });

    const rawWebhookEvents = await ctx.db
      .query("rawWebhookEvents")
      .withIndex("by_tenantId_and_eventType", (q) => q.eq("tenantId", tenantId))
      .take(CLEANUP_BATCH_SIZE);

    for (const event of rawWebhookEvents) {
      await ctx.db.delete(event._id);
    }
    console.log("[Admin] deleteTenantRuntimeDataBatch: rawWebhookEvents deleted", {
      tenantId,
      count: rawWebhookEvents.length,
    });

    const calendlyOrgMembers = await ctx.db
      .query("calendlyOrgMembers")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .take(CLEANUP_BATCH_SIZE);

    for (const member of calendlyOrgMembers) {
      await ctx.db.delete(member._id);
    }
    console.log("[Admin] deleteTenantRuntimeDataBatch: calendlyOrgMembers deleted", {
      tenantId,
      count: calendlyOrgMembers.length,
    });

    const users = await ctx.db
      .query("users")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .take(CLEANUP_BATCH_SIZE);

    for (const user of users) {
      await ctx.db.delete(user._id);
    }
    console.log("[Admin] deleteTenantRuntimeDataBatch: users deleted", {
      tenantId,
      count: users.length,
    });

    const hasMore =
      rawWebhookEvents.length === CLEANUP_BATCH_SIZE ||
      calendlyOrgMembers.length === CLEANUP_BATCH_SIZE ||
      users.length === CLEANUP_BATCH_SIZE;

    console.log("[Admin] deleteTenantRuntimeDataBatch completed", {
      tenantId,
      hasMore,
    });

    return {
      deletedRawWebhookEvents: rawWebhookEvents.length,
      deletedCalendlyOrgMembers: calendlyOrgMembers.length,
      deletedUsers: users.length,
      hasMore,
    };
  },
});
