import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  log,
  logRequestContext,
  reportError,
} from "../lib/observability/log";

function parseSignatureHeader(signatureHeader: string) {
  const signatureEntries = signatureHeader.split(",").map((entry) => {
    const [key, value] = entry.split("=", 2);
    return [key?.trim(), value?.trim()] as const;
  });

  const parts = Object.fromEntries(signatureEntries);
  const timestamp = typeof parts.t === "string" ? parts.t : undefined;
  const signature = typeof parts.v1 === "string" ? parts.v1 : undefined;

  return { timestamp, signature };
}

function timingSafeEqualHex(a: string, b: string) {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i += 1) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}

async function createSignature(secret: string, signedPayload: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signatureBytes = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(signedPayload),
  );

  return Array.from(new Uint8Array(signatureBytes))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getNonEmptyString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getCalendlyEventUri(payload: unknown) {
  if (!isRecord(payload)) {
    return undefined;
  }

  const payloadBody = isRecord(payload.payload) ? payload.payload : undefined;
  if (!payloadBody) {
    return undefined;
  }

  return (
    getNonEmptyString(payloadBody, "uri") ??
    getNonEmptyString(payloadBody, "event") ??
    (isRecord(payloadBody.event)
      ? getNonEmptyString(payloadBody.event, "uri")
      : undefined) ??
    (isRecord(payloadBody.invitee)
      ? getNonEmptyString(payloadBody.invitee, "uri")
      : undefined) ??
    (isRecord(payloadBody.scheduled_event)
      ? getNonEmptyString(payloadBody.scheduled_event, "uri")
      : undefined)
  );
}

/**
 * Calendly webhook ingestion endpoint.
 *
 * URL: /webhooks/calendly?tenantId={tenantId}
 *
 * Verifies the Calendly-Webhook-Signature header against the
 * per-tenant signing key, persists the raw event, returns 200.
 */
export const handleCalendlyWebhook = httpAction(async (ctx, req) => {
  const url = new URL(req.url);
  const tenantIdParam = url.searchParams.get("tenantId");

  if (!tenantIdParam) {
    log.warn("calendly.webhook.rejected", {
      reason: "missing_tenant_id",
      httpStatus: 400,
    });
    return new Response("Missing tenantId", { status: 400 });
  }

  const rawBody = await req.text();

  const tenant = await ctx.runQuery(internal.webhooks.calendlyQueries.getTenantSigningKey, {
    tenantId: tenantIdParam,
  });
  if (!tenant.ok) {
    if (tenant.reason === "invalid_id") {
      // The raw param is attacker-controlled, so it isn't logged.
      log.warn("calendly.webhook.rejected", {
        reason: "unknown_tenant",
        tenantIdValid: false,
        httpStatus: 404,
      });
    } else {
      logRequestContext({ tenantId: tenant.tenantId });
      if (tenant.reason === "no_secret") {
        // Calendly delivered to a connected tenant with no stored secret
        // (usually mid-reconnect), so the booking is rejected and lost.
        reportError(
          "calendly.webhook.no_signing_key",
          new Error("Calendly webhook received for a tenant with no webhook secret"),
          {
            severity: "warning",
            integration: "calendly",
            fingerprint: "calendly.webhook.no_signing_key",
            tenantId: tenant.tenantId,
            httpStatus: 404,
          },
        );
      } else {
        log.warn("calendly.webhook.rejected", {
          reason: "unknown_tenant",
          tenantIdValid: true,
          tenantId: tenant.tenantId,
          httpStatus: 404,
        });
      }
    }
    return new Response("Unknown tenant", { status: 404 });
  }
  logRequestContext({ tenantId: tenant.tenantId });

  const signatureHeader = req.headers.get("Calendly-Webhook-Signature");
  if (!signatureHeader) {
    log.warn("calendly.webhook.rejected", {
      reason: "missing_signature",
      tenantId: tenant.tenantId,
      httpStatus: 401,
    });
    return new Response("Missing signature", { status: 401 });
  }

  const { timestamp, signature } = parseSignatureHeader(signatureHeader);
  if (!timestamp || !signature) {
    log.warn("calendly.webhook.rejected", {
      reason: "malformed_signature",
      tenantId: tenant.tenantId,
      httpStatus: 401,
    });
    return new Response("Malformed signature", { status: 401 });
  }

  const expectedSignature = await createSignature(
    tenant.webhookSecret,
    `${timestamp}.${rawBody}`,
  );
  if (!timingSafeEqualHex(expectedSignature, signature)) {
    // Usually a stored webhook secret out of sync with Calendly, which
    // rejects every booking for the tenant until someone reconnects.
    reportError(
      "calendly.webhook.invalid_signature",
      new Error("Calendly webhook signature did not match the tenant's secret"),
      {
        severity: "error",
        fingerprint: "calendly.webhook.invalid_signature",
        integration: "calendly",
        tenantId: tenant.tenantId,
        reason: "invalid_signature",
        httpStatus: 401,
      },
    );
    return new Response("Invalid signature", { status: 401 });
  }

  const timestampNumber = Number.parseInt(timestamp, 10);
  if (Number.isNaN(timestampNumber)) {
    log.warn("calendly.webhook.rejected", {
      reason: "non_numeric_signature_timestamp",
      tenantId: tenant.tenantId,
      httpStatus: 401,
    });
    return new Response("Malformed signature", { status: 401 });
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestampNumber) > 180) {
    log.warn("calendly.webhook.rejected", {
      reason: "stale_timestamp",
      tenantId: tenant.tenantId,
      ageSeconds: Math.abs(now - timestampNumber),
      httpStatus: 401,
    });
    return new Response("Stale webhook", { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody) as unknown;
  } catch {
    log.warn("calendly.webhook.rejected", {
      reason: "invalid_json",
      tenantId: tenant.tenantId,
      httpStatus: 400,
    });
    return new Response("Invalid JSON payload", { status: 400 });
  }

  const eventType =
    isRecord(payload) && typeof payload.event === "string"
      ? payload.event
      : "unknown";
  const calendlyEventUri =
    getCalendlyEventUri(payload) ??
    `${eventType}:${isRecord(payload) && typeof payload.created_at === "string" ? payload.created_at : Date.now().toString()}`;

  const rawEventId = await ctx.runMutation(
    internal.webhooks.calendlyMutations.persistRawEvent,
    {
      tenantId: tenant.tenantId,
      calendlyEventUri,
      eventType,
      payload: rawBody,
    },
  );

  // persistRawEvent returns null when the same event was already stored.
  log.info("calendly.webhook.received", {
    tenantId: tenant.tenantId,
    eventType,
    rawEventId: rawEventId ?? undefined,
    duplicate: rawEventId === null,
    httpStatus: 200,
  });
  return new Response("OK", { status: 200 });
});
