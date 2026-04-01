"use node";

import { v } from "convex/values";
import type { ActionCtx } from "../_generated/server";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

type TenantTokenState = {
  calendlyAccessToken?: string;
  calendlyRefreshToken?: string;
  calendlyTokenExpiresAt?: number;
  calendlyRefreshLockUntil?: number;
  calendlyOrgUri?: string;
  calendlyOwnerUri?: string;
  status: string;
};

type RefreshOutcome =
  | {
      refreshed: true;
      accessToken: string;
      expiresAt: number;
    }
  | {
      refreshed: false;
      reason:
        | "tenant_not_found"
        | "tenant_not_active"
        | "missing_refresh_token"
        | "lock_held"
        | "token_revoked"
        | "api_error";
      accessToken?: string;
    };

function getCalendlyClientId() {
  return (
    process.env.CALENDLY_CLIENT_ID ?? process.env.NEXT_PUBLIC_CALENDLY_CLIENT_ID
  );
}

function getCalendlyClientSecret() {
  return process.env.CALENDLY_CLIENT_SECRET;
}

async function releaseRefreshLock(ctx: ActionCtx, tenantId: Id<"tenants">) {
  await ctx.runMutation(internal.calendly.tokenMutations.releaseRefreshLock, {
    tenantId,
  });
}

async function getTenantTokenState(
  ctx: ActionCtx,
  tenantId: Id<"tenants">,
): Promise<TenantTokenState | null> {
  const tenant = await ctx.runQuery(internal.tenants.getCalendlyTokens, {
    tenantId,
  });

  return tenant as TenantTokenState | null;
}

export async function refreshTenantTokenCore(
  ctx: ActionCtx,
  tenantId: Id<"tenants">,
): Promise<RefreshOutcome> {
  const tenant = await getTenantTokenState(ctx, tenantId);
  if (!tenant) {
    return { refreshed: false, reason: "tenant_not_found" };
  }

  if (tenant.status !== "active" && tenant.status !== "provisioning_webhooks") {
    return {
      refreshed: false,
      reason: "tenant_not_active",
      accessToken: tenant.calendlyAccessToken,
    };
  }

  if (!tenant.calendlyRefreshToken) {
    await ctx.runMutation(internal.tenants.updateStatus, {
      tenantId,
      status: "calendly_disconnected",
    });
    return {
      refreshed: false,
      reason: "missing_refresh_token",
      accessToken: tenant.calendlyAccessToken,
    };
  }

  const now = Date.now();
  if (
    tenant.calendlyRefreshLockUntil &&
    tenant.calendlyRefreshLockUntil > now
  ) {
    return {
      refreshed: false,
      reason: "lock_held",
      accessToken: tenant.calendlyAccessToken,
    };
  }

  const lockResult: { acquired: boolean } = await ctx.runMutation(
    internal.calendly.tokenMutations.acquireRefreshLock,
    {
      tenantId,
      lockUntil: now + 30_000,
    },
  );
  if (!lockResult.acquired) {
    return {
      refreshed: false,
      reason: "lock_held",
      accessToken: tenant.calendlyAccessToken,
    };
  }

  try {
    const lockedTenant = await getTenantTokenState(ctx, tenantId);
    if (!lockedTenant?.calendlyRefreshToken) {
      await ctx.runMutation(internal.tenants.updateStatus, {
        tenantId,
        status: "calendly_disconnected",
      });
      await releaseRefreshLock(ctx, tenantId);
      return {
        refreshed: false,
        reason: "missing_refresh_token",
        accessToken: lockedTenant?.calendlyAccessToken,
      };
    }

    const clientId = getCalendlyClientId();
    const clientSecret = getCalendlyClientSecret();
    if (!clientId || !clientSecret) {
      throw new Error("Missing Calendly OAuth configuration");
    }

    const response = await fetch("https://auth.calendly.com/oauth/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: lockedTenant.calendlyRefreshToken,
      }).toString(),
    });

    if (response.status === 400 || response.status === 401) {
      await ctx.runMutation(internal.tenants.updateStatus, {
        tenantId,
        status: "calendly_disconnected",
      });
      await releaseRefreshLock(ctx, tenantId);
      return {
        refreshed: false,
        reason: "token_revoked",
        accessToken: lockedTenant.calendlyAccessToken,
      };
    }

    if (!response.ok) {
      await releaseRefreshLock(ctx, tenantId);
      return {
        refreshed: false,
        reason: "api_error",
        accessToken: lockedTenant.calendlyAccessToken,
      };
    }

    const tokens = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };

    if (
      typeof tokens.access_token !== "string" ||
      typeof tokens.refresh_token !== "string" ||
      typeof tokens.expires_in !== "number"
    ) {
      throw new Error("Calendly refresh response was missing token fields");
    }

    if (!lockedTenant.calendlyOrgUri || !lockedTenant.calendlyOwnerUri) {
      throw new Error("Calendly tenant is missing org or owner URIs");
    }

    const expiresAt = Date.now() + tokens.expires_in * 1000;
    await ctx.runMutation(internal.tenants.storeCalendlyTokens, {
      tenantId,
      calendlyAccessToken: tokens.access_token,
      calendlyRefreshToken: tokens.refresh_token,
      calendlyTokenExpiresAt: expiresAt,
      calendlyOrgUri: lockedTenant.calendlyOrgUri,
      calendlyOwnerUri: lockedTenant.calendlyOwnerUri,
    });

    return {
      refreshed: true,
      accessToken: tokens.access_token,
      expiresAt,
    };
  } catch (error) {
    await releaseRefreshLock(ctx, tenantId);
    throw error;
  }
}

export async function getValidAccessToken(
  ctx: ActionCtx,
  tenantId: Id<"tenants">,
) {
  const tenant = await getTenantTokenState(ctx, tenantId);
  if (!tenant?.calendlyAccessToken) {
    return null;
  }

  if (tenant.status !== "active" && tenant.status !== "provisioning_webhooks") {
    return null;
  }

  const now = Date.now();
  const expiresSoon =
    !tenant.calendlyTokenExpiresAt ||
    tenant.calendlyTokenExpiresAt - now < 5 * 60 * 1000;

  if (!expiresSoon) {
    return tenant.calendlyAccessToken;
  }

  const refreshed = await refreshTenantTokenCore(ctx, tenantId);
  if (refreshed.refreshed) {
    return refreshed.accessToken;
  }

  if (refreshed.reason === "lock_held" || refreshed.reason === "api_error") {
    return refreshed.accessToken ?? tenant.calendlyAccessToken ?? null;
  }

  return null;
}

/**
 * Refresh a single tenant's Calendly access token.
 */
export const refreshTenantToken = internalAction({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    return await refreshTenantTokenCore(ctx, tenantId);
  },
});

/**
 * Cron job: refresh tokens for all active tenants.
 */
export const refreshAllTokens = internalAction({
  args: {},
  handler: async (ctx) => {
    const tenantIds: Array<Id<"tenants">> = await ctx.runQuery(
      internal.calendly.tokenMutations.listActiveTenantIds,
      {},
    );

    for (const tenantId of tenantIds) {
      try {
        const result = await refreshTenantTokenCore(ctx, tenantId);
        if (result.refreshed) {
          console.log(`Refreshed Calendly token for tenant ${tenantId}`);
        } else {
          console.log(`Skipped Calendly token refresh for tenant ${tenantId}: ${result.reason}`);
        }
      } catch (error) {
        console.error(`Failed to refresh Calendly token for tenant ${tenantId}:`, error);
      }
    }
  },
});
