/**
 * How backend failures are triaged. This file decides which Convex errors
 * become PostHog Error Tracking issues and which are recorded as expected
 * rejections.
 *
 * - `bug`: the code is wrong. Reported as an exception.
 * - `integration`: a third-party API (Calendly, Slack, WorkOS) failed.
 *   Reported, tagged with the integration, and grouped by integration and
 *   HTTP status.
 * - `platform`: a Convex limit or timeout. Reported; the fix is usually a
 *   query or index change. Write conflicts are logged, not reported, since
 *   Convex retries them.
 * - `expected`: the caller caused it (signed out, no access, stale id,
 *   invalid input). Not an exception: logged as a warning and counted as a
 *   `convex_request_rejected` event, whose `error_rule` you can alert on.
 *
 * New code marks expected errors explicitly with `expectedError` /
 * `rejectRequest` (`convex/lib/observability/errors.ts`). The rules below
 * classify older `throw new Error(...)` sites, and only when a client made
 * the call: the same message from a cron or a scheduled job is a bug. When a
 * PostHog issue turns out to be expected, convert the throw to
 * `rejectRequest` or add a rule here, then resolve the issue.
 */

export type ErrorKind = "bug" | "integration" | "platform" | "expected";

export type ErrorClassification = {
  kind: ErrorKind;
  /** Which rule matched, for debugging the rules themselves. */
  rule: string;
  /** Dotted code, from `ConvexError` data or the matching rule. */
  code?: string;
  integration?: string;
  /** Overrides the default fingerprint. */
  fingerprint?: string;
};

export type FailureInput = {
  functionPath: string;
  errorName: string;
  errorMessage: string;
  /** Whether a browser or server render started the request (see `isClientRunReason`). */
  fromClient: boolean;
  /** `ConvexError` data code, or a `request.rejected` code logged by the request. */
  code?: string;
};

/** Run reasons that mean a signed-in browser or server render made the call. */
const CLIENT_RUN_REASONS = new Set([
  "initialSubscription",
  "dataChange",
  "identityChange",
  "webSocket",
  "httpApi",
]);

export function isClientRunReason(runReason: string | undefined): boolean {
  return runReason !== undefined && CLIENT_RUN_REASONS.has(runReason);
}

const PLATFORM_RULES: Array<{ id: string; pattern: RegExp; code: string }> = [
  {
    id: "platform.limits",
    pattern: /Too many (reads|documents|bytes|writes|function calls|index ranges)|exceeded .*limit/i,
    code: "convex.limit_exceeded",
  },
  {
    id: "platform.timeout",
    pattern: /Function execution timed out|Your request timed out|out of memory/i,
    code: "convex.timeout",
  },
];

const VENDOR = /\b(calendly|slack|workos)\b/i;
/** `HTTP 401`, `status 401`, `status: 401`, `failed: 401`, `http_401`. */
const HTTP_STATUS = /(?:\bHTTP\s*|\bstatus:?\s*|failed:\s*|\bhttp_)([1-5]\d\d)\b/i;
const API_FAILURE = /\b(API|request) (failed|error)\b/i;

/** Exact messages older auth checks throw. */
const AUTH_MESSAGES =
  /^(Not authenticated|Not authorized|Access denied|Insufficient permissions|Organization mismatch|No organization context|User account is inactive|User not found — please complete setup)\.?$/;

/** Records a user can reach by id from a page; anything else missing is a bug. */
const NAVIGABLE_NOT_FOUND =
  /^(Opportunity|Meeting|Lead|Customer|Payment|Reminder|Follow-up|Program|Event type configuration|Unavailability record|DM closer|DM team|Attribution team|Campaign preset|Worker|Lead-gen worker|Report job|Report artifact|Comment|Team|Submission|Prospect|Selected lead|Target lead|Source lead|User|Linked user|Closer) not found\.?$/;

const VALIDATION =
  /must be|is required|cannot be empty|exceeds|or fewer|is invalid|^Invalid |too large\. Narrow the filters|is not pending|is no longer|already (exists|been|recorded|linked)/i;

