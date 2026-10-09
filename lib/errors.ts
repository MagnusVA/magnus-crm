import { ConvexError } from "convex/values";

/**
 * The text to show a user for a caught error.
 *
 * A `ConvexError` (from `expectedError` / `rejectRequest`) carries
 * `{ code, message }`; its `error.message` is the raw JSON, so the
 * user-facing text comes from `data.message`. Other errors use their message.
 */
export function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ConvexError) {
    const data: unknown = error.data;
    if (typeof data === "string" && data.length > 0) return data;
    if (
      typeof data === "object" &&
      data !== null &&
      typeof (data as { message?: unknown }).message === "string"
    ) {
      return (data as { message: string }).message;
    }
    return fallback;
  }
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

/** The stable `code` of an expected Convex rejection, e.g. `auth.insufficient_permissions`. */
export function getErrorCode(error: unknown): string | undefined {
  if (!(error instanceof ConvexError)) return undefined;
  const data: unknown = error.data;
  if (typeof data === "object" && data !== null) {
    const code = (data as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/**
 * Whether a Convex call failed because of the request rather than an outage
 * or a bug: an expected rejection (`ConvexError`), a malformed id, or a
 * "not found". Pages map these to `notFound()` and rethrow anything else.
 */
export function isExpectedConvexRejection(error: unknown): boolean {
  if (error instanceof ConvexError) return true;
  if (!(error instanceof Error)) return false;
  return /ArgumentValidationError|does not match validator|not found/i.test(error.message);
}
