import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { replaceMeetingAggregate } from "../reporting/writeHooks";
import { updateOpportunityMeetingRefs } from "./opportunityMeetingRefs";

type Patch = Partial<
  Omit<Doc<"meetings">, "_id" | "_creationTime" | "tenantId" | "opportunityId">
>;
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
  const after = await replaceMeetingAggregate(ctx, before, meetingId);
  await updateOpportunityMeetingRefs(ctx, before.opportunityId);
  return after;
}
