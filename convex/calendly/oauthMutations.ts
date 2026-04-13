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
    console.log(
      `[Calendly:OAuth] storePkceVerifier: storing for tenant ${tenantId}`,
    );
    await updateTenantCalendlyConnection(ctx, tenantId, { pkceVerifier });
  },
});

export const getPkceVerifier = internalQuery({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    console.log(
      `[Calendly:OAuth] getPkceVerifier: retrieving for tenant ${tenantId}`,
    );
    const connection = await getTenantCalendlyConnectionState(ctx, tenantId);
    if (!connection) {
      console.warn(
        `[Calendly:OAuth] getPkceVerifier: tenant ${tenantId} not found`,
      );
      return null;
    }
    console.log(
      `[Calendly:OAuth] getPkceVerifier: hasVerifier=${Boolean(connection.pkceVerifier)}`,
    );
    return { pkceVerifier: connection.pkceVerifier };
  },
});

export const clearPkceVerifier = internalMutation({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    console.log(
      `[Calendly:OAuth] clearPkceVerifier: clearing for tenant ${tenantId}`,
    );
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
    console.log("[Calendly:OAuth] storeConnectionTokens called", {
      tenantId: args.tenantId,
      hasAccessToken: Boolean(args.accessToken),
      hasRefreshToken: Boolean(args.refreshToken),
      tokenExpiresAt: args.tokenExpiresAt,
      hasOrganizationUri: Boolean(args.organizationUri),
      hasUserUri: Boolean(args.userUri),
      hasRefreshLock: Boolean(args.refreshLockUntil),
    });

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

    console.log("[Calendly:OAuth] storeConnectionTokens completed", {
      tenantId: args.tenantId,
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
    console.log("[Calendly:OAuth] clearTenantConnection called", {
      tenantId,
      status,
    });

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
    });
    await ctx.db.patch(tenantId, {
      status,
      webhookProvisioningStartedAt: undefined,
    });

    console.log("[Calendly:OAuth] clearTenantConnection completed", {
      tenantId,
      status,
    });
  },
});
