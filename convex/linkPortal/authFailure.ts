import { expectedError } from "../lib/observability/errors";

export const PORTAL_AUTH_FAILED_CODE = "link_portal.auth_failed";
export const GENERIC_PORTAL_AUTH_ERROR = "Portal unavailable or password invalid.";

/**
 * The rejection for every portal sign-in a caller got wrong: an unknown or
 * disabled portal, a wrong password, a locked-out address. They share one
 * code and one sentence so the answer never says which it was; the
 * `link_portal.auth.*` log line beside each throw does.
 *
 * It's `expectedError`, not `rejectRequest`, because that log line already
 * records the refusal.
 */
export function portalAuthFailed() {
  return expectedError(PORTAL_AUTH_FAILED_CODE, GENERIC_PORTAL_AUTH_ERROR);
}
