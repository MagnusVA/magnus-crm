import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import {
  getTenantCalendlyConnectionState,
  updateTenantCalendlyConnection,
} from "../lib/tenantCalendlyConnection";

export const storePkceVerifier = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    pkceVerifier: v.string(),
  },
  handler: async (ctx, { tenantId, pkceVerifier }) => {
    await updateTenantCalendlyConnection(ctx, tenantId, { pkceVerifier });
  },
});

export const getPkceVerifier = internalQuery({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    const connection = await getTenantCalendlyConnectionState(ctx, tenantId);
    if (!connection) {
      return null;
    }
    return { pkceVerifier: connection.pkceVerifier };
  },
});

export const clearPkceVerifier = internalMutation({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    await updateTenantCalendlyConnection(ctx, tenantId, {
      pkceVerifier: undefined,
    });
  },
});

export const storeConnectionTokens = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    accessToken: v.string(),
    refreshToken: v.string(),
    tokenExpiresAt: v.number(),
    organizationUri: v.optional(v.string()),
    userUri: v.optional(v.string()),
    refreshLockUntil: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await updateTenantCalendlyConnection(ctx, args.tenantId, {
      accessToken: args.accessToken,
      refreshToken: args.refreshToken,
      tokenExpiresAt: args.tokenExpiresAt,
      organizationUri: args.organizationUri,
      userUri: args.userUri,
      refreshLockUntil: args.refreshLockUntil ?? undefined,
      lastRefreshedAt: Date.now(),
      connectionStatus: "connected",
    });
  },
});

export const clearTenantConnection = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    status: v.union(
      v.literal("pending_calendly"),
      v.literal("calendly_disconnected"),
    ),
  },
  handler: async (ctx, { tenantId, status }) => {
    await updateTenantCalendlyConnection(ctx, tenantId, {
      pkceVerifier: undefined,
      accessToken: undefined,
      refreshToken: undefined,
      tokenExpiresAt: undefined,
      organizationUri: undefined,
      userUri: undefined,
      refreshLockUntil: undefined,
      lastRefreshedAt: undefined,
      webhookUri: undefined,
      webhookSecret: undefined,
      connectionStatus: "disconnected",
      lastHealthCheckAt: undefined,
      webhookProvisioningStartedAt: undefined,
    });
    await ctx.db.patch("tenants", tenantId, {
      status,
    });
  },
});
