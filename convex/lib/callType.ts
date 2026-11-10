import type { Doc, Id } from "../_generated/dataModel";

// What kind of call a meeting is (docs/reviews/reports-decisions.html, D5).
// A call is a first call until the person has held one on this deal: a
// follow-up is a call with a held meeting on the same deal scheduled before
// it. A moved first call and a rebook after a no-show are first calls. The
// booking writers, the re-check when a result is recorded, a meeting moved to
// another deal and the backfill all call `callTypeFor`, so they can't
// disagree.

export type CallType = "new" | "follow_up";

type TypedMeeting = Pick<Doc<"meetings">, "_id" | "scheduledAt">;
type DealMeeting = Pick<Doc<"meetings">, "_id" | "status" | "scheduledAt">;

/**
 * The type `meeting` should have, given every meeting on its deal (it may be
 * among them). Pass the deal's meetings as they are now, after the write.
 */
export function callTypeFor(meeting: TypedMeeting, dealMeetings: readonly DealMeeting[]): CallType {
  for (const other of dealMeetings) {
    if (other._id === meeting._id) continue;
    if (other.status === "held" && other.scheduledAt < meeting.scheduledAt) return "follow_up";
  }
  return "new";
}

/**
 * A meeting that replaces another: a Calendly reschedule (the replaced slot is
 * canceled) or a rebook through the no-show link (the replaced call stays a
 * no-show). It isn't a new booking, so booking counts and DM goals skip it.
 */
export function isReplacement(meeting: Pick<Doc<"meetings">, "rescheduledFromMeetingId">): boolean {
  return meeting.rescheduledFromMeetingId !== undefined;
}

/** A canceled meeting is moved when another meeting replaces it. */
export function isMovedSlot(
  meeting: Pick<Doc<"meetings">, "status">,
  successor: { _id: Id<"meetings"> } | null,
): boolean {
  return meeting.status === "canceled" && successor !== null;
}
