import { internal } from "../_generated/api";
import { httpAction } from "../_generated/server";
import { log, logRequestContext, reportError } from "../lib/observability/log";
import { verifyWhopSignature } from "./signature";
import { webhookEnvelopeSchema, webhookObject, whopEventType, whopId } from "./whop/normalize";

export const handleWhopWebhook = httpAction(async (ctx, request) => {
  const connectionParam = new URL(request.url).searchParams.get("c");
  if (!connectionParam) return new Response("Unknown connection", { status: 404 });
  const connection = await ctx.runQuery(internal.payments.connectionState.connection, {
    connectionId: connectionParam,
  });
  if (!connection || connection.status === "disconnected")
    return new Response("Unknown connection", { status: 404 });
  logRequestContext({ tenantId: connection.tenantId });
  const attrs = { connectionId: connection._id, tenantId: connection.tenantId };

  const rawBody = new Uint8Array(await request.arrayBuffer());
  if (!(await verifyWhopSignature(connection, request.headers, rawBody))) {
    log.warn("whop.webhook.rejected", { ...attrs, reason: "invalid_signature", httpStatus: 401 });
    return new Response("Invalid signature", { status: 401 });
  }

  const webhookId = whopId.safeParse(request.headers.get("webhook-id")).data;
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    return new Response("Invalid webhook", { status: 400 });
  }
  const envelope = webhookEnvelopeSchema.safeParse(body);
  if (!webhookId || !envelope.success) return new Response("Invalid webhook", { status: 400 });
  if (envelope.data.account_id !== connection.accountId) {
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
  const rawBodyStorageId = await ctx.storage.store(new Blob([rawBody], { type: "application/json" }));
  try {
    const result = await ctx.runMutation(internal.payments.intake.receiveWebhook, {
      ...attrs,
      accountId: connection.accountId,
      connectedAt: connection.connectedAt,
      webhookId,
      eventType,
      ...webhookObject(eventType, envelope.data.data),
      bodySha256,
      rawBodyStorageId,
    });
    if (result === "unavailable") return new Response("Unknown connection", { status: 404 });
    log.info("whop.webhook.received", { ...attrs, webhookId, eventType, result });
    return new Response("OK", { status: 200 });
  } catch {
    await ctx.storage.delete(rawBodyStorageId);
    reportError("whop.webhook.intake_failed", new Error("Whop webhook intake failed"), {
      ...attrs, webhookId, integration: "whop",
    });
    return new Response("Retry webhook", { status: 503 });
  }
});
