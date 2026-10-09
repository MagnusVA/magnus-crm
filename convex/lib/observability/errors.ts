import { ConvexError } from "convex/values";
import { log, type ObsAttributes } from "./log";

/**
 * Data carried by an expected error. `code` is a stable, dotted identifier
 * (`auth.not_authenticated`); `message` is safe to show the user.
 */
export type ExpectedErrorData = {
  code: string;
  message: string;
};

/**
 * An error the caller caused or can resolve: a missing session, a role
 * without access, a business rule that rejects the request. These aren't
 * bugs. The observability ingest records them as rejections instead of
 * Error Tracking issues, and the browser drops them from exception capture.
 *
 * Unlike a plain `Error`, a `ConvexError` reaches the client unredacted in
 * production, so `error.data.message` can be shown as-is.
 *
 * Throw a plain `Error` for anything that means the code is wrong.
 */
export function expectedError(
  code: string,
  message: string,
): ConvexError<ExpectedErrorData> {
  return new ConvexError({ code, message });
}

/**
 * `expectedError` plus a `request.rejected` log line carrying `attrs`, for
 * rejections whose context (role, ids, state) helps explain a spike.
 */
export function rejectRequest(
  code: string,
  message: string,
  attrs?: ObsAttributes,
): ConvexError<ExpectedErrorData> {
  log.warn("request.rejected", { code, ...attrs });
  return expectedError(code, message);
}

export function isExpectedError(
  error: unknown,
): error is ConvexError<ExpectedErrorData> {
  if (!(error instanceof ConvexError)) return false;
  const data: unknown = error.data;
  return (
    typeof data === "object" &&
    data !== null &&
    typeof (data as { code?: unknown }).code === "string"
  );
}
