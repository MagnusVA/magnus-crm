"use node";

import { randomBytes, createHash } from "crypto";
import type { UserIdentity } from "convex/server";
import { v } from "convex/values";
import { action } from "../_generated/server";
import { internal } from "../_generated/api";
import { provisionWebhookSubscription } from "./webhookSetup";

function getIdentityOrgId(identity: UserIdentity) {
  const rawIdentity = identity as Record<string, unknown>;

  return (
    (typeof rawIdentity.organization_id === "string"
      ? rawIdentity.organization_id
      : undefined) ??
    (typeof rawIdentity.organizationId === "string"
      ? rawIdentity.organizationId
      : undefined) ??
    (typeof rawIdentity.org_id === "string" ? rawIdentity.org_id : undefined)
  );
}

function getCalendlyClientId() {
  return (
    process.env.CALENDLY_CLIENT_ID ?? process.env.NEXT_PUBLIC_CALENDLY_CLIENT_ID
  );
}

function getCalendlyRedirectUri() {
  return `${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}/callback/calendly`;
}

/**
 * Generate PKCE challenge and return the Calendly OAuth authorize URL.
 *
 * The frontend redirects the user's browser to the returned URL.
 * The code_verifier is stored server-side (on the tenant record)
 * and used later during the token exchange.
 */
export const startOAuth = action({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Not authenticated");
    }

    const tenant = await ctx.runQuery(internal.tenants.getCalendlyTenant, {
      tenantId,
    });
    if (!tenant) {
      throw new Error("Tenant not found");
    }

    const identityOrgId = getIdentityOrgId(identity);
    if (!identityOrgId || identityOrgId !== tenant.workosOrgId) {
      throw new Error("Not authorized");
    }

    if (
      tenant.status !== "pending_calendly" &&
      tenant.status !== "calendly_disconnected"
    ) {
      throw new Error("Tenant is not ready to connect Calendly");
    }

    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");

    await ctx.runMutation(internal.calendly.oauthMutations.storeCodeVerifier, {
      tenantId,
      codeVerifier,
    });

    const clientId = getCalendlyClientId();
    if (!clientId) {
      throw new Error("Missing CALENDLY_CLIENT_ID");
    }

    const scopes = [
      "scheduled_events:read",
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

    return {
      authorizeUrl: `https://auth.calendly.com/oauth/authorize?${params.toString()}`,
    };
  },
});

/**
 * Exchange the authorization code for tokens.
 *
 * Called by the Next.js callback route after Calendly redirects back.
 * Performs: code exchange → token storage → user/me verification →
 * webhook provisioning → status transition to active.
 */
export const exchangeCodeAndProvision = action({
  args: {
    tenantId: v.id("tenants"),
    code: v.string(),
    convexSiteUrl: v.string(),
  },
  handler: async (ctx, { tenantId, code, convexSiteUrl }) => {
    try {
      const identity = await ctx.auth.getUserIdentity();
      if (!identity) {
        throw new Error("Not authenticated");
      }

      const tenant = await ctx.runQuery(internal.tenants.getCalendlyTenant, {
        tenantId,
      });
      if (!tenant) {
        throw new Error("Tenant not found");
      }

      const identityOrgId = getIdentityOrgId(identity);
      if (!identityOrgId || identityOrgId !== tenant.workosOrgId) {
        throw new Error("Not authorized");
      }

      const tenantData = await ctx.runQuery(
        internal.calendly.oauthMutations.getCodeVerifier,
        { tenantId },
      );
      if (!tenantData?.codeVerifier) {
        throw new Error("No code verifier found — OAuth flow may have expired");
      }

      const clientId = getCalendlyClientId();
      const clientSecret = process.env.CALENDLY_CLIENT_SECRET;
      if (!clientId || !clientSecret) {
        throw new Error("Missing Calendly OAuth configuration");
      }

      const tokenResponse = await fetch(
        "https://auth.calendly.com/oauth/token",
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: getCalendlyRedirectUri(),
            code_verifier: tenantData.codeVerifier,
          }).toString(),
        },
      );

      if (!tokenResponse.ok) {
        const error = await tokenResponse.text();
        throw new Error(
          `Calendly token exchange failed: ${tokenResponse.status} ${error}`,
        );
      }

      const tokens = (await tokenResponse.json()) as {
        access_token: string;
        refresh_token: string;
        expires_in: number;
        owner: string;
        organization: string;
      };

      const meResponse = await fetch("https://api.calendly.com/users/me", {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      if (!meResponse.ok) {
        throw new Error("Failed to verify Calendly token via /users/me");
      }

      const meData = (await meResponse.json()) as {
        resource?: {
          uri?: string;
          current_organization?: string;
        };
      };
      const calendlyOrgUri =
        tokens.organization ?? meData.resource?.current_organization;
      const calendlyOwnerUri = tokens.owner ?? meData.resource?.uri;
      if (!calendlyOrgUri || !calendlyOwnerUri) {
        throw new Error(
          "Calendly token response did not include owner or organization",
        );
      }

      const expiresAt = Date.now() + tokens.expires_in * 1000;
      await ctx.runMutation(internal.tenants.storeCalendlyTokens, {
        tenantId,
        calendlyAccessToken: tokens.access_token,
        calendlyRefreshToken: tokens.refresh_token,
        calendlyTokenExpiresAt: expiresAt,
        calendlyOrgUri,
        calendlyOwnerUri,
      });

      await ctx.runMutation(internal.tenants.updateStatus, {
        tenantId,
        status: "provisioning_webhooks",
      });

      const tenantAfterTokenStore = await ctx.runQuery(
        internal.tenants.getCalendlyTokens,
        { tenantId },
      );
      if (!tenantAfterTokenStore?.calendlyOrgUri) {
        throw new Error("Calendly organization URI was not stored");
      }

      const { webhookUri, webhookSigningKey } = await provisionWebhookSubscription(
        {
          tenantId,
          accessToken: tokens.access_token,
          organizationUri: calendlyOrgUri,
          convexSiteUrl,
          signingKey: tenantAfterTokenStore.webhookSigningKey ?? undefined,
        },
      );

      await ctx.runMutation(internal.calendly.webhookSetupMutations.storeWebhookAndActivate, {
        tenantId,
        calendlyWebhookUri: webhookUri,
        webhookSigningKey,
      });

      // Schedule org member sync (non-blocking, runs after onboarding completes)
      await ctx.scheduler.runAfter(0, internal.calendly.orgMembers.syncForTenant, {
        tenantId,
      });

      await ctx.runMutation(internal.calendly.oauthMutations.clearCodeVerifier, {
        tenantId,
      });

      return { success: true };
    } catch (error) {
      await ctx.runMutation(internal.calendly.oauthMutations.clearCodeVerifier, {
        tenantId,
      });
      await ctx.runMutation(internal.tenants.updateStatus, {
        tenantId,
        status: "pending_calendly",
      });
      throw error;
    }
  },
});
