"use node";

import { randomBytes, createHash } from "crypto";
import { v } from "convex/values";
import { action } from "../_generated/server";
import { internal } from "../_generated/api";
import { getIdentityOrgId } from "../lib/identity";
import { getCanonicalIdentityWorkosUserId } from "../lib/workosUserId";
import { provisionWebhookSubscription } from "./webhookSetup";

type CalendlyTokenRevocationStatus =
  | "revoked"
  | "not_present"
  | "already_invalid"
  | "failed";

function getCalendlyClientId() {
  return (
    process.env.CALENDLY_CLIENT_ID ?? process.env.NEXT_PUBLIC_CALENDLY_CLIENT_ID
  );
}

function getCalendlyClientSecret() {
  return process.env.CALENDLY_CLIENT_SECRET;
}

function getCalendlyRedirectUri() {
  return `${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}/callback/calendly`;
}

async function revokeCalendlyToken(
  token: string | undefined,
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
    });

    if (response.ok) {
      return "revoked";
    }

    if (response.status === 400 || response.status === 403) {
      return "already_invalid";
    }

    console.error("[Calendly:OAuth] token revocation failed", {
      status: response.status,
      body: await response.text(),
    });
    return "failed";
  } catch (error) {
    console.error("[Calendly:OAuth] token revocation request failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return "failed";
  }
}

export const startOAuth = action({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    console.log(`[Calendly:OAuth] startOAuth called for tenant ${tenantId}`);

    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      console.error(`[Calendly:OAuth] startOAuth: not authenticated`);
      throw new Error("Not authenticated");
    }

    const tenant = await ctx.runQuery(internal.tenants.getCalendlyTenant, {
      tenantId,
    });
    if (!tenant) {
      console.error(`[Calendly:OAuth] startOAuth: tenant ${tenantId} not found`);
      throw new Error("Tenant not found");
    }
    console.log(
      `[Calendly:OAuth] startOAuth: tenant found, status=${tenant.status}`,
    );

    const identityOrgId = getIdentityOrgId(identity);
    if (!identityOrgId || identityOrgId !== tenant.workosOrgId) {
      console.error(
        `[Calendly:OAuth] startOAuth: authorization failed, identityOrgId=${identityOrgId}, tenantOrgId=${tenant.workosOrgId}`,
      );
      throw new Error("Not authorized");
    }
    console.log(`[Calendly:OAuth] startOAuth: authorization check passed`);

    if (
      tenant.status !== "pending_calendly" &&
      tenant.status !== "calendly_disconnected"
    ) {
      console.error(
        `[Calendly:OAuth] startOAuth: tenant not ready, status=${tenant.status}`,
      );
      throw new Error("Tenant is not ready to connect Calendly");
    }

    const pkceVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256")
      .update(pkceVerifier)
      .digest("base64url");
    console.log(`[Calendly:OAuth] startOAuth: PKCE challenge generated`);

    await ctx.runMutation(internal.calendly.oauthMutations.storePkceVerifier, {
      tenantId,
      pkceVerifier,
    });
    console.log(`[Calendly:OAuth] startOAuth: PKCE verifier stored`);

    const clientId = getCalendlyClientId();
    if (!clientId) {
      console.error(`[Calendly:OAuth] startOAuth: missing CALENDLY_CLIENT_ID`);
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

    console.log(
      `[Calendly:OAuth] startOAuth: authorize URL built, redirectUri=${getCalendlyRedirectUri()}`,
    );

    return {
      authorizeUrl: `https://auth.calendly.com/oauth/authorize?${params.toString()}`,
    };
  },
});

