import { internal } from "../_generated/api";
import { httpAction } from "../_generated/server";
import { log, logRequestContext, reportError } from "../lib/observability/log";
import { INVALID_SIGNATURE_WARNING_INTERVAL_MS } from "./connectionState";
import { prepareWhopSignature, verifyPreparedWhopSignature } from "./signature";
import { webhookEnvelopeSchema, webhookObject, whopEventType, whopId } from "./whop/normalize";

const MAX_WEBHOOK_BYTES = 256 * 1024;

async function readCappedBody(request: Request) {
  const length = request.headers.get("content-length");
  if (length !== null && Number(length) > MAX_WEBHOOK_BYTES) return null;
  const bytes = new Uint8Array(MAX_WEBHOOK_BYTES);
  const reader = request.body?.getReader();
  let offset = 0;
  if (reader) {
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (chunk.value.byteLength > bytes.length - offset) {
          await reader.cancel();
          return null;
        }
        bytes.set(chunk.value, offset);
        offset += chunk.value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
  }
  return bytes.subarray(0, offset);
}

export const handleWhopWebhook = httpAction(async (ctx, request) => {
  const connectionParam = new URL(request.url).searchParams.get("c");
  if (!connectionParam) return new Response("Unknown connection", { status: 404 });
  const connection = await ctx.runQuery(internal.payments.connectionState.connection, {
    connectionId: connectionParam,
  });
  if (!connection || connection.status === "disconnected")
    return new Response("Unknown connection", { status: 404 });
  const attrs = { connectionId: connection._id, tenantId: connection.tenantId };

  const invalidSignature = async () => {
    if (Date.now() - (connection.lastInvalidSignatureWarningAt ?? -Infinity) >=
        INVALID_SIGNATURE_WARNING_INTERVAL_MS) {
      const sampled = await ctx.runMutation(internal.payments.connectionState.sampleInvalidSignature, {
        connectionId: connection._id,
      });
      if (sampled) {
        log.warn("whop.webhook.rejected", { ...attrs, reason: "invalid_signature", httpStatus: 401 });
      }
    }
    return new Response("Invalid signature", { status: 401 });
  };
  const signature = prepareWhopSignature(connection, request.headers);
  if (!signature) return invalidSignature();
  const rawBody = await readCappedBody(request);
  if (!rawBody) return new Response("Webhook too large", { status: 413 });
  if (!(await verifyPreparedWhopSignature(signature, rawBody))) return invalidSignature();
  logRequestContext({ tenantId: connection.tenantId });

  const webhookId = whopId.safeParse(signature.id).data;
  let body: unknown;
  let rawText: string;
  try {
    rawText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(rawBody);
    body = JSON.parse(rawText);
  } catch {
    return new Response("Invalid webhook", { status: 400 });
  }
  const envelope = webhookEnvelopeSchema.safeParse(body);
  if (!webhookId || !envelope.success) return new Response("Invalid webhook", { status: 400 });
  const { account_id: accountId, company_id: companyId } = envelope.data;
  if ((accountId === undefined ? companyId : accountId) !== connection.accountId ||
      (companyId !== undefined && companyId !== connection.accountId)) {
    log.warn("whop.webhook.rejected", { ...attrs, reason: "account_mismatch", httpStatus: 401 });
    return new Response("Account mismatch", { status: 401 });
  }

  if (await ctx.runQuery(internal.payments.intake.hasReceipt, { ...attrs, webhookId })) {
    log.info("whop.webhook.duplicate", { ...attrs, webhookId });
    return new Response("OK", { status: 200 });
  }

  const eventType = whopEventType.safeParse(envelope.data.type).data ?? "unknown";
  const bodySha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", rawBody)),
    (byte) => byte.toString(16).padStart(2, "0")).join("");
  try {
    const result = await ctx.runMutation(internal.payments.intake.receiveWebhook, {
      ...attrs,
      accountId: connection.accountId,
      connectedAt: connection.connectedAt,
      webhookId,
      eventType,
      ...webhookObject(eventType, envelope.data.data),
      bodySha256,
      rawBody: rawText,
    });
    if (result === "unavailable") return new Response("Unknown connection", { status: 404 });
    log.info("whop.webhook.received", { ...attrs, webhookId, eventType, result });
    return new Response("OK", { status: 200 });
  } catch {
    reportError("whop.webhook.intake_failed", new Error("Whop webhook intake failed"), {
      ...attrs, webhookId, integration: "whop",
    });
    return new Response("Retry webhook", { status: 503 });
  }
});
