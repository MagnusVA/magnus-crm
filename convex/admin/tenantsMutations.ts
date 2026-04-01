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
    return await ctx.db.insert("tenants", {
      ...args,
      status: "pending_signup",
    });
  },
});

export const patchInviteToken = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    inviteTokenHash: v.string(),
    inviteExpiresAt: v.number(),
  },
  handler: async (ctx, { tenantId, ...fields }) => {
    await ctx.db.patch(tenantId, fields);
  },
});

export const resetTenantForReonboarding = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    inviteTokenHash: v.string(),
    inviteExpiresAt: v.number(),
  },
  handler: async (ctx, { tenantId, inviteTokenHash, inviteExpiresAt }) => {
    const tenant = await ctx.db.get(tenantId);
    if (!tenant) {
      throw new Error("Tenant not found");
    }

    await ctx.db.patch(tenantId, {
      status: "pending_signup" as const,
      inviteTokenHash,
      inviteExpiresAt,
      inviteRedeemedAt: undefined,
      codeVerifier: undefined,
      calendlyAccessToken: undefined,
      calendlyRefreshToken: undefined,
      calendlyTokenExpiresAt: undefined,
      calendlyOrgUri: undefined,
      calendlyOwnerUri: undefined,
      calendlyRefreshLockUntil: undefined,
      calendlyWebhookUri: undefined,
      webhookSigningKey: undefined,
      onboardingCompletedAt: undefined,
    });
  },
});

export const deleteTenantRuntimeDataBatch = internalMutation({
  args: {
    tenantId: v.id("tenants"),
  },
  handler: async (ctx, { tenantId }) => {
    const rawWebhookEvents = await ctx.db
      .query("rawWebhookEvents")
      .withIndex("by_tenantId_and_eventType", (q) => q.eq("tenantId", tenantId))
      .take(CLEANUP_BATCH_SIZE);

    for (const event of rawWebhookEvents) {
      await ctx.db.delete(event._id);
    }

    const calendlyOrgMembers = await ctx.db
      .query("calendlyOrgMembers")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .take(CLEANUP_BATCH_SIZE);

    for (const member of calendlyOrgMembers) {
      await ctx.db.delete(member._id);
    }

    return {
      deletedRawWebhookEvents: rawWebhookEvents.length,
      deletedCalendlyOrgMembers: calendlyOrgMembers.length,
      hasMore:
        rawWebhookEvents.length === CLEANUP_BATCH_SIZE ||
        calendlyOrgMembers.length === CLEANUP_BATCH_SIZE,
    };
  },
});
