import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";

export const storeCodeVerifier = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    codeVerifier: v.string(),
  },
  handler: async (ctx, { tenantId, codeVerifier }) => {
    await ctx.db.patch(tenantId, { codeVerifier });
  },
});

export const getCodeVerifier = internalQuery({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    const tenant = await ctx.db.get(tenantId);
    if (!tenant) return null;
    return { codeVerifier: tenant.codeVerifier };
  },
});

export const clearCodeVerifier = internalMutation({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    await ctx.db.patch(tenantId, { codeVerifier: undefined });
  },
});
