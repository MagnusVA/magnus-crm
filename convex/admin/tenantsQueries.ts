import { v } from "convex/values";
import { internalQuery, query } from "../_generated/server";
import { paginationOptsValidator } from "convex/server";
import { getTenantCalendlyConnectionState } from "../lib/tenantCalendlyConnection";
import { log } from "../lib/observability/log";
import { requireSystemAdminSession } from "../requireSystemAdmin";

export const listTenants = query({
  args: {
    paginationOpts: paginationOptsValidator,
    statusFilter: v.optional(
      v.union(
        v.literal("pending_signup"),
        v.literal("pending_calendly"),
        v.literal("provisioning_webhooks"),
        v.literal("active"),
        v.literal("calendly_disconnected"),
        v.literal("suspended"),
        v.literal("invite_expired"),
      ),
    ),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    requireSystemAdminSession(identity);
    const statusFilter = args.statusFilter;

    let result;
    if (statusFilter !== undefined) {
      result = await ctx.db
        .query("tenants")
        .withIndex("by_status", (q) => q.eq("status", statusFilter))
        .order("desc")
        .paginate(args.paginationOpts);
    } else {
      result = await ctx.db
        .query("tenants")
        .order("desc")
        .paginate(args.paginationOpts);
    }

    const page = await Promise.all(
      result.page.map(async (tenant) => {
        const connection = await getTenantCalendlyConnectionState(ctx, tenant._id);
        return {
          ...tenant,
          calendlyWebhookUri: connection?.webhookUri,
        };
      }),
    );

    return {
      ...result,
      page,
    };
  },
});

export const getTenant = query({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    const identity = await ctx.auth.getUserIdentity();
    requireSystemAdminSession(identity);

    const tenant = await ctx.db.get("tenants", tenantId);
    if (!tenant) {
      throw new Error("Tenant not found");
    }

    const connection = await getTenantCalendlyConnectionState(ctx, tenantId);
    return {
      ...tenant,
      calendlyWebhookUri: connection?.webhookUri,
    };
  },
});

export const getTenantInternal = internalQuery({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    const tenant = await ctx.db.get("tenants", tenantId);
    if (!tenant) {
      return null;
    }

    const connection = await getTenantCalendlyConnectionState(ctx, tenantId);
    return {
      ...tenant,
      calendlyWebhookUri: connection?.webhookUri,
      accessToken: connection?.accessToken,
      refreshToken: connection?.refreshToken,
      tokenExpiresAt: connection?.tokenExpiresAt,
      webhookUri: connection?.webhookUri,
      webhookSecret: connection?.webhookSecret,
    };
  },
});

export const getTenantByContactEmail = internalQuery({
  args: { contactEmail: v.string() },
  handler: async (ctx, { contactEmail }) => {
    const matches = await ctx.db
      .query("tenants")
      .withIndex("by_contactEmail", (q) => q.eq("contactEmail", contactEmail))
      .take(2);

    if (matches.length > 1) {
      log.warn("tenant.data_inconsistency", {
        reason: "duplicate_contact_email",
        tenantIds: matches.map((tenant) => tenant._id),
      });
      throw new Error("Multiple tenants found for contact email");
    }

    return matches[0] ?? null;
  },
});
