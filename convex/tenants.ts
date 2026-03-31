import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

export const getByWorkosOrgId = internalQuery({
  args: { workosOrgId: v.string() },
  handler: async (ctx, { workosOrgId }) => {
    return await ctx.db
      .query("tenants")
      .withIndex("by_workosOrgId", (q) => q.eq("workosOrgId", workosOrgId))
      .unique();
  },
});

export const getByInviteTokenHash = internalQuery({
  args: { inviteTokenHash: v.string() },
  handler: async (ctx, { inviteTokenHash }) => {
    return await ctx.db
      .query("tenants")
      .withIndex("by_inviteTokenHash", (q) =>
        q.eq("inviteTokenHash", inviteTokenHash),
      )
      .unique();
  },
});

export const getCalendlyTokens = internalQuery({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    const tenant = await ctx.db.get(tenantId);
    if (!tenant) {
      throw new Error("Tenant not found");
    }

    return {
      calendlyAccessToken: tenant.calendlyAccessToken,
      calendlyRefreshToken: tenant.calendlyRefreshToken,
      calendlyTokenExpiresAt: tenant.calendlyTokenExpiresAt,
      calendlyRefreshLockUntil: tenant.calendlyRefreshLockUntil,
      calendlyOrgUri: tenant.calendlyOrgUri,
      status: tenant.status,
    };
  },
});

export const updateStatus = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    status: v.union(
      v.literal("pending_signup"),
      v.literal("pending_calendly"),
      v.literal("provisioning_webhooks"),
      v.literal("active"),
      v.literal("calendly_disconnected"),
      v.literal("suspended"),
    ),
  },
  handler: async (ctx, { tenantId, status }) => {
    await ctx.db.patch(tenantId, { status });
  },
});

export const storeCalendlyTokens = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    calendlyAccessToken: v.string(),
    calendlyRefreshToken: v.string(),
    calendlyTokenExpiresAt: v.number(),
    calendlyOrgUri: v.optional(v.string()),
    calendlyOwnerUri: v.optional(v.string()),
    calendlyRefreshLockUntil: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { tenantId, ...fields } = args;
    await ctx.db.patch(tenantId, fields);
  },
});
