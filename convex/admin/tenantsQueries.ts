import { v } from "convex/values";
import { internalQuery, query } from "../_generated/server";
import { paginationOptsValidator } from "convex/server";
import { getTenantCalendlyConnectionState } from "../lib/tenantCalendlyConnection";
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
    console.log("[Admin] listTenants called", {
      statusFilter: args.statusFilter ?? "none",
    });
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

    console.log("[Admin] listTenants completed", {
      resultCount: result.page.length,
      isDone: result.isDone,
    });

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
    console.log("[Admin] getTenant called", { tenantId });
    const identity = await ctx.auth.getUserIdentity();
    requireSystemAdminSession(identity);

    const tenant = await ctx.db.get(tenantId);
    if (!tenant) {
      console.warn("[Admin] getTenant: tenant not found", { tenantId });
      throw new Error("Tenant not found");
    }

    console.log("[Admin] getTenant: tenant found", {
      tenantId,
      status: tenant.status,
    });
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
    console.log("[Admin] getTenantInternal called", { tenantId });
    const tenant = await ctx.db.get(tenantId);
    if (!tenant) {
      console.warn("[Admin] getTenantInternal: tenant not found", { tenantId });
    } else {
      console.log("[Admin] getTenantInternal: tenant found", {
        tenantId,
        status: tenant.status,
      });
    }
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
    console.log("[Admin] getTenantByContactEmail called", { contactEmail });
    const matches = await ctx.db
      .query("tenants")
      .withIndex("by_contactEmail", (q) => q.eq("contactEmail", contactEmail))
      .take(2);

    console.log("[Admin] getTenantByContactEmail: match count", {
      contactEmail,
      matchCount: matches.length,
    });

    if (matches.length > 1) {
      console.error("[Admin] getTenantByContactEmail: multiple tenants found", {
        contactEmail,
        matchCount: matches.length,
      });
      throw new Error(
        `Multiple tenants found for contact email ${contactEmail}`,
      );
    }

    return matches[0] ?? null;
  },
});
