"use node";

import { internal } from "../_generated/api";
import { internalAction } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { provisionWebhookSubscription } from "./webhookSetup";
import { refreshTenantTokenCore } from "./tokens";

type TenantHealthState = {
  calendlyAccessToken?: string;
  calendlyOrgUri?: string;
  calendlyWebhookUri?: string;
  webhookSigningKey?: string;
  status: string;
};

function getConvexSiteUrl() {
  return (
    process.env.NEXT_PUBLIC_CONVEX_SITE_URL ??
    process.env.NEXT_PUBLIC_CONVEX_URL?.replace(".convex.cloud", ".convex.site") ??
    "http://localhost:3000"
  );
}

async function introspectAccessToken(accessToken: string) {
  const clientId =
    process.env.CALENDLY_CLIENT_ID ?? process.env.NEXT_PUBLIC_CALENDLY_CLIENT_ID;
  const clientSecret = process.env.CALENDLY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Missing Calendly OAuth configuration");
  }

  const response = await fetch("https://auth.calendly.com/oauth/introspect", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      token: accessToken,
    }).toString(),
  });

  if (!response.ok) {
    return { active: false };
  }

  const data = (await response.json()) as { active?: boolean };
  return { active: Boolean(data.active) };
}

async function getWebhookSubscriptionState(
  accessToken: string,
  webhookUri: string,
) {
  const webhookUuid = new URL(webhookUri).pathname.split("/").filter(Boolean).pop();
  if (!webhookUuid) {
    throw new Error(`Invalid Calendly webhook URI: ${webhookUri}`);
  }

  const response = await fetch(
    `https://api.calendly.com/webhook_subscriptions/${webhookUuid}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );

  if (response.status === 404) {
    return "missing" as const;
  }

  if (!response.ok) {
    throw new Error(
      `Unable to inspect Calendly webhook subscription ${webhookUuid}: ${response.status} ${await response.text()}`,
    );
  }

  const data = (await response.json()) as {
    resource?: { state?: "active" | "disabled" };
  };

  return data.resource?.state === "disabled"
    ? ("disabled" as const)
    : ("active" as const);
}

async function runTenantHealthCheck(
  ctx: Parameters<typeof refreshTenantTokenCore>[0],
  tenantId: Id<"tenants">,
) {
  const tenant = (await ctx.runQuery(internal.tenants.getCalendlyTokens, {
    tenantId,
  })) as TenantHealthState | null;

  if (!tenant?.calendlyAccessToken || !tenant.calendlyOrgUri) {
    return { status: "skipped" as const, reason: "missing_tokens_or_org" };
  }

  if (tenant.status !== "active" && tenant.status !== "provisioning_webhooks") {
    return { status: "skipped" as const, reason: "tenant_not_ready" };
  }

  let accessToken = tenant.calendlyAccessToken;
  const tokenStatus = await introspectAccessToken(accessToken);
  if (!tokenStatus.active) {
    const refreshed = await refreshTenantTokenCore(ctx, tenantId);
    if (!refreshed.refreshed) {
      return {
        status: "skipped" as const,
        reason: refreshed.reason,
      };
    }
    accessToken = refreshed.accessToken;
  }

  const webhookState = tenant.calendlyWebhookUri
    ? await getWebhookSubscriptionState(accessToken, tenant.calendlyWebhookUri)
    : "missing";

  if (webhookState !== "active") {
    const { webhookUri, webhookSigningKey } = await provisionWebhookSubscription(
      {
        tenantId,
        accessToken,
        organizationUri: tenant.calendlyOrgUri,
        convexSiteUrl: getConvexSiteUrl(),
        signingKey: tenant.webhookSigningKey ?? undefined,
      },
    );

    await ctx.runMutation(
      internal.calendly.webhookSetupMutations.storeWebhookAndActivate,
      {
        tenantId,
        calendlyWebhookUri: webhookUri,
        webhookSigningKey,
      },
    );
  }

  return {
    status: "checked" as const,
    tokenActive: true,
    webhookState,
  };
}

/**
 * Daily health check cron for Calendly tenants.
 */
export const runHealthCheck = internalAction({
  args: {},
  handler: async (ctx) => {
    const tenantIds: Array<Id<"tenants">> = await ctx.runQuery(
      internal.calendly.tokenMutations.listActiveTenantIds,
      {},
    );

    for (const tenantId of tenantIds) {
      try {
        const result = await runTenantHealthCheck(ctx, tenantId);
        console.log(`Calendly health check for tenant ${tenantId}: ${result.status}`);
      } catch (error) {
        console.error(`Calendly health check failed for tenant ${tenantId}:`, error);
      }
    }
  },
});
