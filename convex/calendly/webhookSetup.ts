"use node";

import { randomBytes } from "crypto";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import { internalAction } from "../_generated/server";
import { log } from "../lib/observability/log";
import { CALENDLY_FETCH_TIMEOUT_MS, calendlyHttpError } from "./apiErrors";
import { expectedError } from "../lib/observability/errors";

const EVENT_TYPE_WEBHOOK_PREFIX = "event_type";
const SUBSCRIBED_EVENTS = [
  "invitee.created",
  "invitee.canceled",
  "invitee_no_show.created",
  "invitee_no_show.deleted",
  "routing_form_submission.created",
] as const;

function assertManualEventTypeSyncBoundary(events: readonly string[]) {
  const unsupportedEvents = events.filter((event) =>
    event.startsWith(`${EVENT_TYPE_WEBHOOK_PREFIX}.`),
  );
  if (unsupportedEvents.length > 0) {
    throw new Error(
      `Manual event type sync boundary violated by webhook subscriptions: ${unsupportedEvents.join(
        ", ",
      )}`,
    );
  }
}

assertManualEventTypeSyncBoundary(SUBSCRIBED_EVENTS);

type CalendlyWebhookResource = {
  uri: string;
  callback_url: string;
  state?: "active" | "disabled";
};

type ProvisionWebhookArgs = {
  tenantId: string;
  accessToken: string;
  organizationUri: string;
  convexSiteUrl: string;
  signingSecret?: string;
};

class CalendlyWebhookConflictError extends Error {}

function getWebhookUuid(webhookUri: string) {
  try {
    const parsed = new URL(webhookUri);
    const uuid = parsed.pathname.split("/").filter(Boolean).pop();
    return uuid && uuid.length > 0 ? uuid : null;
  } catch {
    return null;
  }
}

async function findExistingWebhook({
  accessToken,
  organizationUri,
  callbackUrl,
}: {
  accessToken: string;
  organizationUri: string;
  callbackUrl: string;
}) {
  const params = new URLSearchParams({
    organization: organizationUri,
    scope: "organization",
    count: "100",
  });

  const response = await fetch(
    `https://api.calendly.com/webhook_subscriptions?${params.toString()}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      signal: AbortSignal.timeout(CALENDLY_FETCH_TIMEOUT_MS),
    },
  );

  if (!response.ok) {
    throw await calendlyHttpError("webhook subscription list", response);
  }

  const data = (await response.json()) as {
    collection?: CalendlyWebhookResource[];
  };

  const match = data.collection?.find(
    (subscription) => subscription.callback_url === callbackUrl,
  );

  return match;
}

export async function deleteWebhookSubscription({
  accessToken,
  webhookUri,
}: {
  accessToken: string;
  webhookUri: string;
}) {
  const webhookUuid = getWebhookUuid(webhookUri);
  if (!webhookUuid) {
    throw new Error(`Invalid Calendly webhook URI: ${webhookUri}`);
  }

  const response = await fetch(
    `https://api.calendly.com/webhook_subscriptions/${webhookUuid}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      signal: AbortSignal.timeout(CALENDLY_FETCH_TIMEOUT_MS),
    },
  );

  if (response.status === 404) {
    // Already gone, so the caller's delete is a no-op.
    log.info("calendly.webhook.delete_skipped", {
      reason: "not_found",
      httpStatus: 404,
    });
    return "not_found" as const;
  }

  if (!response.ok && response.status !== 204) {
    throw await calendlyHttpError("webhook subscription delete", response);
  }

  return "deleted" as const;
}

async function createWebhookSubscription({
  accessToken,
  organizationUri,
  callbackUrl,
  signingSecret,
}: {
  accessToken: string;
  organizationUri: string;
  callbackUrl: string;
  signingSecret: string;
}) {
  const response = await fetch(
    "https://api.calendly.com/webhook_subscriptions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: callbackUrl,
        events: SUBSCRIBED_EVENTS,
        organization: organizationUri,
        scope: "organization",
        signing_key: signingSecret,
      }),
      signal: AbortSignal.timeout(CALENDLY_FETCH_TIMEOUT_MS),
    },
  );

  if (!response.ok) {
    if (response.status === 409) {
      throw new CalendlyWebhookConflictError(
        "Calendly webhook subscription create failed: HTTP 409",
      );
    }

    if (response.status === 403) {
      // The tenant's Calendly plan can't receive webhooks; they need to upgrade.
      throw expectedError(
        "calendly.free_plan_unsupported",
        "Calendly webhooks need a paid Calendly plan. Upgrade Calendly, then connect again.",
      );
    }

    throw await calendlyHttpError("webhook subscription create", response);
  }

  const data = (await response.json()) as { resource: CalendlyWebhookResource };
  if (!data.resource?.uri) {
    throw new Error("Calendly webhook creation response was missing a URI");
  }

  return data.resource.uri;
}

export async function provisionWebhookSubscription(args: ProvisionWebhookArgs) {
  const callbackUrl = `${args.convexSiteUrl}/webhooks/calendly?tenantId=${args.tenantId}`;
  const signingSecret =
    args.signingSecret ?? randomBytes(32).toString("base64url");

  const createWebhook = async () =>
    await createWebhookSubscription({
      accessToken: args.accessToken,
      organizationUri: args.organizationUri,
      callbackUrl,
      signingSecret,
    });

  try {
    const webhookUri = await createWebhook();
    log.info("calendly.webhook.provisioned", {
      tenantId: args.tenantId,
      outcome: "created",
      reusedSigningSecret: Boolean(args.signingSecret),
    });
    return { webhookUri, signingSecret };
  } catch (error) {
    if (!(error instanceof CalendlyWebhookConflictError)) {
      throw error;
    }

    const existingWebhook = await findExistingWebhook({
      accessToken: args.accessToken,
      organizationUri: args.organizationUri,
      callbackUrl,
    });
    // Calendly returned 409; recover by deleting the existing subscription
    // and creating it again.
    log.warn("calendly.webhook.conflict", {
      tenantId: args.tenantId,
      httpStatus: 409,
      existingWebhookFound: Boolean(existingWebhook),
      existingWebhookState: existingWebhook?.state,
    });
    if (!existingWebhook) {
      throw new Error(
        "Calendly reported an existing webhook subscription, but no matching callback URL was found",
      );
    }

    const deleteResult = await deleteWebhookSubscription({
      accessToken: args.accessToken,
      webhookUri: existingWebhook.uri,
    });

    const webhookUri = await createWebhook();
    log.info("calendly.webhook.provisioned", {
      tenantId: args.tenantId,
      outcome: "recreated_after_conflict",
      deleteResult,
      reusedSigningSecret: Boolean(args.signingSecret),
    });
    return { webhookUri, signingSecret };
  }
}

export const provisionWebhooks = internalAction({
  args: {
    tenantId: v.id("tenants"),
    accessToken: v.string(),
    organizationUri: v.string(),
    convexSiteUrl: v.string(),
  },
  handler: async (
    ctx: ActionCtx,
    { tenantId, accessToken, organizationUri, convexSiteUrl },
  ) => {
    const tenant = await ctx.runQuery(
      internal.calendly.connectionQueries.getTenantConnectionContext,
      { tenantId },
    );
    if (!tenant) {
      log.warn("calendly.webhook_setup.rejected", {
        reason: "tenant_not_found",
        tenantId,
      });
      throw new Error("Tenant not found");
    }

    const { webhookUri, signingSecret } = await provisionWebhookSubscription({
      tenantId,
      accessToken,
      organizationUri,
      convexSiteUrl,
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
  },
});
