"use node";

import { randomBytes } from "crypto";
import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";

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
};

async function readCalendlyError(response: Response) {
  const bodyText = await response.text();
  return bodyText || response.statusText;
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
  handler: async (ctx, { tenantId, accessToken, organizationUri, convexSiteUrl }) => {
    const signingKey = randomBytes(32).toString("base64url");
    const callbackUrl = `${convexSiteUrl}/webhooks/calendly?tenantId=${tenantId}`;

    const response = await fetch("https://api.calendly.com/webhook_subscriptions", {
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
    });

    let webhookUri: string | undefined;

    if (response.status === 409) {
      const existingWebhook = await findExistingWebhook({
        accessToken,
        organizationUri,
        callbackUrl,
      });
      if (!existingWebhook) {
        throw new Error(
          "Calendly reported an existing webhook subscription, but no matching callback URL was found",
        );
      }
      webhookUri = existingWebhook.uri;
    } else if (!response.ok) {
      throw new Error(
        `Webhook provisioning failed: ${response.status} ${await readCalendlyError(response)}`,
      );
    } else {
      const data = (await response.json()) as { resource: CalendlyWebhookResource };
      webhookUri = data.resource.uri;
    }

    await ctx.runMutation(internal.calendly.webhookSetupMutations.storeWebhookAndActivate, {
      tenantId,
      calendlyWebhookUri: webhookUri,
      webhookSigningKey: signingKey,
    });
  },
});
