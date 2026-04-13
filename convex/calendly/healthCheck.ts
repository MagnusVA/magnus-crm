"use node";

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { provisionWebhookSubscription } from "./webhookSetup";
import { refreshTenantTokenCore } from "./tokens";

type TenantHealthState = {
  accessToken?: string;
  organizationUri?: string;
  webhookUri?: string;
  webhookSecret?: string;
  tenantStatus: string;
};

function getConvexSiteUrl() {
  return (
    process.env.NEXT_PUBLIC_CONVEX_SITE_URL ??
    process.env.NEXT_PUBLIC_CONVEX_URL?.replace(
      ".convex.cloud",
      ".convex.site",
    ) ??
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
  console.log(
    `[health-check] runTenantHealthCheck: entry for tenant ${tenantId}`,
  );

  const tenant = (await ctx.runQuery(
    internal.calendly.connectionQueries.getTenantConnectionContext,
    {
      tenantId,
    },
  )) as TenantHealthState | null;

  if (!tenant?.accessToken || !tenant.organizationUri) {
    console.warn(
      `[health-check] runTenantHealthCheck: tenant ${tenantId} skipped, hasAccessToken=${Boolean(tenant?.accessToken)}, hasOrganizationUri=${Boolean(tenant?.organizationUri)}`,
    );
    return { status: "skipped" as const, reason: "missing_tokens_or_org" };
  }

  if (
    tenant.tenantStatus !== "active" &&
    tenant.tenantStatus !== "provisioning_webhooks"
  ) {
    console.warn(
      `[health-check] runTenantHealthCheck: tenant ${tenantId} skipped, status=${tenant.tenantStatus}`,
    );
    return { status: "skipped" as const, reason: "tenant_not_ready" };
  }

  console.log(
    `[health-check] runTenantHealthCheck: tenant ${tenantId} introspecting access token`,
  );
  let accessToken = tenant.accessToken;
  const tokenStatus = await introspectAccessToken(accessToken);
  console.log(
    `[health-check] runTenantHealthCheck: tenant ${tenantId} token introspection result: active=${tokenStatus.active}`,
  );

  if (!tokenStatus.active) {
    console.log(
      `[health-check] runTenantHealthCheck: tenant ${tenantId} token inactive, attempting refresh`,
    );
    const refreshed = await refreshTenantTokenCore(ctx, tenantId);
    if (!refreshed.refreshed) {
      console.warn(
        `[health-check] runTenantHealthCheck: tenant ${tenantId} refresh failed, reason=${refreshed.reason}`,
      );
      return {
        status: "skipped" as const,
        reason: refreshed.reason,
      };
    }
    accessToken = refreshed.accessToken;
    console.log(
      `[health-check] runTenantHealthCheck: tenant ${tenantId} token refreshed successfully`,
    );
  }

  console.log(
    `[health-check] runTenantHealthCheck: tenant ${tenantId} checking webhook state, hasWebhookUri=${Boolean(tenant.webhookUri)}`,
  );
  const webhookState = tenant.webhookUri
    ? await getWebhookSubscriptionState(accessToken, tenant.webhookUri)
    : "missing";
  console.log(
    `[health-check] runTenantHealthCheck: tenant ${tenantId} webhookState=${webhookState}`,
  );

  if (webhookState !== "active") {
    console.log(
      `[health-check] runTenantHealthCheck: tenant ${tenantId} reprovisioning webhook (state=${webhookState})`,
    );
    const { webhookUri, signingSecret } = await provisionWebhookSubscription({
      tenantId,
      accessToken,
      organizationUri: tenant.organizationUri,
      convexSiteUrl: getConvexSiteUrl(),
      signingSecret: tenant.webhookSecret ?? undefined,
    });

    await ctx.runMutation(
      internal.calendly.webhookSetupMutations.storeWebhookAndActivate,
      {
        tenantId,
        webhookUri,
        webhookSecret: signingSecret,
      },
    );
    console.log(
      `[health-check] runTenantHealthCheck: tenant ${tenantId} webhook reprovisioned, newUri=${webhookUri}`,
    );
  }

  console.log(
    `[health-check] runTenantHealthCheck: tenant ${tenantId} check complete, tokenActive=true, webhookState=${webhookState}`,
  );
  return {
    status: "checked" as const,
    tokenActive: true,
    webhookState,
  };
}

export const checkSingleTenant = internalAction({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    console.log(`[health-check] checkSingleTenant: entry for tenant ${tenantId}`);
    try {
      const result = await runTenantHealthCheck(ctx, tenantId);
      await ctx.runMutation(
        internal.calendly.healthCheckMutations.markTenantHealthChecked,
        {
          tenantId,
          checkedAt: Date.now(),
        },
      );
      console.log(
        `[health-check] checkSingleTenant: tenant ${tenantId} completed, status=${result.status}`,
      );
      return result;
    } catch (error) {
      console.error(
        `[health-check] checkSingleTenant: tenant ${tenantId} failed:`,
        error instanceof Error ? error.message : error,
      );
      return {
        status: "error" as const,
        reason: "health_check_exception" as const,
        message: error instanceof Error ? error.message : "Unknown error",
      };
    }
  },
});

export const runHealthCheck = internalAction({
  args: {},
  handler: async (ctx) => {
    console.log(`[health-check] runHealthCheck: entry`);

    const stuckTenants = await ctx.runQuery(
      internal.calendly.healthCheckMutations.listStuckProvisioningTenants,
    );
    console.log(
      `[health-check] runHealthCheck: found ${stuckTenants.length} stuck provisioning tenants`,
    );

    for (const { tenantId, companyName } of stuckTenants) {
      await ctx.runMutation(internal.tenants.updateStatus, {
        tenantId,
        status: "pending_calendly",
      });
      console.warn(
        `[health-check] runHealthCheck: reverted stuck tenant "${companyName}" (${tenantId}) from provisioning_webhooks → pending_calendly`,
      );
    }

    const tenantIds: Array<Id<"tenants">> = await ctx.runQuery(
      internal.calendly.tokenMutations.listActiveTenantIds,
      {},
    );

    console.log(
      `[health-check] runHealthCheck: scheduling health check for ${tenantIds.length} active tenants`,
    );

    for (const tenantId of tenantIds) {
      await ctx.scheduler.runAfter(
        0,
        internal.calendly.healthCheck.checkSingleTenant,
        { tenantId },
      );
    }

    console.log(
      `[health-check] runHealthCheck: all ${tenantIds.length} checks scheduled`,
    );
  },
});
