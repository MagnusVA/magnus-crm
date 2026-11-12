import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { SocialPlatformType } from "../lib/normalization";

export type IdentityMatchVia = "email" | "phone" | "social_handle";
export type IdentityConflict = { leadId: Id<"leads">; via: IdentityMatchVia };
/** A booking's identifiers, normalized, as a booking review records them. */
export type BookingIdentifiers = {
  name?: string;
  email?: string;
  phone?: string;
  socialHandle?: { platform: SocialPlatformType; handle: string };
};
/** The people a held booking named, for its booking review. */
export type BlockedIdentity = {
  conflicts: IdentityConflict[];
  booking: BookingIdentifiers;
};

/** Why a booking is held, in IDs only, as the receipt stores it. */
export type BookingHold = {
  cause: string;
  matches: IdentityConflict[];
  truncated: boolean;
  waitingOnDeliveryId?: Id<"webhookDeliveries">;
};

/** The most people a hold records. */
const HOLD_MATCH_LIMIT = 16;

/** A hold naming the rule that fired and the people it matched. */
export function holdEvidence(
  cause: string,
  matches: IdentityConflict[] = [],
  extra: Partial<Pick<BookingHold, "truncated" | "waitingOnDeliveryId">> = {},
): BookingHold {
  const seen = new Set<string>();
  const distinct = matches.filter((m) => {
    const key = `${m.leadId}:${m.via}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    cause,
    matches: distinct.slice(0, HOLD_MATCH_LIMIT),
    truncated: (extra.truncated ?? false) || distinct.length > HOLD_MATCH_LIMIT,
    ...(extra.waitingOnDeliveryId && { waitingOnDeliveryId: extra.waitingOnDeliveryId }),
  };
}

/**
 * Booking outcomes thrown out of booking processing and caught by
 * `processRawEvent`, which records them on the delivery. invitee.created runs
 * as a sub-transaction, so its writes roll back when it throws one: a blocked
 * or ignored booking leaves no lead, identifier, or event type config behind.
 * `identity` names the people a booking review decides between; `hold` is the
 * IDs-only evidence the recovery panel explains the hold with.
 */
export function blockBooking(
  reason: string,
  identity?: BlockedIdentity,
  hold?: BookingHold,
): never {
  throw new ConvexError({
    kind: "booking_blocked",
    reason,
    ...(identity && { identity }),
    ...(hold && { hold }),
  });
}
export function blockedReason(error: unknown): string | undefined {
  return outcomeReason(error, "booking_blocked");
}
/** The people a blocked booking's identifiers named, when the block says. */
export function blockedIdentity(error: unknown): BlockedIdentity | undefined {
  if (!blockedReason(error)) return;
  const data = (error as ConvexError<{ identity?: BlockedIdentity }>).data;
  return data.identity;
}

/** The IDs-only evidence a blocked booking's hold carries, when it says. */
export function blockedHold(error: unknown): BookingHold | undefined {
  if (!blockedReason(error)) return;
  const data = (error as ConvexError<{ hold?: BookingHold }>).data;
  return data.hold;
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
