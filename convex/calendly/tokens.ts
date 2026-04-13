"use node";

import { v } from "convex/values";
import type { ActionCtx } from "../_generated/server";
import { action, internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { getIdentityOrgId } from "../lib/identity";
import { ADMIN_ROLES } from "../lib/roleMapping";

type TenantConnectionContext = {
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: number;
  refreshLockUntil?: number;
  organizationUri?: string;
  userUri?: string;
  tenantStatus: string;
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
        | "api_error"
        | "rate_limited_retry_scheduled";
      accessToken?: string;
    };

const TOKEN_REFRESH_STAGGER_MS = 100;

function getCalendlyClientId() {
  return (
    process.env.CALENDLY_CLIENT_ID ?? process.env.NEXT_PUBLIC_CALENDLY_CLIENT_ID
  );
}

function getCalendlyClientSecret() {
  return process.env.CALENDLY_CLIENT_SECRET;
}

async function releaseRefreshLock(ctx: ActionCtx, tenantId: Id<"tenants">) {
  await ctx.runMutation(
    internal.calendly.tokenMutations.releaseTokenRefreshLock,
    { tenantId },
  );
}

async function getTenantTokenState(
  ctx: ActionCtx,
  tenantId: Id<"tenants">,
): Promise<TenantConnectionContext | null> {
  return (await ctx.runQuery(
    internal.calendly.connectionQueries.getTenantConnectionContext,
    { tenantId },
  )) as TenantConnectionContext | null;
}

export async function refreshTenantTokenCore(
  ctx: ActionCtx,
  tenantId: Id<"tenants">,
): Promise<RefreshOutcome> {
  console.log(
    `[token-refresh] refreshTenantTokenCore: entry for tenant ${tenantId}`,
  );

  const tenant = await getTenantTokenState(ctx, tenantId);
  if (!tenant) {
    console.warn(
      `[token-refresh] refreshTenantTokenCore: tenant ${tenantId} not found`,
    );
    return { refreshed: false, reason: "tenant_not_found" };
  }

  if (
    tenant.tenantStatus !== "active" &&
    tenant.tenantStatus !== "provisioning_webhooks"
  ) {
    console.warn(
      `[token-refresh] refreshTenantTokenCore: tenant ${tenantId} not active, status=${tenant.tenantStatus}`,
    );
    return {
      refreshed: false,
      reason: "tenant_not_active",
      accessToken: tenant.accessToken,
    };
  }

  if (!tenant.refreshToken) {
    console.warn(
      `[token-refresh] refreshTenantTokenCore: tenant ${tenantId} missing refresh token, disconnecting`,
    );
    await ctx.runMutation(internal.tenants.updateStatus, {
      tenantId,
      status: "calendly_disconnected",
    });
    return {
      refreshed: false,
      reason: "missing_refresh_token",
      accessToken: tenant.accessToken,
    };
  }

  const now = Date.now();
  if (tenant.refreshLockUntil && tenant.refreshLockUntil > now) {
    console.warn(
      `[token-refresh] refreshTenantTokenCore: tenant ${tenantId} lock held until ${new Date(tenant.refreshLockUntil).toISOString()}`,
    );
    return {
      refreshed: false,
      reason: "lock_held",
      accessToken: tenant.accessToken,
    };
  }

  console.log(
    `[token-refresh] refreshTenantTokenCore: acquiring lock for tenant ${tenantId}`,
  );
  const lockResult: { acquired: boolean } = await ctx.runMutation(
    internal.calendly.tokenMutations.acquireTokenRefreshLock,
    {
      tenantId,
      lockUntil: now + 30_000,
    },
  );
  if (!lockResult.acquired) {
    console.warn(
      `[token-refresh] refreshTenantTokenCore: failed to acquire lock for tenant ${tenantId}`,
    );
    return {
      refreshed: false,
      reason: "lock_held",
      accessToken: tenant.accessToken,
    };
  }
  console.log(
    `[token-refresh] refreshTenantTokenCore: lock acquired for tenant ${tenantId}`,
  );

  try {
    const lockedTenant = await getTenantTokenState(ctx, tenantId);
    if (!lockedTenant?.refreshToken) {
      console.warn(
        `[token-refresh] refreshTenantTokenCore: tenant ${tenantId} refresh token gone after lock`,
      );
      await ctx.runMutation(internal.tenants.updateStatus, {
        tenantId,
        status: "calendly_disconnected",
      });
      await releaseRefreshLock(ctx, tenantId);
      return {
        refreshed: false,
        reason: "missing_refresh_token",
        accessToken: lockedTenant?.accessToken,
      };
    }

    const clientId = getCalendlyClientId();
    const clientSecret = getCalendlyClientSecret();
    if (!clientId || !clientSecret) {
      throw new Error("Missing Calendly OAuth configuration");
    }

    console.log(
      `[token-refresh] refreshTenantTokenCore: sending refresh request for tenant ${tenantId}`,
    );
    const response = await fetch("https://auth.calendly.com/oauth/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: lockedTenant.refreshToken,
      }).toString(),
    });

    if (response.status === 400 || response.status === 401) {
      console.error(
        `[token-refresh] refreshTenantTokenCore: tenant ${tenantId} token revoked (${response.status}), disconnecting`,
      );
      await ctx.runMutation(internal.tenants.updateStatus, {
        tenantId,
        status: "calendly_disconnected",
      });
      await releaseRefreshLock(ctx, tenantId);
      return {
        refreshed: false,
        reason: "token_revoked",
        accessToken: lockedTenant.accessToken,
      };
    }

    if (response.status === 429) {
      const retryAfter = parseInt(
        response.headers.get("Retry-After") ?? "60",
        10,
      );
      console.warn(
        `[token-refresh] refreshTenantTokenCore: tenant ${tenantId} rate limited, scheduling retry in ${retryAfter}s`,
      );
      await ctx.scheduler.runAfter(
        retryAfter * 1000,
        internal.calendly.tokens.refreshTenantToken,
        { tenantId },
      );
      await releaseRefreshLock(ctx, tenantId);
      return {
        refreshed: false,
        reason: "rate_limited_retry_scheduled",
      };
    }

    if (!response.ok) {
      console.error(
        `[token-refresh] refreshTenantTokenCore: tenant ${tenantId} API error, status=${response.status}`,
      );
      await releaseRefreshLock(ctx, tenantId);
      return {
        refreshed: false,
        reason: "api_error",
        accessToken: lockedTenant.accessToken,
      };
    }

    console.log(
      `[token-refresh] refreshTenantTokenCore: tenant ${tenantId} refresh response OK`,
    );

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

    if (!lockedTenant.organizationUri || !lockedTenant.userUri) {
      throw new Error("Calendly tenant is missing org or owner URIs");
    }

    const expiresAt = Date.now() + tokens.expires_in * 1000;
    await ctx.runMutation(internal.calendly.oauthMutations.storeConnectionTokens, {
      tenantId,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      tokenExpiresAt: expiresAt,
      organizationUri: lockedTenant.organizationUri,
      userUri: lockedTenant.userUri,
    });
    console.log(
      `[token-refresh] refreshTenantTokenCore: tenant ${tenantId} tokens stored, expiresAt=${new Date(expiresAt).toISOString()}`,
    );

    return {
      refreshed: true,
      accessToken: tokens.access_token,
      expiresAt,
    };
  } catch (error) {
    console.error(
      `[token-refresh] refreshTenantTokenCore: tenant ${tenantId} unexpected error, releasing lock`,
      error instanceof Error ? error.message : error,
    );
    await releaseRefreshLock(ctx, tenantId);
    throw error;
  }
}

