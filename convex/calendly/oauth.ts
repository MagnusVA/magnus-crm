"use node";

import { randomBytes, createHash } from "crypto";
import { v } from "convex/values";
import { action, env } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { getIdentityOrgId } from "../lib/identity";
import { isExpectedError, rejectRequest } from "../lib/observability/errors";
import {
  log,
  logRequestContext,
  reportError,
} from "../lib/observability/log";
import {
  getCanonicalIdentityWorkosUserId,
  getRawWorkosUserId,
} from "../lib/workosUserId";
import { requireIdentity } from "../requireIdentity";
import {
  CALENDLY_FETCH_TIMEOUT_MS,
  calendlyHttpErrorMessage,
  readCalendlyErrorCode,
} from "./apiErrors";
import { provisionWebhookSubscription } from "./webhookSetup";

type CalendlyTokenRevocationStatus =
  | "revoked"
  | "not_present"
  | "already_invalid"
  | "failed";

function getCalendlyClientId() {
  return env.CALENDLY_CLIENT_ID;
}

function getCalendlyClientSecret() {
  return env.CALENDLY_CLIENT_SECRET;
}

/** Raw WorkOS user id (`user_…`) for `logRequestContext`. */
function getDistinctId(identity: Parameters<typeof getCanonicalIdentityWorkosUserId>[0]) {
  const workosUserId = getCanonicalIdentityWorkosUserId(identity);
  return workosUserId ? getRawWorkosUserId(workosUserId) : undefined;
}


function getCalendlyRedirectUri() {
  return `${env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}/callback/calendly`;
}

async function revokeCalendlyToken(
  token: string | undefined,
  context: { tenantId: Id<"tenants">; tokenKind: "access" | "refresh" },
): Promise<CalendlyTokenRevocationStatus> {
  if (!token) {
    return "not_present";
  }

  const clientId = getCalendlyClientId();
  const clientSecret = getCalendlyClientSecret();
  if (!clientId || !clientSecret) {
    throw new Error("Missing Calendly OAuth configuration");
  }

  try {
    const response = await fetch("https://auth.calendly.com/oauth/revoke", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        token,
      }).toString(),
      signal: AbortSignal.timeout(CALENDLY_FETCH_TIMEOUT_MS),
    });

    if (response.ok) {
      return "revoked";
    }

    if (response.status === 400 || response.status === 403) {
      return "already_invalid";
    }

    reportError(
      "calendly.oauth.revoke_failed",
      new Error(calendlyHttpErrorMessage("token revocation", response.status)),
      {
        severity: "warning",
        integration: "calendly",
        fingerprint: "calendly.oauth.revoke_failed",
        ...context,
        httpStatus: response.status,
      },
    );
    return "failed";
  } catch (error) {
    reportError("calendly.oauth.revoke_failed", error, {
      severity: "warning",
      integration: "calendly",
      fingerprint: "calendly.oauth.revoke_failed",
      ...context,
    });
    return "failed";
  }
}

