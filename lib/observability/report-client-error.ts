import { ConvexError } from "convex/values";
import posthog from "posthog-js";
import { isPostHogEnabled } from "@/lib/posthog-config";

export type ClientErrorContext = {
  /** Stable, snake_case name of the user flow, e.g. `payment_proof_upload`. */
  flow: string;
  /** HTTP status of the failed request, when the failure was a response. */
  httpStatus?: number;
  /** Ids and enums only. Never emails, names, free text, tokens, or URLs. */
  [key: string]: unknown;
};

/**
 * Reports a browser-side failure that the UI caught and turned into a toast
 * or an error state, so it still reaches PostHog Error Tracking.
 *
 * `ConvexError`s are skipped: they're expected rejections the backend
 * already counts as `convex_request_rejected`. Other Convex errors are kept
 * for their session replay; `convexExceptionBeforeSend` tags them with the
 * function and request id that match the backend issue.
 */
export function reportClientError(error: unknown, context: ClientErrorContext): void {
  if (error instanceof ConvexError) return;
  if (!isPostHogEnabled()) return;

  const { flow, httpStatus, ...attrs } = context;
  try {
    posthog.captureException(error, {
      ...attrs,
      error_origin: "client_flow",
      flow,
      ...(httpStatus !== undefined ? { http_status: httpStatus } : {}),
    });
  } catch {
    // Reporting must never break the UI flow that caught the error.
  }
}

/**
 * Start of the message Next.js substitutes for Server Component errors in
 * production builds (see `error.message` in the `error.js` docs).
 */
const REDACTED_SERVER_ERROR_PREFIX = "An error occurred in the Server Components render";

/**
 * Reports an error that reached a Next.js `error.js` / `global-error.js`
 * boundary.
 *
 * A Server Component error arrives here redacted, with only a digest. The
 * real error, with its message and stack, was already captured on the server
 * by `onRequestError`, so this records that the boundary was shown, keyed by
 * the same `next_digest`, instead of a second, message-less exception.
 */
export function reportErrorBoundary(
  error: Error & { digest?: string },
  options: { boundary: string; origin?: string },
): void {
  if (!isPostHogEnabled()) return;
  try {
    if (error.digest && error.message.startsWith(REDACTED_SERVER_ERROR_PREFIX)) {
      posthog.capture("error_boundary_shown", {
        boundary: options.boundary,
        next_digest: error.digest,
      });
      return;
    }
    posthog.captureException(error, {
      error_origin: options.origin ?? "next_error_boundary",
      error_boundary: options.boundary,
      next_digest: error.digest,
    });
  } catch {
    // Reporting must never break the fallback UI.
  }
}
