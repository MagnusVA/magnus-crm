"use node";

import { v } from "convex/values";
import type { ActionCtx } from "../_generated/server";
import { action, internalAction, env } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { getIdentityOrgId } from "../lib/identity";
import { rejectRequest } from "../lib/observability/errors";
import {
  log,
  logRequestContext,
  reportError,
} from "../lib/observability/log";
import { ADMIN_ROLES } from "../lib/roleMapping";
import { getRawWorkosUserId } from "../lib/workosUserId";
import { requireIdentity } from "../requireIdentity";
import {
  calendlyHttpErrorMessage,
  readCalendlyErrorCode,
} from "./apiErrors";

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
/** Shorter than the 30s refresh lock, so a hung request can't outlive it. */
const TOKEN_REFRESH_TIMEOUT_MS = 20_000;

function getCalendlyClientId() {
  return env.CALENDLY_CLIENT_ID;
}

function getCalendlyClientSecret() {
  return env.CALENDLY_CLIENT_SECRET;
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

/**
 * One `calendly.token.refresh` line per refresh attempt. Successful refreshes
 * log at info; every other outcome logs at warn with its `reason`. Outcomes
 * that `reportError` already records return without this line.
 */
function logRefreshOutcome(
  tenantId: Id<"tenants">,
  startedAt: number,
  outcome: RefreshOutcome,
  attrs: Record<string, unknown> = {},
): RefreshOutcome {
  const durationMs = Date.now() - startedAt;
  if (outcome.refreshed) {
    log.info("calendly.token.refresh", {
      tenantId,
      outcome: "refreshed",
      durationMs,
      ...attrs,
    });
  } else {
    log.warn("calendly.token.refresh", {
      tenantId,
      outcome: outcome.reason,
      durationMs,
      ...attrs,
    });
  }
  return outcome;
}

/** The tenant was moved to `calendly_disconnected` and needs to reconnect. */
function reportDisconnected(
  tenantId: Id<"tenants">,
  startedAt: number,
  details:
    | { reason: "missing_refresh_token"; afterLock?: boolean }
    | { reason: "token_revoked"; httpStatus: number; errorCode?: string },
) {
  reportError(
    "calendly.token.disconnected",
    new Error(
      details.reason === "token_revoked"
        ? calendlyHttpErrorMessage(
            "token refresh",
            details.httpStatus,
            details.errorCode,
          )
        : "Calendly connection has no refresh token",
    ),
    {
      // A connected tenant with no refresh token is a data bug; a revoked
      // token is the tenant's to fix by reconnecting.
      severity: details.reason === "missing_refresh_token" ? "error" : "warning",
      integration: "calendly",
      fingerprint: "calendly.token.disconnected",
      tenantId,
      outcome: details.reason,
      durationMs: Date.now() - startedAt,
      ...details,
    },
  );
}

export async function refreshTenantTokenCore(
  ctx: ActionCtx,
  tenantId: Id<"tenants">,
): Promise<RefreshOutcome> {
  const startedAt = Date.now();

  const tenant = await getTenantTokenState(ctx, tenantId);
  if (!tenant) {
    return logRefreshOutcome(tenantId, startedAt, {
      refreshed: false,
      reason: "tenant_not_found",
    });
  }

  if (
    tenant.tenantStatus !== "active" &&
    tenant.tenantStatus !== "provisioning_webhooks"
  ) {
    return logRefreshOutcome(
      tenantId,
      startedAt,
      {
        refreshed: false,
        reason: "tenant_not_active",
        accessToken: tenant.accessToken,
      },
      { tenantStatus: tenant.tenantStatus },
    );
  }

  if (!tenant.refreshToken) {
    await ctx.runMutation(internal.tenants.updateStatus, {
      tenantId,
      status: "calendly_disconnected",
    });
    reportDisconnected(tenantId, startedAt, { reason: "missing_refresh_token" });
    return {
      refreshed: false,
      reason: "missing_refresh_token",
      accessToken: tenant.accessToken,
    };
  }

  const now = Date.now();
  if (tenant.refreshLockUntil && tenant.refreshLockUntil > now) {
    return logRefreshOutcome(
      tenantId,
      startedAt,
      {
        refreshed: false,
        reason: "lock_held",
        accessToken: tenant.accessToken,
      },
      { lockedForMs: tenant.refreshLockUntil - now },
    );
  }

  const lockResult: { acquired: boolean } = await ctx.runMutation(
    internal.calendly.tokenMutations.acquireTokenRefreshLock,
    {
      tenantId,
      lockUntil: now + 30_000,
    },
  );
  if (!lockResult.acquired) {
    return logRefreshOutcome(
      tenantId,
      startedAt,
      {
        refreshed: false,
        reason: "lock_held",
        accessToken: tenant.accessToken,
      },
      { lockRace: true },
    );
  }

  // Calendly refresh tokens are single-use: once Calendly answers with new
  // tokens, the stored refresh token is dead, so failing to store the new
  // ones disconnects the tenant.
  let issuedNewTokens = false;
  try {
    const lockedTenant = await getTenantTokenState(ctx, tenantId);
    if (!lockedTenant?.refreshToken) {
      await ctx.runMutation(internal.tenants.updateStatus, {
        tenantId,
        status: "calendly_disconnected",
      });
      await releaseRefreshLock(ctx, tenantId);
      reportDisconnected(tenantId, startedAt, {
        reason: "missing_refresh_token",
        afterLock: true,
      });
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
      signal: AbortSignal.timeout(TOKEN_REFRESH_TIMEOUT_MS),
    });

    if (response.status === 400 || response.status === 401) {
      const errorCode = await readCalendlyErrorCode(response);
      if (errorCode === "invalid_client") {
        // Our OAuth client credentials are wrong; the tenant's refresh token
        // is still good, so don't disconnect the tenant.
        await releaseRefreshLock(ctx, tenantId);
        reportError(
          "calendly.token.refresh_failed",
          new Error(
            calendlyHttpErrorMessage("token refresh", response.status, errorCode),
          ),
          {
            severity: "error",
            integration: "calendly",
            fingerprint: "calendly.token.refresh_failed:invalid_client",
            tenantId,
            httpStatus: response.status,
            errorCode,
            outcome: "api_error",
            durationMs: Date.now() - startedAt,
          },
        );
        return {
          refreshed: false,
          reason: "api_error",
          accessToken: lockedTenant.accessToken,
        };
      }

      // invalid_grant (or an unknown code): the refresh token is revoked.
      await ctx.runMutation(internal.tenants.updateStatus, {
        tenantId,
        status: "calendly_disconnected",
      });
      await releaseRefreshLock(ctx, tenantId);
      reportDisconnected(tenantId, startedAt, {
        reason: "token_revoked",
        httpStatus: response.status,
        errorCode,
      });
      return {
        refreshed: false,
        reason: "token_revoked",
        accessToken: lockedTenant.accessToken,
      };
    }

    if (response.status === 429) {
      // Retry-After may be an HTTP date rather than seconds; fall back to 60s.
      const retryAfterHeader = parseInt(
        response.headers.get("Retry-After") ?? "60",
        10,
      );
      const retryAfter = Number.isFinite(retryAfterHeader) ? retryAfterHeader : 60;
      await ctx.scheduler.runAfter(
        retryAfter * 1000,
        internal.calendly.tokens.refreshTenantToken,
        { tenantId },
      );
      await releaseRefreshLock(ctx, tenantId);
      return logRefreshOutcome(
        tenantId,
        startedAt,
        {
          refreshed: false,
          reason: "rate_limited_retry_scheduled",
        },
        { httpStatus: 429, retryAfterSeconds: retryAfter },
      );
    }

    if (!response.ok) {
      await releaseRefreshLock(ctx, tenantId);
      // 5xx is Calendly's problem and the stale token is still returned;
      // any other unexpected status points at our request.
      reportError(
        "calendly.token.refresh_failed",
        new Error(calendlyHttpErrorMessage("token refresh", response.status)),
        {
          severity: response.status >= 500 ? "warning" : "error",
          integration: "calendly",
          fingerprint: "calendly.token.refresh_failed",
          tenantId,
          httpStatus: response.status,
          outcome: "api_error",
          durationMs: Date.now() - startedAt,
        },
      );
      return {
        refreshed: false,
        reason: "api_error",
        accessToken: lockedTenant.accessToken,
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
    issuedNewTokens = true;

    const expiresAt = Date.now() + tokens.expires_in * 1000;
    await ctx.runMutation(internal.calendly.oauthMutations.storeConnectionTokens, {
      tenantId,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      tokenExpiresAt: expiresAt,
      organizationUri: lockedTenant.organizationUri,
      userUri: lockedTenant.userUri,
    });

    // Checked after storing: the old refresh token is already spent, so
    // dropping the new tokens here would disconnect the tenant.
    if (!lockedTenant.organizationUri || !lockedTenant.userUri) {
      reportError(
        "calendly.token.connection_incomplete",
        new Error("Calendly connection is missing its organization or user URI"),
        {
          severity: "error",
          integration: "calendly",
          fingerprint: "calendly.token.connection_incomplete",
          tenantId,
          hasOrganizationUri: Boolean(lockedTenant.organizationUri),
          hasUserUri: Boolean(lockedTenant.userUri),
        },
      );
    }

    return logRefreshOutcome(
      tenantId,
      startedAt,
      {
        refreshed: true,
        accessToken: tokens.access_token,
        expiresAt,
      },
      { expiresInSeconds: tokens.expires_in },
    );
  } catch (error) {
    if (issuedNewTokens) {
      // Calendly issued new tokens and spent the stored refresh token, but
      // the new tokens weren't saved. The tenant must reconnect.
      reportError("calendly.token.refresh_write_failed", error, {
        severity: "error",
        integration: "calendly",
        fingerprint: "calendly.token.refresh_write_failed",
        tenantId,
        outcome: "unexpected_error",
        durationMs: Date.now() - startedAt,
      });
    } else {
      // Rethrown, so the failed execution is reported on its own.
      log.error("calendly.token.refresh", {
        tenantId,
        outcome: "unexpected_error",
        durationMs: Date.now() - startedAt,
        errorName: error instanceof Error ? error.name : "Error",
      });
    }
    await releaseRefreshLock(ctx, tenantId);
    throw error;
  }
}

export async function getValidAccessToken(
  ctx: ActionCtx,
  tenantId: Id<"tenants">,
) {
  const tenant = await getTenantTokenState(ctx, tenantId);
  if (!tenant?.accessToken) {
    log.warn("calendly.token.unavailable", {
      tenantId,
      reason: tenant ? "no_access_token" : "tenant_not_found",
    });
    return null;
  }

  if (
    tenant.tenantStatus !== "active" &&
    tenant.tenantStatus !== "provisioning_webhooks"
  ) {
    log.warn("calendly.token.unavailable", {
      tenantId,
      reason: "tenant_not_active",
      tenantStatus: tenant.tenantStatus,
    });
    return null;
  }

  const now = Date.now();
  const expiresSoon =
    !tenant.tokenExpiresAt || tenant.tokenExpiresAt - now < 5 * 60 * 1000;

  if (!expiresSoon) {
    return tenant.accessToken;
  }

  const refreshed = await refreshTenantTokenCore(ctx, tenantId);
  if (refreshed.refreshed) {
    return refreshed.accessToken;
  }

  // refreshTenantTokenCore already logged the failed outcome and its reason.
  if (refreshed.reason === "lock_held" || refreshed.reason === "api_error") {
    return refreshed.accessToken ?? tenant.accessToken ?? null;
  }

  return null;
}

export const refreshTenantToken = internalAction({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    // refreshTenantTokenCore logs the outcome.
    return await refreshTenantTokenCore(ctx, tenantId);
  },
});

export const refreshMyTenantToken = action({
  args: {},
  handler: async (ctx): Promise<RefreshOutcome> => {
    const identity = await requireIdentity(ctx);

    const workosUserId = identity.tokenIdentifier ?? identity.subject;
    if (!workosUserId) {
      throw rejectRequest("auth.missing_workos_user_id", "Missing WorkOS user ID");
    }

    const currentUser: Doc<"users"> | null = await ctx.runQuery(
      internal.users.queries.getCurrentUserInternal,
      { workosUserId },
    );
    if (currentUser) {
      logRequestContext({
        distinctId: getRawWorkosUserId(workosUserId),
        tenantId: currentUser.tenantId,
        userId: currentUser._id,
        role: currentUser.role,
      });
    }
    if (!currentUser || !ADMIN_ROLES.includes(currentUser.role)) {
      throw rejectRequest("auth.insufficient_permissions", "Insufficient permissions", {
        userFound: currentUser !== null,
        role: currentUser?.role,
      });
    }

    const tenant = await ctx.runQuery(internal.tenants.getCalendlyTenant, {
      tenantId: currentUser.tenantId,
    });
    if (!tenant) {
      throw new Error("Tenant not found");
    }

    const identityOrgId = getIdentityOrgId(identity);
    if (!identityOrgId || identityOrgId !== tenant.workosOrgId) {
      throw rejectRequest("auth.organization_mismatch", "Organization mismatch", {
        tenantId: currentUser.tenantId,
        hasIdentityOrgId: Boolean(identityOrgId),
      });
    }

    return await refreshTenantTokenCore(ctx, currentUser.tenantId);
  },
});

export const refreshAllTokens = internalAction({
  args: {},
  handler: async (ctx) => {
    const startedAt = Date.now();
    const tenantIds: Array<Id<"tenants">> = await ctx.runQuery(
      internal.calendly.tokenMutations.listActiveTenantIds,
      {},
    );

    for (let i = 0; i < tenantIds.length; i += 1) {
      const delayMs = i * TOKEN_REFRESH_STAGGER_MS;
      await ctx.scheduler.runAfter(
        delayMs,
        internal.calendly.tokens.refreshTenantToken,
        { tenantId: tenantIds[i] },
      );
    }

    log.info("calendly.token.refresh_cron", {
      tenantCount: tenantIds.length,
      staggerMs: TOKEN_REFRESH_STAGGER_MS,
      durationMs: Date.now() - startedAt,
    });
  },
});
