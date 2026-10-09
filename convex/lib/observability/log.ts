/**
 * Structured logging for Convex functions.
 *
 * Each call writes one console line shaped `[obs] <event> <json>`. The Convex
 * log stream forwards console lines to the Next.js ingest route
 * (`app/api/observability/convex/route.ts`), which parses these lines into
 * PostHog logs with typed attributes, turns `reportError` lines into PostHog
 * Error Tracking exceptions, and uses `request.context` lines to attribute a
 * request's failures to the signed-in user and tenant.
 *
 * Plain `console.*` calls still reach PostHog as unstructured logs; use this
 * module when a line marks a step in a process or a failure someone should
 * triage. The format contract lives in `lib/observability/convex-log-format.ts`.
 */

export const OBS_LOG_MARKER = "[obs]";

export type ObsLevel = "debug" | "info" | "warn" | "error";

export type ObsAttributes = Record<string, unknown>;

/** Who a request runs as. Logged once per request by the auth helpers. */
export type ObsRequestContext = {
  /** Raw WorkOS user id (`user_…`), the PostHog distinct id. */
  distinctId?: string;
  tenantId?: string;
  /** WorkOS organization id, the PostHog `company` group key. */
  workosOrgId?: string;
  userId?: string;
  role?: string;
};

export type ReportErrorOptions = ObsAttributes & {
  /**
   * `error` for failures someone should fix; `warning` for degraded behavior
   * the code recovered from (a dropped webhook, a stale token fallback).
   */
  severity?: "error" | "warning";
  /** Stable grouping key. Defaults to the event name plus the error name. */
  fingerprint?: string;
  /** Third-party system involved, e.g. `calendly`, `slack`, `workos`. */
  integration?: string;
};

const MAX_STRING_LENGTH = 2_000;
const MAX_STACK_LENGTH = 4_000;

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function sanitize(value: unknown, depth = 0): unknown {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string") return truncate(value, MAX_STRING_LENGTH);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) return describeError(value);
  if (depth >= 3) return "[depth]";
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitize(item, depth + 1));
  }
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value).slice(0, 50)) {
      const sanitized = sanitize(entry, depth + 1);
      if (sanitized !== undefined) result[key] = sanitized;
    }
    return result;
  }
  return String(value);
}

export type DescribedError = {
  name: string;
  message: string;
  stack?: string;
  /** `ConvexError` data code, when the error carries one. */
  code?: string;
};

export function describeError(error: unknown): DescribedError {
  if (error instanceof Error) {
    const data = (error as { data?: unknown }).data;
    const code =
      typeof data === "object" && data !== null && "code" in data
        ? String((data as { code: unknown }).code)
        : undefined;
    return {
      name: error.name,
      message: truncate(error.message, MAX_STRING_LENGTH),
      stack: error.stack ? truncate(error.stack, MAX_STACK_LENGTH) : undefined,
      code,
    };
  }
  if (typeof error === "string") {
    return { name: "Error", message: truncate(error, MAX_STRING_LENGTH) };
  }
  return { name: "Error", message: truncate(String(error), MAX_STRING_LENGTH) };
}

function write(level: ObsLevel, event: string, attrs: ObsAttributes | undefined) {
  let payload: string;
  try {
    payload = JSON.stringify(sanitize(attrs ?? {}));
  } catch {
    payload = JSON.stringify({ serializationFailed: true });
  }
  const line = `${OBS_LOG_MARKER} ${event} ${payload}`;
  switch (level) {
    case "debug":
      console.debug(line);
      break;
    case "info":
      console.info(line);
      break;
    case "warn":
      console.warn(line);
      break;
    case "error":
      console.error(line);
      break;
  }
}

/**
 * Event names are dotted, lowercase, and start with the domain:
 * `calendly.webhook.rejected`, `pipeline.event.processed`.
 */
export const log = {
  debug: (event: string, attrs?: ObsAttributes) => write("debug", event, attrs),
  info: (event: string, attrs?: ObsAttributes) => write("info", event, attrs),
  warn: (event: string, attrs?: ObsAttributes) => write("warn", event, attrs),
  error: (event: string, attrs?: ObsAttributes) => write("error", event, attrs),
};

/**
 * Report a failure the code caught and handled, so it shows up in PostHog
 * Error Tracking even though the function itself succeeds.
 *
 * Uncaught errors don't need this: the ingest route reports every failed
 * function execution. Call it where an error is swallowed, converted into a
 * status field, or retried later, so the failure doesn't disappear.
 */
export function reportError(
  event: string,
  error: unknown,
  options: ReportErrorOptions = {},
) {
  const { severity = "error", fingerprint, integration, ...attrs } = options;
  write(severity === "warning" ? "warn" : "error", event, {
    ...attrs,
    obs_kind: "exception",
    severity,
    fingerprint,
    integration,
    error: describeError(error),
  });
}

/**
 * Record who the current request runs as. The ingest route attaches this to
 * every log line and failure that shares the request id.
 */
export function logRequestContext(context: ObsRequestContext) {
  write("debug", "request.context", { obs_kind: "context", ...context });
}
