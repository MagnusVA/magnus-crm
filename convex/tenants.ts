import { v } from "convex/values";
import { internalMutation, internalQuery, query } from "./_generated/server";
import { getIdentityOrgId } from "./lib/identity";

export const getByWorkosOrgId = internalQuery({
  args: { workosOrgId: v.string() },
  handler: async (ctx, { workosOrgId }) => {
    console.log("[Tenants] getByWorkosOrgId called", { workosOrgId });
    const tenant = await ctx.db
      .query("tenants")
      .withIndex("by_workosOrgId", (q) => q.eq("workosOrgId", workosOrgId))
      .unique();
    console.log("[Tenants] getByWorkosOrgId result", {
      found: Boolean(tenant),
      tenantId: tenant?._id ?? null,
    });
    return tenant;
  },
});

export const getByInviteTokenHash = internalQuery({
  args: { inviteTokenHash: v.string() },
  handler: async (ctx, { inviteTokenHash }) => {
    console.log("[Tenants] getByInviteTokenHash called", {
      hashLength: inviteTokenHash.length,
    });
    const tenant = await ctx.db
      .query("tenants")
      .withIndex("by_inviteTokenHash", (q) =>
        q.eq("inviteTokenHash", inviteTokenHash),
      )
      .unique();
    console.log("[Tenants] getByInviteTokenHash result", {
      found: Boolean(tenant),
      tenantId: tenant?._id ?? null,
    });
    return tenant;
  },
});

export const getCalendlyTokens = internalQuery({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    console.log("[Tenants] getCalendlyTokens called", { tenantId });
    const tenant = await ctx.db.get(tenantId);
    if (!tenant) {
      console.error("[Tenants] getCalendlyTokens tenant not found", { tenantId });
      throw new Error("Tenant not found");
    }

    const result = {
      calendlyAccessToken: tenant.calendlyAccessToken,
      calendlyRefreshToken: tenant.calendlyRefreshToken,
      calendlyTokenExpiresAt: tenant.calendlyTokenExpiresAt,
      calendlyRefreshLockUntil: tenant.calendlyRefreshLockUntil,
      calendlyOrgUri: tenant.calendlyOrgUri,
      calendlyOwnerUri: tenant.calendlyOwnerUri,
      calendlyWebhookUri: tenant.calendlyWebhookUri,
      webhookSigningKey: tenant.webhookSigningKey,
      workosOrgId: tenant.workosOrgId,
      status: tenant.status,
    };
    console.log("[Tenants] getCalendlyTokens result", {
      tenantId,
      status: result.status,
      hasAccessToken: Boolean(result.calendlyAccessToken),
      hasRefreshToken: Boolean(result.calendlyRefreshToken),
      hasTokenExpiry: Boolean(result.calendlyTokenExpiresAt),
      hasOrgUri: Boolean(result.calendlyOrgUri),
      hasOwnerUri: Boolean(result.calendlyOwnerUri),
      hasWebhookUri: Boolean(result.calendlyWebhookUri),
      hasSigningKey: Boolean(result.webhookSigningKey),
    });
    return result;
  },
});

export const getCalendlyTenant = internalQuery({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    console.log("[Tenants] getCalendlyTenant called", { tenantId });
    const tenant = await ctx.db.get(tenantId);
    if (!tenant) {
      console.warn("[Tenants] getCalendlyTenant tenant not found, returning null", { tenantId });
      return null;
    }

    const result = {
      _id: tenant._id,
      workosOrgId: tenant.workosOrgId,
      status: tenant.status,
      companyName: tenant.companyName,
      calendlyWebhookUri: tenant.calendlyWebhookUri,
      tenantOwnerId: tenant.tenantOwnerId,
    };
    console.log("[Tenants] getCalendlyTenant result", {
      tenantId: result._id,
      status: result.status,
      companyName: result.companyName,
      hasWebhookUri: Boolean(result.calendlyWebhookUri),
    });
    return result;
  },
});

export const getCurrentTenant = query({
  args: {},
  handler: async (ctx) => {
    console.log("[Tenants] getCurrentTenant called");
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      console.warn("[Tenants] getCurrentTenant no identity, returning null");
      return null;
    }

    const workosOrgId = getIdentityOrgId(identity);
    if (!workosOrgId) {
      console.warn("[Tenants] getCurrentTenant no workosOrgId from identity, returning null");
      return null;
    }

    console.log("[Tenants] getCurrentTenant querying by workosOrgId", { workosOrgId });
    const tenant = await ctx.db
      .query("tenants")
      .withIndex("by_workosOrgId", (q) => q.eq("workosOrgId", workosOrgId))
      .unique();

    if (!tenant) {
      console.warn("[Tenants] getCurrentTenant tenant not found for orgId", { workosOrgId });
      return null;
    }

    const result = {
      tenantId: tenant._id,
      companyName: tenant.companyName,
      workosOrgId: tenant.workosOrgId,
      status: tenant.status,
      calendlyWebhookUri: tenant.calendlyWebhookUri,
      onboardingCompletedAt: tenant.onboardingCompletedAt,
    };
    console.log("[Tenants] getCurrentTenant result", {
      tenantId: result.tenantId,
      status: result.status,
      companyName: result.companyName,
      hasWebhookUri: Boolean(result.calendlyWebhookUri),
      hasOnboardingCompleted: Boolean(result.onboardingCompletedAt),
    });
    return result;
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
      v.literal("invite_expired"),
    ),
  },
  handler: async (ctx, { tenantId, status }) => {
    console.log("[Tenants] updateStatus called", { tenantId, status });
    await ctx.db.patch(tenantId, {
      status,
      webhookProvisioningStartedAt:
        status === "provisioning_webhooks" ? Date.now() : undefined,
    });
    console.log("[Tenants] updateStatus completed", { tenantId, status });
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
    const {
      tenantId,
      calendlyRefreshLockUntil,
      ...fields
    } = args;
    console.log("[Tenants] storeCalendlyTokens called", {
      tenantId,
      hasAccessToken: Boolean(fields.calendlyAccessToken),
      hasRefreshToken: Boolean(fields.calendlyRefreshToken),
      tokenExpiresAt: fields.calendlyTokenExpiresAt,
      hasOrgUri: Boolean(fields.calendlyOrgUri),
      hasOwnerUri: Boolean(fields.calendlyOwnerUri),
      hasRefreshLock: Boolean(calendlyRefreshLockUntil),
    });
    await ctx.db.patch(tenantId, {
      ...fields,
      calendlyRefreshLockUntil: calendlyRefreshLockUntil ?? undefined,
      lastTokenRefreshAt: Date.now(),
    });
    console.log("[Tenants] storeCalendlyTokens completed", { tenantId });
  },
});

export const clearCalendlyConnection = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    status: v.union(
      v.literal("pending_calendly"),
      v.literal("calendly_disconnected"),
    ),
  },
  handler: async (ctx, { tenantId, status }) => {
    console.log("[Tenants] clearCalendlyConnection called", { tenantId, status });
    await ctx.db.patch(tenantId, {
      status,
      codeVerifier: undefined,
      calendlyAccessToken: undefined,
      calendlyRefreshToken: undefined,
      calendlyTokenExpiresAt: undefined,
      calendlyOrgUri: undefined,
      calendlyOwnerUri: undefined,
      calendlyRefreshLockUntil: undefined,
      lastTokenRefreshAt: undefined,
      webhookProvisioningStartedAt: undefined,
      calendlyWebhookUri: undefined,
    });
    console.log("[Tenants] clearCalendlyConnection completed", { tenantId, status });
  },
});
