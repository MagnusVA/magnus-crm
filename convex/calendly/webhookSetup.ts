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

  return data.collection?.find(
    (subscription) => subscription.callback_url === callbackUrl,
  );
}

async function deleteWebhookSubscription({
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
    },
  );

  if (response.status === 404) {
    return;
  }

  if (!response.ok && response.status !== 204) {
    throw new Error(
      `Unable to delete Calendly webhook subscription: ${response.status} ${await readCalendlyError(response)}`,
    );
  }
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

  const createWebhook = async () =>
    await createWebhookSubscription({
      accessToken: args.accessToken,
      organizationUri: args.organizationUri,
      callbackUrl,
      signingKey,
    });

  try {
    const webhookUri = await createWebhook();
    return { webhookUri, webhookSigningKey: signingKey };
  } catch (error) {
    if (!(error instanceof CalendlyWebhookConflictError)) {
      throw error;
    }

    const existingWebhook = await findExistingWebhook({
      accessToken: args.accessToken,
      organizationUri: args.organizationUri,
      callbackUrl,
    });
    if (!existingWebhook) {
      throw new Error(
        "Calendly reported an existing webhook subscription, but no matching callback URL was found",
      );
    }

    if (existingWebhook.state === "active" && args.signingKey) {
      return {
        webhookUri: existingWebhook.uri,
        webhookSigningKey: signingKey,
      };
    }

    await deleteWebhookSubscription({
      accessToken: args.accessToken,
      webhookUri: existingWebhook.uri,
    });

    const webhookUri = await createWebhook();
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
    const tenant = await ctx.runQuery(internal.tenants.getCalendlyTokens, {
      tenantId,
    });
    if (!tenant) {
      throw new Error("Tenant not found");
    }

    const { webhookUri, webhookSigningKey } = await provisionWebhookSubscription(
      {
        tenantId,
        accessToken,
        organizationUri,
        convexSiteUrl,
        signingKey: tenant.webhookSigningKey ?? undefined,
      },
    );

    await ctx.runMutation(internal.calendly.webhookSetupMutations.storeWebhookAndActivate, {
      tenantId,
      calendlyWebhookUri: webhookUri,
      webhookSigningKey,
    });
  },
});
