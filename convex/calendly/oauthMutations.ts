import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";

export const storeCodeVerifier = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    codeVerifier: v.string(),
  },
  handler: async (ctx, { tenantId, codeVerifier }) => {
    console.log(`[Calendly:OAuth] storeCodeVerifier: storing for tenant ${tenantId}`);
    await ctx.db.patch(tenantId, { codeVerifier });
  },
});

export const getCodeVerifier = internalQuery({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    console.log(`[Calendly:OAuth] getCodeVerifier: retrieving for tenant ${tenantId}`);
    const tenant = await ctx.db.get(tenantId);
    if (!tenant) {
      console.warn(`[Calendly:OAuth] getCodeVerifier: tenant ${tenantId} not found`);
      return null;
    }
    console.log(`[Calendly:OAuth] getCodeVerifier: hasCodeVerifier=${Boolean(tenant.codeVerifier)}`);
    return { codeVerifier: tenant.codeVerifier };
  },
});

export const clearCodeVerifier = internalMutation({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    console.log(`[Calendly:OAuth] clearCodeVerifier: clearing for tenant ${tenantId}`);
    await ctx.db.patch(tenantId, { codeVerifier: undefined });
  },
});
