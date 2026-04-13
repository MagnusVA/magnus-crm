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
  console.log(`[Webhook] Request received: tenantId=${tenantIdParam}, method=${req.method}`);

  if (!tenantIdParam) {
    console.warn("[Webhook] Missing tenantId query parameter");
    return new Response("Missing tenantId", { status: 400 });
  }

  const rawBody = await req.text();

  const tenant = await ctx.runQuery(internal.webhooks.calendlyQueries.getTenantSigningKey, {
    tenantId: tenantIdParam,
  });
  if (!tenant) {
    console.warn(`[Webhook] Unknown tenant: ${tenantIdParam}`);
    return new Response("Unknown tenant", { status: 404 });
  }

  const signatureHeader = req.headers.get("Calendly-Webhook-Signature");
  if (!signatureHeader) {
    console.warn(`[Webhook] Missing Calendly-Webhook-Signature header for tenant ${tenantIdParam}`);
    return new Response("Missing signature", { status: 401 });
  }

  const { timestamp, signature } = parseSignatureHeader(signatureHeader);
  if (!timestamp || !signature) {
    console.warn(`[Webhook] Malformed signature header for tenant ${tenantIdParam}`);
    return new Response("Malformed signature", { status: 401 });
  }

  const expectedSignature = await createSignature(
    tenant.webhookSecret,
    `${timestamp}.${rawBody}`,
  );
  if (!timingSafeEqualHex(expectedSignature, signature)) {
    console.error(`[Webhook] Invalid signature for tenant ${tenantIdParam}`);
    return new Response("Invalid signature", { status: 401 });
  }

  const timestampNumber = Number.parseInt(timestamp, 10);
  if (Number.isNaN(timestampNumber)) {
    console.warn(`[Webhook] Non-numeric timestamp in signature for tenant ${tenantIdParam}`);
    return new Response("Malformed signature", { status: 401 });
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestampNumber) > 180) {
    console.warn(`[Webhook] Stale webhook for tenant ${tenantIdParam}: age=${Math.abs(now - timestampNumber)}s`);
    return new Response("Stale webhook", { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody) as unknown;
    console.log(`[Webhook] JSON parsed successfully for tenant ${tenantIdParam}`);
  } catch {
    console.error(`[Webhook] JSON parse failed for tenant ${tenantIdParam}`);
    return new Response("Invalid JSON payload", { status: 400 });
  }

  const eventType =
    isRecord(payload) && typeof payload.event === "string"
      ? payload.event
      : "unknown";
  const calendlyEventUri =
    getCalendlyEventUri(payload) ??
    `${eventType}:${isRecord(payload) && typeof payload.created_at === "string" ? payload.created_at : Date.now().toString()}`;

  console.log(`[Webhook] Event extracted: type=${eventType}, uri=${calendlyEventUri}`);

  await ctx.runMutation(internal.webhooks.calendlyMutations.persistRawEvent, {
    tenantId: tenant.tenantId,
    calendlyEventUri,
    eventType,
    payload: rawBody,
  });

  console.log(`[Webhook] Persist mutation triggered for tenant ${tenantIdParam}, type=${eventType}`);
  console.log(`[Webhook] Responding 200 OK`);
  return new Response("OK", { status: 200 });
});
