import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { OUTCOME_LEAD_MS } from "./outcomeEligibility";

/**
 * The call a follow-up was set after: its `sourceMeetingId` when the create
 * mutation stored one, else the deal's latest call scheduled no later than
 * the follow-up's creation plus the early-outcome window (an outcome can be
 * recorded `OUTCOME_LEAD_MS` before the call starts, so a link generated at
 * 14:58 follows the 15:00 call). One indexed read either way, with no cap on
 * how old the call is. Null when the deal has no such call.
 */
export async function loadFollowedMeeting(
  ctx: QueryCtx | MutationCtx,
  followUp: Doc<"followUps">,
): Promise<Doc<"meetings"> | null> {
  if (followUp.sourceMeetingId) {
    const source = await ctx.db.get("meetings", followUp.sourceMeetingId);
    if (
      source &&
      source.tenantId === followUp.tenantId &&
      source.opportunityId === followUp.opportunityId
    ) {
      return source;
    }
  }
  const meeting = await ctx.db
    .query("meetings")
    .withIndex("by_opportunityId_and_scheduledAt", (q) =>
      q
        .eq("opportunityId", followUp.opportunityId)
        .lte("scheduledAt", followUp.createdAt + OUTCOME_LEAD_MS),
    )
    .order("desc")
    .first();
  return meeting && meeting.tenantId === followUp.tenantId ? meeting : null;
}
