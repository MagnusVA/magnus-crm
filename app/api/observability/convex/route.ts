import { NextResponse, type NextRequest } from "next/server";
import { PostHog } from "posthog-node";
import {
  parseLogStreamBody,
  transformLogStreamBatch,
  type LogStreamEvent,
} from "@/lib/observability/convex-log-stream";
import { OtlpSendError, sendOtlpLogs } from "@/lib/observability/otlp-logs";
import { isPostHogEnabled } from "@/lib/posthog-config";

/**
 * Receives the Convex webhook log stream and forwards it to PostHog:
 * console lines and notable executions become PostHog logs, failed
 * executions and `reportError` lines become Error Tracking exceptions, and
 * expected rejections become `convex_request_rejected` events.
 *
 * Returning 5xx makes Convex resend the batch, so the route does that only
 * when a retry can help. Events carry deterministic uuids, so a resent batch
 * doesn't create duplicate exceptions.
 *
 * Setup is in `docs/agents/observability.md`.
 */

export const maxDuration = 60;

/** Vercel rejects larger bodies before the handler runs; this guards self-hosting. */
const MAX_BODY_BYTES = 4_000_000;

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/** `x-webhook-signature: sha256=<hex HMAC-SHA256 of the raw body>`. */
async function verifySignature(
  body: string,
  header: string | null,
  secret: string,
): Promise<boolean> {
  const signature = header ? hexToBytes(header.replace(/^sha256=/, "").trim()) : null;
  if (!signature) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, signature, encoder.encode(body));
}

function serviceResource(events: LogStreamEvent[]) {
  const convex = events.find((event) => event.convex)?.convex;
  return {
    "service.name": "magnus-convex",
    "deployment.environment": convex?.deployment_type,
    "convex.deployment.name": convex?.deployment_name,
    "convex.project.slug": convex?.project_slug,
  };
}

/**
 * Waits for exceptions still being built, then sends everything, rejecting
 * if PostHog refused the batch. `flush()` alone skips exceptions whose
 * events aren't built yet, and `captureExceptionImmediate` swallows send
 * errors, so neither can tell the route to ask for a retry.
 */
async function flushAll(client: PostHog): Promise<void> {
  const withPending = (client as unknown as { flushWithPendingPromises?: () => Promise<void> })
    .flushWithPendingPromises;
  if (typeof withPending === "function") {
    await withPending.call(client);
  } else {
    await client.flush();
  }
}

export async function POST(request: NextRequest) {
  const secret = process.env.CONVEX_LOG_STREAM_SECRET;
  if (!secret) {
    console.error("[Observability:ConvexLogStream] CONVEX_LOG_STREAM_SECRET is not set");
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "too_large" }, { status: 413 });
  }

  const body = await request.text();
  if (!(await verifySignature(body, request.headers.get("x-webhook-signature"), secret))) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }

  let events: LogStreamEvent[];
  try {
    events = parseLogStreamBody(body);
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const projectToken = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;
  const host = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com";
  if (!isPostHogEnabled() || !projectToken) {
    // PostHog is off for this deployment; accept the batch so Convex doesn't retry it.
    return NextResponse.json({ accepted: events.length, forwarded: false });
  }

  const batch = transformLogStreamBatch(events);

  // One client per batch, so another request's failures can't fail this one.
  const posthog = new PostHog(projectToken, {
    host,
    flushAt: 1_000,
    flushInterval: 0,
    fetchRetryCount: 1,
    requestTimeout: 10_000,
    disableGeoip: true,
  });
  for (const exception of batch.exceptions) {
    const error = new Error(exception.error.message);
    error.name = exception.error.name;
    if (exception.error.stack) error.stack = exception.error.stack;
    posthog.captureException(error, exception.distinctId, exception.properties, exception.uuid);
  }
  for (const event of batch.events) {
    posthog.capture({
      uuid: event.uuid,
      distinctId: event.distinctId,
      event: event.event,
      timestamp: event.timestamp,
      properties: event.properties,
    });
  }

  const [captureResult, logsResult] = await Promise.allSettled([
    flushAll(posthog),
    batch.logs.length > 0
      ? sendOtlpLogs({ host, projectToken }, serviceResource(events), batch.logs)
      : Promise.resolve(),
  ]);

  let retry = false;
  if (captureResult.status === "rejected") {
    retry = true;
    console.error("[Observability:ConvexLogStream] exception capture failed", {
      exceptions: batch.exceptions.length,
      events: batch.events.length,
      reason: String(captureResult.reason),
    });
  }
  if (logsResult.status === "rejected") {
    const permanent = logsResult.reason instanceof OtlpSendError && logsResult.reason.permanent;
    // A permanent logs failure (Logs disabled, quota) must not make Convex
    // resend exceptions that already went out.
    retry ||= !permanent;
    console.error("[Observability:ConvexLogStream] logs forwarding failed", {
      logs: batch.logs.length,
      permanent,
      reason: String(logsResult.reason),
    });
  }
  if (retry) {
    return NextResponse.json({ error: "forward_failed" }, { status: 502 });
  }

  return NextResponse.json({
    accepted: events.length,
    logs: batch.logs.length,
    exceptions: batch.exceptions.length,
    events: batch.events.length,
  });
}
