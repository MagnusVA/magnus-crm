import { v } from "convex/values";
import { internalQuery, query } from "../_generated/server";
import { paginationOptsValidator } from "convex/server";
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

    if (statusFilter !== undefined) {
      return await ctx.db
        .query("tenants")
        .withIndex("by_status", (q) => q.eq("status", statusFilter))
        .order("desc")
        .paginate(args.paginationOpts);
    }

    return await ctx.db
      .query("tenants")
      .order("desc")
      .paginate(args.paginationOpts);
  },
});

export const getTenant = query({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    const identity = await ctx.auth.getUserIdentity();
    requireSystemAdminSession(identity);

    const tenant = await ctx.db.get(tenantId);
    if (!tenant) {
      throw new Error("Tenant not found");
    }

    return tenant;
  },
});

export const getTenantInternal = internalQuery({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    return await ctx.db.get(tenantId);
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
      throw new Error(
        `Multiple tenants found for contact email ${contactEmail}`,
      );
    }

    return matches[0] ?? null;
  },
});
