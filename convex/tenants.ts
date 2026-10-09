import { v } from "convex/values";
import { internalMutation, internalQuery, query } from "./_generated/server";
import { getIdentityOrgId } from "./lib/identity";
import {
  getTenantCalendlyConnectionState,
  updateTenantCalendlyConnection,
} from "./lib/tenantCalendlyConnection";
import { log } from "./lib/observability/log";

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

export const getCalendlyTenant = internalQuery({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    const tenant = await ctx.db.get("tenants", tenantId);
    if (!tenant) {
      return null;
    }

    const connection = await getTenantCalendlyConnectionState(ctx, tenantId);
    return {
      _id: tenant._id,
      workosOrgId: tenant.workosOrgId,
      status: tenant.status,
      companyName: tenant.companyName,
      calendlyWebhookUri: connection?.webhookUri,
      tenantOwnerId: tenant.tenantOwnerId,
    };
  },
});

// eslint-disable-next-line @convex-dev/require-access-control -- returns null when signed out; reads only the caller's tenant
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

    const connection = await getTenantCalendlyConnectionState(ctx, tenant._id);
    return {
      tenantId: tenant._id,
      companyName: tenant.companyName,
      workosOrgId: tenant.workosOrgId,
      status: tenant.status,
      calendlyWebhookUri: connection?.webhookUri,
      onboardingCompletedAt: tenant.onboardingCompletedAt,
      billingOpsEnabled: tenant.billingOpsEnabled === true,
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
      v.literal("invite_expired"),
    ),
  },
  handler: async (ctx, { tenantId, status }) => {
    const webhookProvisioningStartedAt =
      status === "provisioning_webhooks" ? Date.now() : undefined;

    await updateTenantCalendlyConnection(ctx, tenantId, {
      webhookProvisioningStartedAt,
    });
    await ctx.db.patch("tenants", tenantId, {
      status,
    });
    log.info("tenant.status.updated", { tenantId, status });
  },
});