export const startOAuth = action({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    const identity = await requireIdentity(ctx);
    logRequestContext({ distinctId: getDistinctId(identity) });

    const tenant = await ctx.runQuery(internal.tenants.getCalendlyTenant, {
      tenantId,
    });
    if (!tenant) {
      log.warn("calendly.oauth.rejected", {
        reason: "tenant_not_found",
        flow: "start",
        tenantId,
      });
      throw new Error("Tenant not found");
    }

    const identityOrgId = getIdentityOrgId(identity);
    if (!identityOrgId || identityOrgId !== tenant.workosOrgId) {
      throw rejectRequest("auth.organization_mismatch", "Not authorized", {
        flow: "start",
        tenantId,
        identityOrgId,
        tenantOrgId: tenant.workosOrgId,
      });
    }
    logRequestContext({ tenantId, workosOrgId: tenant.workosOrgId });

    if (
      tenant.status !== "pending_calendly" &&
      tenant.status !== "calendly_disconnected"
    ) {
      throw rejectRequest(
        "calendly.tenant_not_ready",
        "Tenant is not ready to connect Calendly",
        { flow: "start", tenantId, tenantStatus: tenant.status },
      );
    }

    const pkceVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256")
      .update(pkceVerifier)
      .digest("base64url");

    await ctx.runMutation(internal.calendly.oauthMutations.storePkceVerifier, {
      tenantId,
      pkceVerifier,
    });

    const clientId = getCalendlyClientId();
    if (!clientId) {
      throw new Error("Missing CALENDLY_CLIENT_ID");
    }

    const scopes = [
      "availability:read",
      "scheduled_events:write",
      "scheduled_events:read",
      "scheduling_links:write",
      "event_types:read",
      "users:read",
      "organizations:read",
      "webhooks:read",
      "webhooks:write",
      "routing_forms:read",
    ].join(" ");

    const params = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: getCalendlyRedirectUri(),
      code_challenge_method: "S256",
      code_challenge: codeChallenge,
      scope: scopes,
    });

    log.info("calendly.oauth.started", {
      tenantId,
      tenantStatus: tenant.status,
    });

    return {
      authorizeUrl: `https://auth.calendly.com/oauth/authorize?${params.toString()}`,
    };
  },
});

export const prepareReconnect = action({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    const identity = await requireIdentity(ctx);

    const workosUserId = getCanonicalIdentityWorkosUserId(identity);
    if (!workosUserId) {
      throw rejectRequest("auth.missing_workos_user_id", "Missing WorkOS user ID", {
        flow: "reconnect",
      });
    }

    const currentUser = await ctx.runQuery(
      internal.users.queries.getCurrentUserInternal,
      { workosUserId },
    );
    logRequestContext({
      distinctId: getRawWorkosUserId(workosUserId),
      tenantId: currentUser?.tenantId,
      userId: currentUser?._id,
      role: currentUser?.role,
    });
    if (
      !currentUser ||
      currentUser.tenantId !== tenantId ||
      (currentUser.role !== "tenant_master" &&
        currentUser.role !== "tenant_admin")
    ) {
      throw rejectRequest("auth.insufficient_permissions", "Insufficient permissions", {
        flow: "reconnect",
        tenantId,
        userTenantId: currentUser?.tenantId ?? null,
        role: currentUser?.role ?? null,
      });
    }

    const tenant = await ctx.runQuery(
      internal.calendly.connectionQueries.getTenantConnectionContext,
      { tenantId },
    );
    if (!tenant) {
      log.warn("calendly.oauth.rejected", {
        reason: "tenant_not_found",
        flow: "reconnect",
        tenantId,
      });
      throw new Error("Tenant not found");
    }

    const identityOrgId = getIdentityOrgId(identity);
    if (!identityOrgId || identityOrgId !== tenant.workosOrgId) {
      throw rejectRequest("auth.organization_mismatch", "Not authorized", {
        flow: "reconnect",
        tenantId,
        identityOrgId,
        tenantOrgId: tenant.workosOrgId,
      });
    }
    logRequestContext({ workosOrgId: tenant.workosOrgId });

    const accessToken = await revokeCalendlyToken(tenant.accessToken, {
      tenantId,
      tokenKind: "access",
    });
    const refreshToken = await revokeCalendlyToken(tenant.refreshToken, {
      tenantId,
      tokenKind: "refresh",
    });

    await ctx.runMutation(internal.calendly.oauthMutations.clearTenantConnection, {
      tenantId,
      status: "calendly_disconnected",
    });

    // Revocation statuses only (`revoked`, `failed`, ...), never the tokens.
    log.info("calendly.oauth.reconnect_prepared", {
      tenantId,
      accessTokenRevocation: accessToken,
      refreshTokenRevocation: refreshToken,
    });

    return {
      accessToken,
      refreshToken,
    };
  },
});

