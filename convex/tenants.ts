import { v } from "convex/values";
import type { UserIdentity } from "convex/server";
import { internalMutation, internalQuery, query } from "./_generated/server";

function getIdentityOrgId(identity: UserIdentity) {
  const rawIdentity = identity as Record<string, unknown>;

  return (
    (typeof rawIdentity.organization_id === "string"
      ? rawIdentity.organization_id
      : undefined) ??
    (typeof rawIdentity.organizationId === "string"
      ? rawIdentity.organizationId
      : undefined) ??
    (typeof rawIdentity.org_id === "string" ? rawIdentity.org_id : undefined)
  );
}

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

export const getCalendlyTenant = internalQuery({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    const tenant = await ctx.db.get(tenantId);
    if (!tenant) {
      return null;
    }

    return {
      _id: tenant._id,
      workosOrgId: tenant.workosOrgId,
      status: tenant.status,
      companyName: tenant.companyName,
      calendlyWebhookUri: tenant.calendlyWebhookUri,
    };
  },
});

export const getCurrentTenant = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return null;
    }

    const workosOrgId = getIdentityOrgId(identity);
    if (!workosOrgId) {
      return null;
    }

    const tenant = await ctx.db
      .query("tenants")
      .withIndex("by_workosOrgId", (q) => q.eq("workosOrgId", workosOrgId))
      .unique();

    if (!tenant) {
      return null;
    }

    return {
      tenantId: tenant._id,
      companyName: tenant.companyName,
      workosOrgId: tenant.workosOrgId,
      status: tenant.status,
      calendlyWebhookUri: tenant.calendlyWebhookUri,
      onboardingCompletedAt: tenant.onboardingCompletedAt,
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
