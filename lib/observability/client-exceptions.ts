import type { CaptureResult } from "posthog-js";

/**
 * `before_send` hook that keeps browser Error Tracking to real client bugs.
 *
 * Convex calls: the Convex client rethrows backend failures as
 * `[CONVEX M(module:fn)] [Request ID: abc] Server Error`. The backend
 * failure is already reported, classified, and attributed by the log stream
 * ingest, so the browser copy isn't an exception:
 *
 * - expected errors (`ConvexError`) are dropped; the backend counts them;
 * - lost connections are dropped; they're network noise with no backend twin;
 * - everything else becomes a `convex_call_failed` event carrying the
 *   function and request id. Find the backend issue by `convex_request_id`,
 *   and the session replay from this event.
 *
 * Browser noise (deploy chunk skew, ResizeObserver, aborted fetches, offline
 * network errors, Next's redacted server-render errors) is dropped or grouped.
 */
const CONVEX_ERROR = /\[CONVEX ([QMA?])\(([^)]+)\)\](?: \[Request ID: ([\w-]+)\])?/;

const FUNCTION_TYPES: Record<string, string> = {
  Q: "query",
  M: "mutation",
  A: "action",
  "?": "unknown",
};

type ExceptionEntry = { type?: string; value?: string };

/** Exceptions that are never actionable. Matched on type and message. */
const DROP_RULES: Array<(type: string, value: string) => boolean> = [
  // Deploy skew: the page asks for chunks from a build that's gone.
  (type, value) =>
    type === "ChunkLoadError" ||
    /^(Failed to load chunk \/_next\/|Loading (CSS )?chunk .* failed|Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module)/.test(value),
  (_type, value) =>
    value.startsWith("ResizeObserver loop completed with undelivered notifications") ||
    value.startsWith("ResizeObserver loop limit exceeded"),
  (type) => type === "AbortError",
  (_type, value) => value === "Script error." || value === "Script error",
  (_type, value) => value.startsWith("Non-Error promise rejection captured with value: undefined"),
  // The server copy, with the real message, comes from `onRequestError`.
  (_type, value) => value.startsWith("An error occurred in the Server Components render"),
  // React #419: a server Suspense boundary failed; reported on the server.
  (_type, value) => /Minified React error #419\b/.test(value),
  (_type, value) => value.includes("Connection lost while action was in flight"),
];

const NETWORK_ERROR =
  /^(Failed to fetch|NetworkError when attempting to fetch resource\.?|Load failed|Network request failed)$/;

function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

export function convexExceptionBeforeSend(
  event: CaptureResult | null,
): CaptureResult | null {
  if (!event || event.event !== "$exception") return event;

  const list = event.properties.$exception_list as ExceptionEntry[] | undefined;
  const first = Array.isArray(list) ? list[0] : undefined;
  const type = first?.type ?? "";
  const value = first?.value ?? String(event.properties.$exception_message ?? "");

  if (DROP_RULES.some((rule) => rule(type, value))) return null;

  if (type === "TypeError" && NETWORK_ERROR.test(value)) {
    if (isOffline()) return null;
    event.properties.$exception_fingerprint ??= "network:fetch_failed";
    event.properties.error_kind = "network";
    return event;
  }

  const hydration = /Minified React error #(418|423|425)\b/.exec(value);
  if (hydration) {
    event.properties.$exception_fingerprint ??= `react-hydration:${hydration[1]}`;
    return event;
  }

  if (value.includes("Failed to find Server Action")) {
    event.properties.$exception_fingerprint ??= "next:server-action-skew";
    return event;
  }

  const match = CONVEX_ERROR.exec(value);
  if (!match) return event;

  if (type === "ConvexError") return null;

  const [, prefix, functionPath, requestId] = match;
  const properties = { ...event.properties };
  for (const key of Object.keys(properties)) {
    if (key.startsWith("$exception")) delete properties[key];
  }
  return {
    ...event,
    event: "convex_call_failed",
    properties: {
      ...properties,
      error_origin: "convex_client",
      convex_function: functionPath,
      convex_function_type: FUNCTION_TYPES[prefix],
      convex_request_id: requestId,
    },
  };
}