export const prepareReconnect = action({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    console.log(
      `[Calendly:OAuth] prepareReconnect called for tenant ${tenantId}`,
    );

    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      console.error("[Calendly:OAuth] prepareReconnect: not authenticated");
      throw new Error("Not authenticated");
    }

    const workosUserId = getCanonicalIdentityWorkosUserId(identity);
    if (!workosUserId) {
      console.error("[Calendly:OAuth] prepareReconnect: missing WorkOS user ID");
      throw new Error("Missing WorkOS user ID");
    }

    const currentUser = await ctx.runQuery(
      internal.users.queries.getCurrentUserInternal,
      { workosUserId },
    );
    if (
      !currentUser ||
      currentUser.tenantId !== tenantId ||
      (currentUser.role !== "tenant_master" &&
        currentUser.role !== "tenant_admin")
    ) {
      console.error(
        "[Calendly:OAuth] prepareReconnect: insufficient permissions",
        {
          tenantId,
          userTenantId: currentUser?.tenantId ?? null,
          role: currentUser?.role ?? null,
        },
      );
      throw new Error("Insufficient permissions");
    }

    const tenant = await ctx.runQuery(
      internal.calendly.connectionQueries.getTenantConnectionContext,
      { tenantId },
    );
    if (!tenant) {
      console.error(
        `[Calendly:OAuth] prepareReconnect: tenant ${tenantId} not found`,
      );
      throw new Error("Tenant not found");
    }

    const identityOrgId = getIdentityOrgId(identity);
    if (!identityOrgId || identityOrgId !== tenant.workosOrgId) {
      console.error("[Calendly:OAuth] prepareReconnect: org mismatch", {
        tenantId,
        identityOrgId,
        tenantOrgId: tenant.workosOrgId,
      });
      throw new Error("Not authorized");
    }

    const accessToken = await revokeCalendlyToken(tenant.accessToken);
    const refreshToken = await revokeCalendlyToken(tenant.refreshToken);

    await ctx.runMutation(internal.calendly.oauthMutations.clearTenantConnection, {
      tenantId,
      status: "calendly_disconnected",
    });

    console.log("[Calendly:OAuth] prepareReconnect completed", {
      tenantId,
      accessToken,
      refreshToken,
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
    console.log(
      `[Calendly:OAuth] exchangeCodeAndProvision called for tenant ${tenantId}`,
    );
    let rollbackStatus: "pending_calendly" | "calendly_disconnected" =
      "pending_calendly";

    try {
      const identity = await ctx.auth.getUserIdentity();
      if (!identity) {
        console.error(
          `[Calendly:OAuth] exchangeCodeAndProvision: not authenticated`,
        );
        throw new Error("Not authenticated");
      }
      console.log(
        `[Calendly:OAuth] exchangeCodeAndProvision: auth check passed`,
      );

      const tenant = await ctx.runQuery(internal.tenants.getCalendlyTenant, {
        tenantId,
      });
      if (!tenant) {
        console.error(
          `[Calendly:OAuth] exchangeCodeAndProvision: tenant ${tenantId} not found`,
        );
        throw new Error("Tenant not found");
      }
      console.log(
        `[Calendly:OAuth] exchangeCodeAndProvision: tenant found, status=${tenant.status}`,
      );
      rollbackStatus =
        tenant.status === "calendly_disconnected"
          ? "calendly_disconnected"
          : "pending_calendly";

      const identityOrgId = getIdentityOrgId(identity);
      if (!identityOrgId || identityOrgId !== tenant.workosOrgId) {
        console.error(`[Calendly:OAuth] exchangeCodeAndProvision: org mismatch`);
        throw new Error("Not authorized");
      }

      const tenantData = await ctx.runQuery(
        internal.calendly.oauthMutations.getPkceVerifier,
        { tenantId },
      );
      if (!tenantData?.pkceVerifier) {
        console.error(
          `[Calendly:OAuth] exchangeCodeAndProvision: no PKCE verifier found`,
        );
        throw new Error("No PKCE verifier found — OAuth flow may have expired");
      }
      console.log(
        `[Calendly:OAuth] exchangeCodeAndProvision: PKCE verifier retrieved`,
      );

      const clientId = getCalendlyClientId();
      const clientSecret = process.env.CALENDLY_CLIENT_SECRET;
      if (!clientId || !clientSecret) {
        console.error(
          `[Calendly:OAuth] exchangeCodeAndProvision: missing OAuth config, hasClientId=${Boolean(clientId)}, hasClientSecret=${Boolean(clientSecret)}`,
        );
        throw new Error("Missing Calendly OAuth configuration");
      }

      console.log(
        `[Calendly:OAuth] exchangeCodeAndProvision: sending token exchange request`,
      );
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
      });

      if (!tokenResponse.ok) {
        const error = await tokenResponse.text();
        console.error(
          `[Calendly:OAuth] exchangeCodeAndProvision: token exchange failed, status=${tokenResponse.status}`,
        );
        throw new Error(
          `Calendly token exchange failed: ${tokenResponse.status} ${error}`,
        );
      }
      console.log(
        `[Calendly:OAuth] exchangeCodeAndProvision: token exchange response OK`,
      );

      const tokens = (await tokenResponse.json()) as {
        access_token: string;
        refresh_token: string;
        expires_in: number;
        owner: string;
        organization: string;
      };

      console.log(
        `[Calendly:OAuth] exchangeCodeAndProvision: verifying token via /users/me`,
      );
      const meResponse = await fetch("https://api.calendly.com/users/me", {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      if (!meResponse.ok) {
        console.error(
          `[Calendly:OAuth] exchangeCodeAndProvision: /users/me verification failed, status=${meResponse.status}`,
        );
        throw new Error("Failed to verify Calendly token via /users/me");
      }
      console.log(
        `[Calendly:OAuth] exchangeCodeAndProvision: /users/me verification passed`,
      );

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
        console.error(
          `[Calendly:OAuth] exchangeCodeAndProvision: missing org/owner URI, hasOrganizationUri=${Boolean(organizationUri)}, hasUserUri=${Boolean(userUri)}`,
        );
        throw new Error(
          "Calendly token response did not include owner or organization",
        );
      }

      const expiresAt = Date.now() + tokens.expires_in * 1000;
      await ctx.runMutation(internal.calendly.oauthMutations.storeConnectionTokens, {
        tenantId,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        tokenExpiresAt: expiresAt,
        organizationUri,
        userUri,
      });
      console.log(
        `[Calendly:OAuth] exchangeCodeAndProvision: tokens stored, expiresAt=${new Date(expiresAt).toISOString()}`,
      );

      await ctx.runMutation(internal.tenants.updateStatus, {
        tenantId,
        status: "provisioning_webhooks",
      });
      console.log(
        `[Calendly:OAuth] exchangeCodeAndProvision: status transitioned to provisioning_webhooks`,
      );

      const tenantAfterTokenStore = await ctx.runQuery(
        internal.calendly.connectionQueries.getTenantConnectionContext,
        { tenantId },
      );
      if (!tenantAfterTokenStore?.organizationUri) {
        console.error(
          `[Calendly:OAuth] exchangeCodeAndProvision: organization URI not stored after token save`,
        );
        throw new Error("Calendly organization URI was not stored");
      }

      console.log(
        `[Calendly:OAuth] exchangeCodeAndProvision: provisioning webhook subscription`,
      );
      const { webhookUri, signingSecret } = await provisionWebhookSubscription({
        tenantId,
        accessToken: tokens.access_token,
        organizationUri,
        convexSiteUrl,
        signingSecret: tenantAfterTokenStore.webhookSecret ?? undefined,
      });
      console.log(
        `[Calendly:OAuth] exchangeCodeAndProvision: webhook provisioned, webhookUri=${webhookUri}`,
      );

      await ctx.runMutation(
        internal.calendly.webhookSetupMutations.storeWebhookAndActivate,
        {
          tenantId,
          webhookUri,
          webhookSecret: signingSecret,
        },
      );
      console.log(
        `[Calendly:OAuth] exchangeCodeAndProvision: webhook stored and tenant activated`,
      );

      await ctx.scheduler.runAfter(0, internal.calendly.orgMembers.syncForTenant, {
        tenantId,
      });
      console.log(
        `[Calendly:OAuth] exchangeCodeAndProvision: org member sync scheduled`,
      );

      await ctx.runMutation(internal.calendly.oauthMutations.clearPkceVerifier, {
        tenantId,
      });
      console.log(
        `[Calendly:OAuth] exchangeCodeAndProvision: PKCE verifier cleared, flow complete`,
      );

      return { success: true };
    } catch (error) {
      console.error(
        `[Calendly:OAuth] exchangeCodeAndProvision: error for tenant ${tenantId}, rolling back status`,
        error instanceof Error ? error.message : error,
      );
      await ctx.runMutation(internal.calendly.oauthMutations.clearPkceVerifier, {
        tenantId,
      });
      await ctx.runMutation(internal.tenants.updateStatus, {
        tenantId,
        status: rollbackStatus,
      });
      console.log(
        `[Calendly:OAuth] exchangeCodeAndProvision: status rolled back to ${rollbackStatus}`,
      );
      throw error;
    }
  },
});