export async function getValidAccessToken(
  ctx: ActionCtx,
  tenantId: Id<"tenants">,
) {
  console.log(`[token-refresh] getValidAccessToken: entry for tenant ${tenantId}`);

  const tenant = await getTenantTokenState(ctx, tenantId);
  if (!tenant?.accessToken) {
    console.warn(
      `[token-refresh] getValidAccessToken: tenant ${tenantId} has no access token`,
    );
    return null;
  }

  if (
    tenant.tenantStatus !== "active" &&
    tenant.tenantStatus !== "provisioning_webhooks"
  ) {
    console.warn(
      `[token-refresh] getValidAccessToken: tenant ${tenantId} not active, status=${tenant.tenantStatus}`,
    );
    return null;
  }

  const now = Date.now();
  const expiresSoon =
    !tenant.tokenExpiresAt || tenant.tokenExpiresAt - now < 5 * 60 * 1000;

  console.log(
    `[token-refresh] getValidAccessToken: tenant ${tenantId}, hasExpiry=${Boolean(tenant.tokenExpiresAt)}, expiresSoon=${expiresSoon}, expiresIn=${tenant.tokenExpiresAt ? Math.round((tenant.tokenExpiresAt - now) / 1000) : "N/A"}s`,
  );

  if (!expiresSoon) {
    console.log(
      `[token-refresh] getValidAccessToken: tenant ${tenantId} token still valid, returning cached`,
    );
    return tenant.accessToken;
  }

  console.log(
    `[token-refresh] getValidAccessToken: tenant ${tenantId} token expiring soon, refreshing`,
  );
  const refreshed = await refreshTenantTokenCore(ctx, tenantId);
  if (refreshed.refreshed) {
    console.log(
      `[token-refresh] getValidAccessToken: tenant ${tenantId} token refreshed successfully`,
    );
    return refreshed.accessToken;
  }

  console.warn(
    `[token-refresh] getValidAccessToken: tenant ${tenantId} refresh failed, reason=${refreshed.reason}`,
  );
  if (refreshed.reason === "lock_held" || refreshed.reason === "api_error") {
    return refreshed.accessToken ?? tenant.accessToken ?? null;
  }

  return null;
}

