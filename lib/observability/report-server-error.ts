import "server-only";
import { headers } from "next/headers";
import { after } from "next/server";
import { readPostHogCookie } from "@/lib/observability/posthog-cookie";
import { getPostHogClient } from "@/lib/posthog-server";

export type ReportServerErrorOptions = {
  /** Dotted, domain-first event name, e.g. `auth.callback.failed`. */
  event: string;
  /** Route handler request; otherwise the cookie is read through `headers()`. */
  request?: Request;
  /** Raw WorkOS user id when known; falls back to the posthog-js cookie. */
  distinctId?: string;
  /** Low-cardinality grouping key: enums and codes only, never ids or messages. */
  fingerprint?: string;
  /** The caller caused it (bad link, missing cookie). Not a bug. */
  expected?: boolean;
  /** Third-party system that failed, e.g. `workos`, `calendly`, `slack`. */
  integration?: string;
  severity?: "error" | "warning";
  [key: string]: unknown;
};

/**
 * Convex errors that already reached PostHog from the backend log stream,
 * with the real message and stack. Reporting them again from Next.js would
 * only duplicate the issue with a redacted message.
 */
function isReportedByConvex(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "ConvexError" || error.message.includes("[Request ID:");
}

async function readCookieHeader(request: Request | undefined): Promise<string | null> {
  if (request) return request.headers.get("cookie");
  try {
    return (await headers()).get("cookie");
  } catch {
    // Outside a request scope.
    return null;
  }
}

/**
 * Reports an error that Next.js server code caught and handled (a route
 * handler that redirects, a server action that returns an error state) to
 * PostHog Error Tracking. Uncaught errors are reported by `onRequestError`
 * in `instrumentation.ts`, so use this only where the error is swallowed.
 *
 * The capture is sent from `after()`, so it never delays a redirect or
 * response. Never pass PII, tokens, passwords, slugs, or IPs as attributes.
 */
export async function reportServerError(
  error: unknown,
  options: ReportServerErrorOptions,
): Promise<void> {
  try {
    if (isReportedByConvex(error)) return;
    const posthog = getPostHogClient();
    if (!posthog) return;

    const {
      event,
      request,
      distinctId: explicitDistinctId,
      fingerprint,
      expected = false,
      integration,
      severity,
      ...attrs
    } = options;

    const cookie = readPostHogCookie(
      await readCookieHeader(request),
      process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN,
    );
    const distinctId = explicitDistinctId ?? cookie.distinctId;

    const properties: Record<string, unknown> = {
      ...attrs,
      $session_id: cookie.sessionId,
      error_origin: "next_server_handled",
      handled_event: event,
      error_kind: expected ? "expected" : integration ? "integration" : "bug",
      $exception_level: severity ?? (expected ? "warning" : "error"),
      environment: process.env.VERCEL_ENV ?? "production",
      ...(fingerprint ? { $exception_fingerprint: fingerprint } : {}),
      ...(integration ? { integration } : {}),
      ...(distinctId ? {} : { $process_person_profile: false }),
    };

    const send = () => posthog.captureExceptionImmediate(error, distinctId, properties);
    try {
      after(send);
    } catch {
      // `after` is only available inside a request scope.
      send().catch(() => {});
    }
  } catch (reportFailure) {
    console.error("[observability] reportServerError failed", reportFailure);
  }
}
