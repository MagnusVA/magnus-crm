// What the sign-in callback tells the person and PostHog when it fails.
// No server-only APIs here, so the page, the route and the tests share it.

import { requestHost } from "@/lib/observability/request-host";

/** The `reason` values `/sign-in/error` accepts. Anything else shows `failed`. */
export const SIGN_IN_FAILURE_REASONS = ["expired", "used", "incomplete", "failed"] as const;
export type SignInFailureReason = (typeof SIGN_IN_FAILURE_REASONS)[number];

/**
 * Callback failures the person causes rather than WorkOS or the app, by
 * AuthKit `CallbackError` code or WorkOS OAuth error code:
 *
 * - `missing_pkce_cookie`, `oauth_state_mismatch`: the callback arrived
 *   without this flow's ten-minute verifier cookie (a stale tab, another
 *   browser, another host, or a refresh of a callback already handled).
 * - `invalid_grant`: the code was already exchanged or has expired. It is
 *   never exchanged again.
 * - `missing_auth_params`: the callback URL has no code or no state.
 */
const REJECTED_CALLBACK_REASONS: Record<string, SignInFailureReason> = {
  missing_pkce_cookie: "expired",
  oauth_state_mismatch: "expired",
  invalid_grant: "used",
  missing_auth_params: "incomplete",
};

/**
 * The OAuth errors WorkOS can send back in the callback's `error` param in
 * place of a code (RFC 6749 4.1.2.1, OpenID Connect 3.1.2.6). AuthKit
 * reports every one of them as `missing_auth_params`.
 */
const OAUTH_ERRORS = new Set([
  "access_denied",
  "invalid_request",
  "invalid_scope",
  "unauthorized_client",
  "unsupported_response_type",
  "server_error",
  "temporarily_unavailable",
  "interaction_required",
  "login_required",
  "consent_required",
]);
/** WorkOS failing, not the person: these stay exceptions. */
const OAUTH_VENDOR_FAULTS = new Set(["server_error", "temporarily_unavailable"]);

/** The callback's `error` param as a known code, `other`, or undefined when absent. */
export function callbackOauthError(request: Request): string | undefined {
  const error = new URL(request.url).searchParams.get("error");
  if (error === null) return undefined;
  return OAUTH_ERRORS.has(error) ? error : "other";
}

/** The page reason for a rejection, or null when the failure is a fault to report. */
export function rejectedCallbackReason(
  code: string,
  oauthError?: string,
): SignInFailureReason | null {
  if (oauthError !== undefined && OAUTH_VENDOR_FAULTS.has(oauthError)) return null;
  return Object.hasOwn(REJECTED_CALLBACK_REASONS, code)
    ? REJECTED_CALLBACK_REASONS[code]
    : null;
}

export function parseSignInFailureReason(value: unknown): SignInFailureReason {
  return SIGN_IN_FAILURE_REASONS.find((reason) => reason === value) ?? "failed";
}

/** Relative, so the retry stays on the host the callback arrived on. */
export function signInFailurePath(reason: SignInFailureReason): string {
  return `/sign-in/error?reason=${reason}`;
}

/** AuthKit seals the OAuth state for this long (`get-authorization-url`). */
const FLOW_TTL_MS = 600_000;
const MAX_FLOW_AGE_SECONDS = 86_400;
const PKCE_COOKIE_PREFIX = "wos-auth-verifier";

/**
 * Seconds since sign-in started, read from the expiry an iron seal carries in
 * the clear as its sixth `*`-separated field. Nothing is unsealed and the
 * state itself is never returned. Undefined when the value isn't such a seal.
 */
export function signInFlowAgeSeconds(
  state: string | null,
  now: number,
): number | undefined {
  const expiresAt = Number(state?.split("*")[5]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) return undefined;
  const age = Math.round((now - (expiresAt - FLOW_TTL_MS)) / 1000);
  return age >= 0 && age <= MAX_FLOW_AGE_SECONDS ? age : undefined;
}

function hostOf(url: string | undefined): string | undefined {
  try {
    return url ? new URL(url).host.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Flags and counts that let a triage tell the causes of a rejected callback
 * apart. Old flow: `flow_age_seconds` past 600. Callback refreshed or another
 * flow's tab: verifier cookies present but not this one. Another browser or
 * host: no verifier cookie and no PostHog cookie.
 */
export function signInCallbackDiagnostics(
  request: Request,
  now: number = Date.now(),
): Record<string, string | number | boolean | undefined> {
  const url = new URL(request.url);
  const cookieNames = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim().split("=")[0]);
  const redirectHost = hostOf(process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI);

  return {
    has_code: url.searchParams.has("code"),
    has_state: url.searchParams.has("state"),
    oauth_error: callbackOauthError(request),
    flow_age_seconds: signInFlowAgeSeconds(url.searchParams.get("state"), now),
    pkce_cookie_count: cookieNames.filter((name) => name.startsWith(PKCE_COOKIE_PREFIX)).length,
    has_posthog_cookie: cookieNames.some((name) => /^ph_.+_posthog$/.test(name)),
    host_matches_redirect_uri:
      redirectHost === undefined ? undefined : redirectHost === requestHost(request),
  };
}
