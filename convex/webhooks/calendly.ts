import type { Id } from "../_generated/dataModel";
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";

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

function getCalendlyEventUri(payload: Record<string, unknown>) {
  const payloadBody =
    payload.payload && typeof payload.payload === "object"
      ? (payload.payload as Record<string, unknown>)
      : undefined;

  const uriCandidates = [
    payloadBody?.uri,
    payloadBody?.event &&
    typeof payloadBody.event === "object" &&
    payloadBody.event !== null
      ? (payloadBody.event as Record<string, unknown>).uri
      : undefined,
    payloadBody?.invitee &&
    typeof payloadBody.invitee === "object" &&
    payloadBody.invitee !== null
      ? (payloadBody.invitee as Record<string, unknown>).uri
      : undefined,
    payloadBody?.scheduled_event &&
    typeof payloadBody.scheduled_event === "object" &&
    payloadBody.scheduled_event !== null
      ? (payloadBody.scheduled_event as Record<string, unknown>).uri
      : undefined,
  ];

  return uriCandidates.find((candidate): candidate is string => {
    return typeof candidate === "string" && candidate.length > 0;
  });
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
    return new Response("Missing tenantId", { status: 400 });
  }

  const rawBody = await req.text();

  const tenant = await ctx.runQuery(internal.webhooks.calendlyQueries.getTenantSigningKey, {
    tenantId: tenantIdParam,
  });
  if (!tenant) {
    return new Response("Unknown tenant", { status: 404 });
  }

  const signatureHeader = req.headers.get("Calendly-Webhook-Signature");
  if (!signatureHeader) {
    return new Response("Missing signature", { status: 401 });
  }

  const { timestamp, signature } = parseSignatureHeader(signatureHeader);
  if (!timestamp || !signature) {
    return new Response("Malformed signature", { status: 401 });
  }

  const expectedSignature = await createSignature(
    tenant.webhookSigningKey,
    `${timestamp}.${rawBody}`,
  );
  if (!timingSafeEqualHex(expectedSignature, signature)) {
    return new Response("Invalid signature", { status: 401 });
  }

  const timestampNumber = Number.parseInt(timestamp, 10);
  if (Number.isNaN(timestampNumber)) {
    return new Response("Malformed signature", { status: 401 });
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestampNumber) > 180) {
    return new Response("Stale webhook", { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return new Response("Invalid JSON payload", { status: 400 });
  }

  const eventType =
    typeof payload.event === "string" ? payload.event : "unknown";
  const calendlyEventUri =
    getCalendlyEventUri(payload) ??
    `${eventType}:${typeof payload.created_at === "string" ? payload.created_at : Date.now().toString()}`;

  await ctx.runMutation(internal.webhooks.calendlyMutations.persistRawEvent, {
    tenantId: tenant.tenantId as Id<"tenants">,
    calendlyEventUri,
    eventType,
    payload: rawBody,
  });

  return new Response("OK", { status: 200 });
});
