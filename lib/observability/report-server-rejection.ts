import "server-only";
import { after, userAgent } from "next/server";
import { readPostHogCookie } from "@/lib/observability/posthog-cookie";
import { requestHost } from "@/lib/observability/request-host";
import { getPostHogClient } from "@/lib/posthog-server";

/** The Next.js counterpart of the Convex ingest's `convex_request_rejected`. */
export const SERVER_REJECTION_EVENT = "next_request_rejected";

type SafeAttribute = string | number | boolean | undefined;

export type ReportServerRejectionOptions = {
  /** Dotted, domain-first name of what was rejected, e.g. `auth.callback.failed`. */
  event: string;
  request: Request;
  /** Stable machine code for the cause. Never a message. */
  code: string;
  /** Third-party system involved, e.g. `workos`. */
  integration?: string;
  /** Enums, counts and flags only. Never ids, tokens, URLs or free text. */
  attrs?: Record<string, SafeAttribute>;
};

/**
 * Records a request the caller caused to fail (an expired or replayed link, a
 * missing cookie) as a `next_request_rejected` event. Unlike
 * `reportServerError` it never opens an Error Tracking issue, and it sends
 * no error object, message, URL or user agent string: only the code, the
 * host, the browser, OS and device families, and the attributes passed in.
 *
 * Use it where the code decides the cause from an allowlist. Anything else
 * stays an exception through `reportServerError`.
 */
export async function reportServerRejection(
  options: ReportServerRejectionOptions,
): Promise<void> {
  try {
    const posthog = getPostHogClient();
    if (!posthog) return;

    const { event, request, code, integration, attrs } = options;
    const cookie = readPostHogCookie(
      request.headers.get("cookie"),
      process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN,
    );
    const { browser, os, device } = userAgent({ headers: request.headers });

    const properties: Record<string, unknown> = {
      ...attrs,
      $session_id: cookie.sessionId,
      error_origin: "next_server_handled",
      handled_event: event,
      error_kind: "expected",
      error_code: code,
      environment: process.env.VERCEL_ENV ?? "production",
      request_host: requestHost(request),
      browser_family: browser.name ?? "unknown",
      os_family: os.name ?? "unknown",
      device_type: device.type ?? "desktop",
      ...(integration ? { integration } : {}),
      ...(cookie.distinctId ? {} : { $process_person_profile: false }),
    };
    const distinctId = cookie.distinctId ?? crypto.randomUUID();

    const send = () =>
      posthog.captureImmediate({ distinctId, event: SERVER_REJECTION_EVENT, properties });
    try {
      after(send);
    } catch {
      // `after` is only available inside a request scope.
      send().catch(() => {});
    }
  } catch (reportFailure) {
    console.error("[observability] reportServerRejection failed", reportFailure);
  }
}
