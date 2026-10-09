import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/**
 * Why a cancel or no-show event found no meeting:
 * - `booking_not_tracked`: the booking's invitee.created was processed
 *   without creating a meeting (for example, a non-closer host), so there is
 *   nothing to update. Routine.
 * - `out_of_order`: invitee.created arrived but hasn't been processed yet.
 * - `meeting_not_found`: no invitee.created was ever stored for the invitee.
 */
export type MissingMeetingReason =
  | "booking_not_tracked"
  | "out_of_order"
  | "meeting_not_found";

/**
 * Classifies a missing meeting by looking up the booking's invitee.created
 * raw event. Every invitee webhook stores the invitee URI as
 * `calendlyEventUri`, the same key the ingestion dedupe uses, so this is a
 * single indexed point read.
 */
export async function classifyMissingMeeting(
  ctx: MutationCtx,
  rawEvent: Doc<"rawWebhookEvents">,
): Promise<MissingMeetingReason> {
  const createdEvent = await ctx.db
    .query("rawWebhookEvents")
    .withIndex("by_tenantId_and_eventType_and_calendlyEventUri", (q) =>
      q
        .eq("tenantId", rawEvent.tenantId)
        .eq("eventType", "invitee.created")
        .eq("calendlyEventUri", rawEvent.calendlyEventUri),
    )
    .first();

  if (!createdEvent) return "meeting_not_found";
  return createdEvent.processed ? "booking_not_tracked" : "out_of_order";
}
