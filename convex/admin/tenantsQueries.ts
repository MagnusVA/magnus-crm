import { v } from "convex/values";
import { internalQuery, query } from "../_generated/server";
import { requireSystemAdminSession } from "../requireSystemAdmin";

export const listTenants = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    requireSystemAdminSession(identity);

    return await ctx.db.query("tenants").order("desc").take(100);
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
