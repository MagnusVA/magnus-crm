import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

function buildQualificationSearchText(args: {
  event: Doc<"slackQualificationEvents">;
  lead: Doc<"leads"> | null;
  opportunity: Doc<"opportunities"> | null;
}) {
  return [
    args.event.fullNameSnapshot,
    args.event.handleSnapshot,
    args.event.platform,
    args.event.slackUserId,
    args.lead?.fullName,
    args.lead?.email,
    args.lead?.phone,
    args.opportunity?.status,
    args.opportunity?.firstBookingProgramName,
    args.opportunity?.soldProgramName,
  ]
    .filter(
      (value): value is string =>
        typeof value === "string" && value.trim().length > 0,
    )
    .join(" ")
    .toLowerCase();
}

export async function rebuildQualificationRow(
  ctx: MutationCtx,
  qualificationEventId: Id<"slackQualificationEvents">,
) {
  const event = await ctx.db.get(qualificationEventId);
  if (!event) {
    return null;
  }

  const [lead, opportunity] = await Promise.all([
    event.leadId ? ctx.db.get(event.leadId) : Promise.resolve(null),
    event.opportunityId ? ctx.db.get(event.opportunityId) : Promise.resolve(null),
  ]);

  const row = {
    tenantId: event.tenantId,
    qualificationEventId: event._id,
    opportunityId: opportunity?._id,
    leadId: lead?._id ?? event.leadId,
    slackUserId: event.slackUserId,
    slackTeamId: event.slackTeamId,
    resultKind: event.resultKind,
    opportunityStatus: opportunity?.status,
    bookingProgramId: opportunity?.firstBookingProgramId,
    bookingProgramName: opportunity?.firstBookingProgramName,
    bookingProgramMappingStatus: opportunity?.firstBookingProgramMappingStatus,
    soldProgramId: opportunity?.soldProgramId,
    soldProgramName: opportunity?.soldProgramName,
    qualifiedAt: event.submittedAt,
    firstBookedAt: opportunity?.firstBookedAt,
    firstMeetingId: opportunity?.firstMeetingId,
    firstMeetingAt: opportunity?.firstMeetingAt,
    assignedCloserId: opportunity?.assignedCloserId,
    attributionTeamId: opportunity?.attributionTeamId,
    dmCloserId: opportunity?.dmCloserId,
    attributionResolution: opportunity?.attributionResolution ?? ("none" as const),
    searchText: buildQualificationSearchText({ event, lead, opportunity }),
    updatedAt: Date.now(),
  };

  const existing = await ctx.db
    .query("operationsQualificationRows")
    .withIndex("by_qualificationEventId", (q) =>
      q.eq("qualificationEventId", qualificationEventId),
    )
    .unique();

  if (existing) {
    await ctx.db.patch(existing._id, row);
    return existing._id;
  }

  return await ctx.db.insert("operationsQualificationRows", row);
}

export async function rebuildQualificationRowsForOpportunity(
  ctx: MutationCtx,
  opportunityId: Id<"opportunities">,
) {
  const opportunity = await ctx.db.get(opportunityId);
  if (!opportunity) {
    return;
  }

  const events = await ctx.db
    .query("slackQualificationEvents")
    .withIndex("by_tenantId_and_opportunityId", (q) =>
      q.eq("tenantId", opportunity.tenantId).eq("opportunityId", opportunityId),
    )
    .take(50);

  await Promise.all(
    events.map((event) => rebuildQualificationRow(ctx, event._id)),
  );
}
