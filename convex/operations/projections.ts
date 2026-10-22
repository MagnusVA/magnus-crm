import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import {
  DEAL_POSITION_LABELS,
  dealPosition,
  dealStageOf,
  type DealStageAndOutcome,
} from "../opportunities/stages";

function buildQualificationSearchText(args: {
  event: Doc<"slackQualificationEvents">;
  lead: Doc<"leads"> | null;
  opportunity: Doc<"opportunities"> | null;
  dealStage: DealStageAndOutcome | undefined;
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
    // The label the badge and the filter show (docs/plans/phase-5-deal-status.md
    // §6.6), beside the status until the status goes.
    args.dealStage
      ? DEAL_POSITION_LABELS[dealPosition(args.dealStage.stage, args.dealStage.outcome)]
      : undefined,
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

/**
 * The stage and outcome a qualification row copies from its deal, or none
 * with no deal (docs/plans/phase-5-deal-status.md §3.2). A deal the backfill
 * hasn't reached takes them from its status.
 */
export function qualificationRowStage(
  opportunity: Doc<"opportunities"> | null,
): DealStageAndOutcome | undefined {
  return opportunity ? dealStageOf(opportunity) : undefined;
}

export async function rebuildQualificationRow(
  ctx: MutationCtx,
  qualificationEventId: Id<"slackQualificationEvents">,
) {
  const event = await ctx.db.get("slackQualificationEvents", qualificationEventId);
  if (!event) {
    return null;
  }

  const [lead, opportunity] = await Promise.all([
    event.leadId ? ctx.db.get("leads", event.leadId) : Promise.resolve(null),
    event.opportunityId ? ctx.db.get("opportunities", event.opportunityId) : Promise.resolve(null),
  ]);

  const dealStage = qualificationRowStage(opportunity);
  const row = {
    tenantId: event.tenantId,
    qualificationEventId: event._id,
    opportunityId: opportunity?._id,
    leadId: lead?._id ?? event.leadId,
    slackUserId: event.slackUserId,
    slackTeamId: event.slackTeamId,
    resultKind: event.resultKind,
    opportunityStatus: opportunity?.status,
    // Unset with no deal: a patch with undefined removes the field.
    dealStage: dealStage?.stage,
    dealOutcome: dealStage?.outcome,
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
    // No attribution: the queue reads the deal's first booking's rows and
    // resolution (docs/plans/phase-3-attribution.md §6.2).
    searchText: buildQualificationSearchText({ event, lead, opportunity, dealStage }),
    updatedAt: Date.now(),
  };

  const existing = await ctx.db
    .query("operationsQualificationRows")
    .withIndex("by_qualificationEventId", (q) =>
      q.eq("qualificationEventId", qualificationEventId),
    )
    .unique();

  if (existing) {
    await ctx.db.patch("operationsQualificationRows", existing._id, row);
    return existing._id;
  }

  return await ctx.db.insert("operationsQualificationRows", row);
}

export async function rebuildQualificationRowsForOpportunity(
  ctx: MutationCtx,
  opportunityId: Id<"opportunities">,
) {
  const opportunity = await ctx.db.get("opportunities", opportunityId);
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
