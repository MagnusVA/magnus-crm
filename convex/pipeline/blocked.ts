import { ConvexError } from "convex/values";

/**
 * Booking outcomes thrown out of booking processing and caught by
 * `processRawEvent`, which records them on the delivery. invitee.created runs
 * as a sub-transaction, so its writes roll back when it throws one: a blocked
 * or ignored booking leaves no lead, identifier, or event type config behind.
 */
export function blockBooking(reason: string): never {
  throw new ConvexError({ kind: "booking_blocked", reason });
}
export function blockedReason(error: unknown): string | undefined {
  return outcomeReason(error, "booking_blocked");
}

/** A delivery the pipeline does not track (not a closer's sales call). It is
 * processed, writes nothing, and is not held for review. */
export function ignoreBooking(reason: string): never {
  throw new ConvexError({ kind: "booking_ignored", reason });
}
export function ignoredReason(error: unknown): string | undefined {
  return outcomeReason(error, "booking_ignored");
}

function outcomeReason(error: unknown, kind: string) {
  if (!(error instanceof ConvexError)) return;
  const data: unknown = error.data;
  if (
    typeof data === "object" &&
    data !== null &&
    "kind" in data &&
    data.kind === kind &&
    "reason" in data &&
    typeof data.reason === "string"
  )
    return data.reason;
}