export const exchangeCodeAndProvision = action({
  args: {
    tenantId: v.id("tenants"),
    code: v.string(),
    convexSiteUrl: v.string(),
  },
  handler: async (ctx, { tenantId, code, convexSiteUrl }) => {
    // Authorize before the try block so a rejected caller can't trigger the
    // rollback below, which clears the PKCE verifier and resets the status.
    const identity = await requireIdentity(ctx);
    logRequestContext({ distinctId: getDistinctId(identity) });

    const tenant = await ctx.runQuery(internal.tenants.getCalendlyTenant, {
      tenantId,
    });
    if (!tenant) {
      log.warn("calendly.oauth.rejected", {
        reason: "tenant_not_found",
        flow: "exchange",
        tenantId,
      });
      throw new Error("Tenant not found");
    }

    const identityOrgId = getIdentityOrgId(identity);
    if (!identityOrgId || identityOrgId !== tenant.workosOrgId) {
      throw rejectRequest("auth.organization_mismatch", "Not authorized", {
        flow: "exchange",
        tenantId,
        identityOrgId,
        tenantOrgId: tenant.workosOrgId,
      });
    }
    logRequestContext({ tenantId, workosOrgId: tenant.workosOrgId });

    // Also before the try: an expired or reused callback link must not run
    // the rollback, which would reset an already-active tenant to onboarding.
    const tenantData = await ctx.runQuery(
      internal.calendly.oauthMutations.getPkceVerifier,
      { tenantId },
    );
    if (!tenantData?.pkceVerifier) {
      throw rejectRequest(
        "calendly.oauth_flow_expired",
        "No PKCE verifier found — OAuth flow may have expired",
        { flow: "exchange", tenantId },
      );
    }

    const rollbackStatus: "pending_calendly" | "calendly_disconnected" =
      tenant.status === "calendly_disconnected"
        ? "calendly_disconnected"
        : "pending_calendly";

    const startedAt = Date.now();
    // The step in progress, so a rollback says where the flow broke.
    let step:
      | "token_exchange"
      | "verify_user"
      | "store_tokens"
      | "provision_webhook"
      | "activate_tenant"
      | "finish" = "token_exchange";

    try {
      const clientId = getCalendlyClientId();
      const clientSecret = env.CALENDLY_CLIENT_SECRET;
      if (!clientId || !clientSecret) {
        log.error("calendly.oauth.config_missing", {
          tenantId,
          hasClientId: Boolean(clientId),
          hasClientSecret: Boolean(clientSecret),
        });
        throw new Error("Missing Calendly OAuth configuration");
      }

      step = "token_exchange";
      const tokenResponse = await fetch("https://auth.calendly.com/oauth/token", {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: getCalendlyRedirectUri(),
          code_verifier: tenantData.pkceVerifier,
        }).toString(),
        signal: AbortSignal.timeout(CALENDLY_FETCH_TIMEOUT_MS),
      });

      if (!tokenResponse.ok) {
        throw new Error(
          calendlyHttpErrorMessage(
            "token exchange",
            tokenResponse.status,
            await readCalendlyErrorCode(tokenResponse),
          ),
        );
      }

      const tokens = (await tokenResponse.json()) as {
        access_token: string;
        refresh_token: string;
        expires_in: number;
        owner: string;
        organization: string;
      };

      step = "verify_user";
      const meResponse = await fetch("https://api.calendly.com/users/me", {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
        signal: AbortSignal.timeout(CALENDLY_FETCH_TIMEOUT_MS),
      });
      if (!meResponse.ok) {
        throw new Error(calendlyHttpErrorMessage("users/me", meResponse.status));
      }

      const meData = (await meResponse.json()) as {
        resource?: {
          uri?: string;
          current_organization?: string;
        };
      };
      const organizationUri =
        tokens.organization ?? meData.resource?.current_organization;
      const userUri = tokens.owner ?? meData.resource?.uri;
      if (!organizationUri || !userUri) {
        log.warn("calendly.oauth.exchange_step_failed", {
          tenantId,
          step,
          reason: "missing_owner_or_org_uri",
          hasOrganizationUri: Boolean(organizationUri),
          hasUserUri: Boolean(userUri),
        });
        throw new Error(
          "Calendly token response did not include owner or organization",
        );
      }

      step = "store_tokens";
      const expiresAt = Date.now() + tokens.expires_in * 1000;
      await ctx.runMutation(internal.calendly.oauthMutations.storeConnectionTokens, {
        tenantId,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        tokenExpiresAt: expiresAt,
        organizationUri,
        userUri,
      });

      await ctx.runMutation(internal.tenants.updateStatus, {
        tenantId,
        status: "provisioning_webhooks",
      });
      log.info("calendly.oauth.tokens_stored", {
        tenantId,
        expiresInSeconds: tokens.expires_in,
      });

      const tenantAfterTokenStore = await ctx.runQuery(
        internal.calendly.connectionQueries.getTenantConnectionContext,
        { tenantId },
      );
      if (!tenantAfterTokenStore?.organizationUri) {
        throw new Error("Calendly organization URI was not stored");
      }

      step = "provision_webhook";
      const { webhookUri, signingSecret } = await provisionWebhookSubscription({
        tenantId,
        accessToken: tokens.access_token,
        organizationUri,
        convexSiteUrl,
        signingSecret: tenantAfterTokenStore.webhookSecret ?? undefined,
      });

      step = "activate_tenant";
      await ctx.runMutation(
        internal.calendly.webhookSetupMutations.storeWebhookAndActivate,
        {
          tenantId,
          webhookUri,
          webhookSecret: signingSecret,
        },
      );

      step = "finish";
      await ctx.scheduler.runAfter(0, internal.calendly.orgMembers.syncForTenant, {
        tenantId,
      });
      // Event type metadata sync is manual-only for the MVP.

      await ctx.runMutation(internal.calendly.oauthMutations.clearPkceVerifier, {
        tenantId,
      });

      log.info("calendly.oauth.connected", {
        tenantId,
        reconnect: rollbackStatus === "calendly_disconnected",
        reusedWebhookSecret: Boolean(tenantAfterTokenStore.webhookSecret),
        durationMs: Date.now() - startedAt,
      });

      return { success: true };
    } catch (error) {
      // An expired flow is the caller's to retry; rejectRequest logged it.
      if (!isExpectedError(error)) {
        reportError("calendly.oauth.exchange_failed", error, {
          integration: "calendly",
          fingerprint: `calendly.oauth.exchange_failed:${step}`,
          tenantId,
          failedStep: step,
          rollbackStatus,
          durationMs: Date.now() - startedAt,
        });
      }

      // Each rollback step reports its own failure, so it can't mask the
      // original error rethrown below.
      const reportRollbackFailure = (
        rollbackStep: "clear_pkce_verifier" | "reset_status",
        rollbackError: unknown,
      ) =>
        reportError("calendly.oauth.rollback_failed", rollbackError, {
          severity: "error",
          integration: "calendly",
          fingerprint: "calendly.oauth.rollback_failed",
          tenantId,
          failedStep: step,
          rollbackStep,
          rollbackStatus,
        });
      try {
        await ctx.runMutation(internal.calendly.oauthMutations.clearPkceVerifier, {
          tenantId,
        });
      } catch (rollbackError) {
        reportRollbackFailure("clear_pkce_verifier", rollbackError);
      }
      try {
        await ctx.runMutation(internal.tenants.updateStatus, {
          tenantId,
          status: rollbackStatus,
        });
      } catch (rollbackError) {
        reportRollbackFailure("reset_status", rollbackError);
      }
      throw error;
    }
  },
});
