"use node";

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction, env } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { log, reportError } from "../lib/observability/log";
import { CALENDLY_FETCH_TIMEOUT_MS, calendlyHttpError } from "./apiErrors";
import { provisionWebhookSubscription } from "./webhookSetup";
import { refreshTenantTokenCore } from "./tokens";

/** Report at most this many tenant ids on one stuck-provisioning report. */
const MAX_REPORTED_TENANT_IDS = 10;

type TokenIntrospection =
  | { status: "active" }
  | { status: "inactive"; httpStatus?: number }
  /** Calendly is down or rate limiting; the token's state is unknown. */
  | { status: "unavailable"; httpStatus: number };

type TenantHealthState = {
  accessToken?: string;
  organizationUri?: string;
  webhookUri?: string;
  webhookSecret?: string;
  tenantStatus: string;
};

async function introspectAccessToken(
  accessToken: string,
): Promise<TokenIntrospection> {
  const clientId = env.CALENDLY_CLIENT_ID;
  const clientSecret = env.CALENDLY_CLIENT_SECRET;
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
    signal: AbortSignal.timeout(CALENDLY_FETCH_TIMEOUT_MS),
  });

  if (response.status === 429 || response.status >= 500) {
    return { status: "unavailable", httpStatus: response.status };
  }
  if (!response.ok) {
    return { status: "inactive", httpStatus: response.status };
  }

  const data = (await response.json()) as { active?: boolean };
  return { status: data.active ? "active" : "inactive" };
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
      signal: AbortSignal.timeout(CALENDLY_FETCH_TIMEOUT_MS),
    },
  );

  if (response.status === 404) {
    return "missing" as const;
  }

  if (!response.ok) {
    throw await calendlyHttpError("webhook subscription lookup", response);
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
  const tenant = (await ctx.runQuery(
    internal.calendly.connectionQueries.getTenantConnectionContext,
    {
      tenantId,
    },
  )) as TenantHealthState | null;

  if (!tenant?.accessToken || !tenant.organizationUri) {
    return { status: "skipped" as const, reason: "missing_tokens_or_org" };
  }

  if (
    tenant.tenantStatus !== "active" &&
    tenant.tenantStatus !== "provisioning_webhooks"
  ) {
    return { status: "skipped" as const, reason: "tenant_not_ready" };
  }

  let accessToken = tenant.accessToken;
  const tokenStatus = await introspectAccessToken(accessToken);

  if (tokenStatus.status === "unavailable") {
    // Refreshing spends the single-use refresh token, so don't refresh on a
    // guess. The stored token is likely still valid; check again next run.
    log.warn("calendly.health_check.introspection_unavailable", {
      tenantId,
      httpStatus: tokenStatus.httpStatus,
      action: "skip_refresh",
    });
  } else if (tokenStatus.status === "inactive") {
    if (tokenStatus.httpStatus !== undefined) {
      log.warn("calendly.health_check.introspection_failed", {
        tenantId,
        httpStatus: tokenStatus.httpStatus,
        action: "refresh",
      });
    }
    const refreshed = await refreshTenantTokenCore(ctx, tenantId);
    if (!refreshed.refreshed) {
      return {
        status: "skipped" as const,
        reason: refreshed.reason,
      };
    }
    accessToken = refreshed.accessToken;
  }

  const webhookState = tenant.webhookUri
    ? await getWebhookSubscriptionState(accessToken, tenant.webhookUri)
    : "missing";

  if (webhookState !== "active") {
    const { webhookUri, signingSecret } = await provisionWebhookSubscription({
      tenantId,
      accessToken,
      organizationUri: tenant.organizationUri,
      convexSiteUrl: env.CONVEX_SITE_URL,
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
    // A disabled or missing subscription means Calendly stopped delivering
    // bookings, which were lost until now.
    reportError(
      "calendly.webhook.reprovisioned",
      new Error(`Calendly webhook subscription was ${webhookState}`),
      {
        severity: "error",
        integration: "calendly",
        fingerprint: `calendly.webhook.reprovisioned:${webhookState}`,
        tenantId,
        previousState: webhookState,
        trigger: "health_check",
      },
    );
  }

  return {
    status: "checked" as const,
    tokenActive: true,
    webhookState,
  };
}

export const checkSingleTenant = internalAction({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    const startedAt = Date.now();
    try {
      const result = await runTenantHealthCheck(ctx, tenantId);
      await ctx.runMutation(
        internal.calendly.healthCheckMutations.markTenantHealthChecked,
        {
          tenantId,
          checkedAt: Date.now(),
        },
      );
      const attrs = {
        tenantId,
        status: result.status,
        reason: result.status === "skipped" ? result.reason : undefined,
        webhookState: result.status === "checked" ? result.webhookState : undefined,
        durationMs: Date.now() - startedAt,
      };
      if (result.status === "checked") {
        log.info("calendly.health_check.result", attrs);
      } else {
        log.warn("calendly.health_check.result", attrs);
      }
      return result;
    } catch (error) {
      // Swallowed into an `error` result, so report it here.
      reportError("calendly.health_check.failed", error, {
        integration: "calendly",
        tenantId,
        durationMs: Date.now() - startedAt,
      });
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
    const stuckTenants = await ctx.runQuery(
      internal.calendly.healthCheckMutations.listStuckProvisioningTenants,
    );

    // Revert each tenant independently, so one failure doesn't stop the rest.
    const revertedTenantIds: Array<Id<"tenants">> = [];
    for (const { tenantId } of stuckTenants) {
      try {
        await ctx.runMutation(internal.tenants.updateStatus, {
          tenantId,
          status: "pending_calendly",
        });
        revertedTenantIds.push(tenantId);
      } catch (error) {
        reportError("calendly.onboarding.provisioning_revert_failed", error, {
          severity: "error",
          integration: "calendly",
          fingerprint: "calendly.onboarding.provisioning_revert_failed",
          tenantId,
        });
      }
    }
    if (stuckTenants.length > 0) {
      reportError(
        "calendly.onboarding.provisioning_stuck",
        new Error("Tenants stuck provisioning Calendly webhooks for over 10 minutes"),
        {
          severity: "error",
          integration: "calendly",
          fingerprint: "calendly.onboarding.provisioning_stuck",
          count: stuckTenants.length,
          revertedCount: revertedTenantIds.length,
          tenantIds: stuckTenants
            .slice(0, MAX_REPORTED_TENANT_IDS)
            .map(({ tenantId }) => tenantId),
          fromStatus: "provisioning_webhooks",
          toStatus: "pending_calendly",
        },
      );
    }

    const tenantIds: Array<Id<"tenants">> = await ctx.runQuery(
      internal.calendly.tokenMutations.listActiveTenantIds,
      {},
    );

    for (const tenantId of tenantIds) {
      await ctx.scheduler.runAfter(
        0,
        internal.calendly.healthCheck.checkSingleTenant,
        { tenantId },
      );
    }

    log.info("calendly.health_check.scheduled", {
      tenantCount: tenantIds.length,
      stuckTenantCount: stuckTenants.length,
    });
  },
});