export const refreshTenantToken = internalAction({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    console.log(
      `[token-refresh] refreshTenantToken: scheduled refresh for tenant ${tenantId}`,
    );
    const result = await refreshTenantTokenCore(ctx, tenantId);
    console.log(
      `[token-refresh] refreshTenantToken: tenant ${tenantId} result: refreshed=${result.refreshed}${!result.refreshed ? `, reason=${result.reason}` : ""}`,
    );
    return result;
  },
});

export const refreshMyTenantToken = action({
  args: {},
  handler: async (ctx): Promise<RefreshOutcome> => {
    console.log(`[token-refresh] refreshMyTenantToken: called`);

    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Not authenticated");
    }

    const workosUserId = identity.tokenIdentifier ?? identity.subject;
    if (!workosUserId) {
      throw new Error("Missing WorkOS user ID");
    }

    const currentUser: Doc<"users"> | null = await ctx.runQuery(
      internal.users.queries.getCurrentUserInternal,
      { workosUserId },
    );
    if (!currentUser || !ADMIN_ROLES.includes(currentUser.role)) {
      throw new Error("Insufficient permissions");
    }

    console.log(
      `[token-refresh] refreshMyTenantToken: user=${currentUser._id}, role=${currentUser.role}, tenant=${currentUser.tenantId}`,
    );

    const tenant = await ctx.runQuery(internal.tenants.getCalendlyTenant, {
      tenantId: currentUser.tenantId,
    });
    if (!tenant) {
      throw new Error("Tenant not found");
    }

    const identityOrgId = getIdentityOrgId(identity);
    if (!identityOrgId || identityOrgId !== tenant.workosOrgId) {
      throw new Error("Organization mismatch");
    }

    console.log(
      `[token-refresh] refreshMyTenantToken: invoking refreshTenantTokenCore for tenant ${currentUser.tenantId}`,
    );
    return await refreshTenantTokenCore(ctx, currentUser.tenantId);
  },
});

export const refreshAllTokens = internalAction({
  args: {},
  handler: async (ctx) => {
    console.log(`[token-refresh] refreshAllTokens: entry`);

    const tenantIds: Array<Id<"tenants">> = await ctx.runQuery(
      internal.calendly.tokenMutations.listActiveTenantIds,
      {},
    );

    console.log(
      `[token-refresh] refreshAllTokens: scheduling refresh for ${tenantIds.length} tenants, stagger=${TOKEN_REFRESH_STAGGER_MS}ms`,
    );

    for (let i = 0; i < tenantIds.length; i += 1) {
      const delayMs = i * TOKEN_REFRESH_STAGGER_MS;
      console.log(
        `[token-refresh] refreshAllTokens: scheduling tenant ${tenantIds[i]} with delay=${delayMs}ms`,
      );
      await ctx.scheduler.runAfter(
        delayMs,
        internal.calendly.tokens.refreshTenantToken,
        { tenantId: tenantIds[i] },
      );
    }

    console.log(
      `[token-refresh] refreshAllTokens: all ${tenantIds.length} tenants scheduled`,
    );
  },
});
