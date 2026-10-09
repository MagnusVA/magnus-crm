import type { Instrumentation } from "next";

/**
 * Reports errors from server components, route handlers, server actions, and
 * the proxy to PostHog Error Tracking. Browser errors are captured by
 * posthog-js (`instrumentation-client.ts`); Convex errors arrive through the
 * log stream (`app/api/observability/convex/route.ts`).
 *
 * A Convex call that fails during a server render is already reported by the
 * backend, so it's recorded as a `convex_call_failed` event, not a second
 * issue. Expected `ConvexError`s are skipped.
 */
export const onRequestError: Instrumentation.onRequestError = async (
  error,
  request,
  context,
) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { getPostHogClient } = await import("./lib/posthog-server");
  const posthog = getPostHogClient();
  if (!posthog) return;

  const name = error instanceof Error ? error.name : undefined;
  if (name === "ConvexError") return;

  const { readPostHogCookie } = await import("./lib/observability/posthog-cookie");
  const cookieHeader = request.headers.cookie;
  const { distinctId, sessionId } = readPostHogCookie(
    Array.isArray(cookieHeader) ? cookieHeader.join("; ") : cookieHeader,
    process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN,
  );
  const digest =
    typeof error === "object" && error !== null && "digest" in error
      ? String(error.digest)
      : undefined;
  const properties = {
    $session_id: sessionId,
    environment: process.env.VERCEL_ENV ?? "production",
    next_route_path: context.routePath,
    next_route_type: context.routeType,
    next_router_kind: context.routerKind,
    next_render_source: context.renderSource,
    next_revalidate_reason: context.revalidateReason,
    // Matches `error.digest` in the browser's error boundary.
    next_digest: digest,
    request_path: request.path.split("?")[0],
    request_method: request.method,
    ...(distinctId ? {} : { $process_person_profile: false }),
  };

  const message = error instanceof Error ? error.message : String(error);
  const convexRequestId = /\[Request ID: ([\w-]+)\]/.exec(message)?.[1];
  if (convexRequestId) {
    posthog.capture({
      distinctId: distinctId ?? "next_server",
      event: "convex_call_failed",
      properties: {
        ...properties,
        error_origin: "next_server",
        convex_request_id: convexRequestId,
        convex_function: /\[CONVEX [QMA?]\(([^)]+)\)\]/.exec(message)?.[1],
      },
    });
    await posthog.flush();
    return;
  }

  await posthog.captureExceptionImmediate(error, distinctId, {
    ...properties,
    error_origin: "next_server",
  });
};
