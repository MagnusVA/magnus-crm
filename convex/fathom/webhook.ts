import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { log, logRequestContext } from "../lib/observability/log";
import type { Id } from "../_generated/dataModel";

// Standard Webhooks scheme and five-minute tolerance: https://developers.fathom.ai/webhooks
export async function verifyFathomSignature(
  secret: string,
  headers: Headers,
  body: string,
  now = Date.now(),
): Promise<boolean> {
  const id = headers.get("webhook-id"),
    stamp = headers.get("webhook-timestamp"),
    signatures = headers.get("webhook-signature");
  if (
    !id ||
    !stamp ||
    !/^\d+$/.test(stamp) ||
    !signatures ||
    !secret.startsWith("whsec_") ||
    Math.abs(Math.floor(now / 1000) - Number(stamp)) > 300
  )
    return false;
  try {
    const bytes = Uint8Array.from(atob(secret.slice(6)), (c) =>
      c.charCodeAt(0),
    );
    const key = await crypto.subtle.importKey(
      "raw",
      bytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const content = new TextEncoder().encode(`${id}.${stamp}.${body}`);
    for (const signature of signatures.split(/\s+/)) {
      const [version, encoded] = signature.split(",");
      if (version !== "v1" || !encoded) continue;
      let decoded: Uint8Array<ArrayBuffer>;
      try {
        decoded = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
      } catch {
        continue;
      }
      if (await crypto.subtle.verify("HMAC", key, decoded, content))
        return true;
    }
  } catch {
    return false;
  }
  return false;
}
export const handleFathomWebhook = httpAction(async (ctx, request) => {
  const id = new URL(request.url).searchParams.get("c");
  if (!id) return new Response("Missing connection", { status: 400 });
  let connection;
  try {
    connection = await ctx.runQuery(internal.fathom.state.connection, {
      connectionId: id as Id<"tenantFathomConnections">,
    });
  } catch {
    return new Response("Unknown connection", { status: 404 });
  }
  if (!connection?.webhookSecret || connection.connectionStatus !== "connected")
    return new Response("Unknown connection", { status: 404 });
  logRequestContext({ tenantId: connection.tenantId });
  const body = await request.text();
  if (
    !(await verifyFathomSignature(
      connection.webhookSecret,
      request.headers,
      body,
    ))
  ) {
    log.warn("fathom.webhook.rejected", {
      tenantId: connection.tenantId,
      reason: "invalid_signature",
    });
    return new Response("Invalid signature", { status: 401 });
  }
  // Store raw content outside the 1 MiB document limit, including large transcripts.
  const storageId = await ctx.storage.store(
    new Blob([body], { type: "application/json" }),
  );
  const accepted = await ctx.runMutation(internal.fathom.processor.ingest, {
    connectionId: connection._id,
    webhookMessageId: request.headers.get("webhook-id")!,
    payloadStorageId: storageId,
  });
  if (!accepted) await ctx.storage.delete(storageId);
  return new Response("OK", { status: 200 });
});
