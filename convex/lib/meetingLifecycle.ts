import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { replaceMeetingAggregate } from "../reporting/writeHooks";
import { retypeDealMeetingsWithoutRefs } from "./dealCallTypes";
import { updateOpportunityMeetingRefs } from "./opportunityMeetingRefs";

type Patch = Partial<
  Omit<Doc<"meetings">, "_id" | "_creationTime" | "tenantId" | "opportunityId">
>;

/**
 * Whether a write can change the call type of any meeting on the deal: a call
 * becoming held or stopping being held, or a call moving in time
 * (docs/reviews/reports-decisions.html, D5).
 */
function changesDealCallTypes(before: Doc<"meetings">, after: Doc<"meetings">) {
  return (
    (before.status === "held") !== (after.status === "held") ||
    before.scheduledAt !== after.scheduledAt
  );
}

/** Own the read/write boundary so callers cannot supply stale aggregate snapshots. */
export async function patchMeetingLifecycle(
  ctx: MutationCtx,
  meetingId: Id<"meetings">,
  patch: Patch,
) {
  const before = await ctx.db.get("meetings", meetingId);
  if (!before) throw new Error("Meeting not found");
  const opportunity = await ctx.db.get("opportunities", before.opportunityId);
  if (!opportunity || opportunity.tenantId !== before.tenantId)
    throw new Error("Invalid meeting opportunity");
  if (patch.assignedCloserId) {
    const closer = await ctx.db.get("users", patch.assignedCloserId);
    if (
      !closer ||
      closer.tenantId !== before.tenantId ||
      closer.role !== "closer" ||
      !closer.isActive
    )
      throw new Error("Invalid meeting closer");
  }
  await ctx.db.patch("meetings", meetingId, patch);
  let after = await replaceMeetingAggregate(ctx, before, meetingId);
  if (changesDealCallTypes(before, after)) {
    const { changed } = await retypeDealMeetingsWithoutRefs(ctx, before.opportunityId);
    if (changed.some((change) => change.meetingId === meetingId)) {
      const reread = await ctx.db.get("meetings", meetingId);
      if (!reread) throw new Error("Meeting not found");
      after = reread;
    }
  }
  await updateOpportunityMeetingRefs(ctx, before.opportunityId);
  return after;
}