const STATE_TRANSITION = /^Cannot .* from status|Invalid (status )?transition|only accepts|^Only /i;

/**
 * Validation-shaped messages that are really invariants or configuration
 * errors. An environment variable name in a message always means config.
 */
const NOT_VALIDATION =
  /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b|^Invalid (business date weekday|base64url|Calendly webhook URI|export checkpoint|report metric key)|^Only void aggregate corrections/;

type ExpectedRule = { id: string; code: string; matches: (message: string) => boolean };

const EXPECTED_RULES: ExpectedRule[] = [
  { id: "expected.auth", code: "auth.legacy", matches: (m) => AUTH_MESSAGES.test(m) },
  {
    id: "expected.ownership",
    code: "auth.not_owner",
    matches: (m) => /^(Not your \w+|You are not the assigned closer)/.test(m),
  },
  {
    id: "expected.portal_session",
    code: "auth.portal_session",
    matches: (m) => /^(Portal session is no longer valid|Invalid portal session|Set a portal password first|Lead Gen Ops access is not active)/.test(m),
  },
  { id: "expected.not_found", code: "request.not_found", matches: (m) => NAVIGABLE_NOT_FOUND.test(m) },
  {
    id: "expected.validation",
    code: "request.invalid",
    matches: (m) => VALIDATION.test(m) && !NOT_VALIDATION.test(m),
  },
  {
    id: "expected.state_transition",
    code: "request.invalid_state",
    matches: (m) => STATE_TRANSITION.test(m) && !NOT_VALIDATION.test(m),
  },
];

/** Strip ids, numbers, and quoted values so one bug maps to one issue. */
export function normalizeErrorMessage(message: string): string {
  return message
    .split("\n")[0]
    .slice(0, 500)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/\b[a-z]+_[0-9A-Z]{26}\b/g, "<ulid>")
    .replace(/\b[a-z0-9]{31,32}\b/g, "<id>")
    .replace(/\b[0-9a-f]{8,}\b/gi, "<hex>")
    .replace(/[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,8}/g, "<email>")
    .replace(/https?:\/\/[^\s"`]+/g, "<url>")
    .replace(/"[^"\n]*"|`[^`\n]*`/g, "<value>")
    .replace(/\d+(\.\d+)?/g, "<n>")
    .slice(0, 200);
}

export function classifyFailure(input: FailureInput): ErrorClassification {
  if (input.code) {
    return { kind: "expected", rule: "expected.coded", code: input.code };
  }
  // By convention a `ConvexError` is a deliberate, user-facing rejection.
  if (input.errorName === "ConvexError") {
    return { kind: "expected", rule: "expected.convex_error", code: "convex_error" };
  }

  const message = input.errorMessage;

  for (const rule of PLATFORM_RULES) {
    if (rule.pattern.test(message)) {
      return {
        kind: "platform",
        rule: rule.id,
        code: rule.code,
        fingerprint: `convex:${rule.code}:${input.functionPath}`,
      };
    }
  }

  // Before the expected rules: a vendor's response text often reads like
  // validation ("must be a valid URI") or a missing record ("404 Not Found").
  const vendor = VENDOR.exec(message)?.[1]?.toLowerCase();
  if (vendor) {
    const status = HTTP_STATUS.exec(message);
    if (status || API_FAILURE.test(message)) {
      const code = status ? (status[1] ?? "unknown") : "unknown";
      return {
        kind: "integration",
        rule: `integration.${vendor}`,
        integration: vendor,
        code: `${vendor}.http_${code}`,
        fingerprint: `integration:${vendor}:${code}:${input.functionPath}`,
      };
    }
  }

  if (!input.fromClient) {
    return { kind: "bug", rule: "default.background" };
  }

  for (const rule of EXPECTED_RULES) {
    if (rule.matches(message)) {
      return { kind: "expected", rule: rule.id, code: rule.code };
    }
  }

  return { kind: "bug", rule: "default" };
}

export function defaultFingerprint(input: {
  functionPath: string;
  errorName: string;
  errorMessage: string;
}): string {
  return `convex:${input.functionPath}:${input.errorName}:${normalizeErrorMessage(input.errorMessage)}`;
}
