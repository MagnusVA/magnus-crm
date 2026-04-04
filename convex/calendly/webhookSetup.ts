"use node";

import { randomBytes } from "crypto";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import { internalAction } from "../_generated/server";

const SUBSCRIBED_EVENTS = [
  "invitee.created",
  "invitee.canceled",
  "invitee_no_show.created",
  "invitee_no_show.deleted",
  "routing_form_submission.created",
] as const;

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
  signingKey?: string;
};

class CalendlyWebhookConflictError extends Error {}

async function readCalendlyError(response: Response) {
  const bodyText = await response.text();
  return bodyText || response.statusText;
}

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
  console.log(`[Webhook:Setup] findExistingWebhook: searching for callbackUrl=${callbackUrl}`);

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
    },
  );

  if (!response.ok) {
    throw new Error(
      `Unable to list existing Calendly webhooks: ${response.status} ${await readCalendlyError(response)}`,
    );
  }

  const data = (await response.json()) as {
    collection?: CalendlyWebhookResource[];
  };

  const match = data.collection?.find(
    (subscription) => subscription.callback_url === callbackUrl,
  );

  console.log(`[Webhook:Setup] findExistingWebhook: found ${data.collection?.length ?? 0} subscriptions, match=${match ? match.uri : "none"}`);

  return match;
}

export async function deleteWebhookSubscription({
  accessToken,
  webhookUri,
}: {
  accessToken: string;
  webhookUri: string;
}) {
  console.log(`[Webhook:Setup] deleteWebhookSubscription: deleting webhookUri=${webhookUri}`);

  const webhookUuid = getWebhookUuid(webhookUri);
  if (!webhookUuid) {
    console.error(`[Webhook:Setup] deleteWebhookSubscription: invalid webhook URI: ${webhookUri}`);
    throw new Error(`Invalid Calendly webhook URI: ${webhookUri}`);
  }

  const response = await fetch(
    `https://api.calendly.com/webhook_subscriptions/${webhookUuid}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );

  if (response.status === 404) {
    console.warn(`[Webhook:Setup] deleteWebhookSubscription: webhook not found (404), uuid=${webhookUuid}`);
    return "not_found" as const;
  }

  if (!response.ok && response.status !== 204) {
    throw new Error(
      `Unable to delete Calendly webhook subscription: ${response.status} ${await readCalendlyError(response)}`,
    );
  }

  console.log(`[Webhook:Setup] deleteWebhookSubscription: deleted successfully, uuid=${webhookUuid}`);
  return "deleted" as const;
}

async function createWebhookSubscription({
  accessToken,
  organizationUri,
  callbackUrl,
  signingKey,
}: {
  accessToken: string;
  organizationUri: string;
  callbackUrl: string;
  signingKey: string;
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
        signing_key: signingKey,
      }),
    },
  );

  if (!response.ok) {
    if (response.status === 409) {
      throw new CalendlyWebhookConflictError(
        `Webhook already exists for callback URL ${callbackUrl}`,
      );
    }

    if (response.status === 403) {
      throw new Error("calendly_free_plan_unsupported");
    }

    throw new Error(
      `Webhook provisioning failed: ${response.status} ${await readCalendlyError(response)}`,
    );
  }

  const data = (await response.json()) as { resource: CalendlyWebhookResource };
  if (!data.resource?.uri) {
    throw new Error("Calendly webhook creation response was missing a URI");
  }

  return data.resource.uri;
}

export async function provisionWebhookSubscription(
  args: ProvisionWebhookArgs,
) {
  const callbackUrl = `${args.convexSiteUrl}/webhooks/calendly?tenantId=${args.tenantId}`;
  const signingKey = args.signingKey ?? randomBytes(32).toString("base64url");

  console.log(`[Webhook:Setup] provisionWebhookSubscription: entry for tenant ${args.tenantId}, callbackUrl=${callbackUrl}, hasExistingSigningKey=${Boolean(args.signingKey)}`);

  const createWebhook = async () =>
    await createWebhookSubscription({
      accessToken: args.accessToken,
      organizationUri: args.organizationUri,
      callbackUrl,
      signingKey,
    });

  try {
    console.log(`[Webhook:Setup] provisionWebhookSubscription: attempting create`);
    const webhookUri = await createWebhook();
    console.log(`[Webhook:Setup] provisionWebhookSubscription: created successfully, webhookUri=${webhookUri}`);
    return { webhookUri, webhookSigningKey: signingKey };
  } catch (error) {
    if (!(error instanceof CalendlyWebhookConflictError)) {
      throw error;
    }

    console.warn(`[Webhook:Setup] provisionWebhookSubscription: conflict detected, looking for existing webhook`);
    const existingWebhook = await findExistingWebhook({
      accessToken: args.accessToken,
      organizationUri: args.organizationUri,
      callbackUrl,
    });
    if (!existingWebhook) {
      console.error(`[Webhook:Setup] provisionWebhookSubscription: conflict reported but no matching webhook found`);
      throw new Error(
        "Calendly reported an existing webhook subscription, but no matching callback URL was found",
      );
    }

    console.log(`[Webhook:Setup] provisionWebhookSubscription: deleting existing webhook ${existingWebhook.uri} and recreating`);
    // Delete existing webhook to ensure signing key consistency
    await deleteWebhookSubscription({
      accessToken: args.accessToken,
      webhookUri: existingWebhook.uri,
    });

    const webhookUri = await createWebhook();
    console.log(`[Webhook:Setup] provisionWebhookSubscription: recreated successfully, webhookUri=${webhookUri}`);
    return { webhookUri, webhookSigningKey: signingKey };
  }
}

/**
 * Provision a Calendly webhook subscription for a tenant.
 *
 * Creates an organization-scoped subscription with a per-tenant signing key.
 * Updates the tenant record with the webhook URI and signing key.
 */
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
    console.log(`[Webhook:Setup] provisionWebhooks (internal action): entry for tenant ${tenantId}`);

    const tenant = await ctx.runQuery(internal.tenants.getCalendlyTokens, {
      tenantId,
    });
    if (!tenant) {
      console.error(`[Webhook:Setup] provisionWebhooks: tenant ${tenantId} not found`);
      throw new Error("Tenant not found");
    }
    console.log(`[Webhook:Setup] provisionWebhooks: tenant found, hasExistingSigningKey=${Boolean(tenant.webhookSigningKey)}`);

    const { webhookUri, webhookSigningKey } = await provisionWebhookSubscription(
      {
        tenantId,
        accessToken,
        organizationUri,
        convexSiteUrl,
        signingKey: tenant.webhookSigningKey ?? undefined,
      },
    );

    console.log(`[Webhook:Setup] provisionWebhooks: provisioned, storing webhook and activating tenant ${tenantId}`);
    await ctx.runMutation(internal.calendly.webhookSetupMutations.storeWebhookAndActivate, {
      tenantId,
      calendlyWebhookUri: webhookUri,
      webhookSigningKey,
    });
    console.log(`[Webhook:Setup] provisionWebhooks: tenant ${tenantId} activated`);
  },
});
