import { v } from "convex/values";
import { literals } from "convex-helpers/validators";
import type { Doc, Id } from "../_generated/dataModel";
import { query, type QueryCtx } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { meetingDealLabelOf } from "../opportunities/stageLabels";
import {
  DEAL_POSITIONS,
  dealStageValidator,
  dealOutcomeValidator,
} from "../opportunities/stages";
import {
  createLiveReadState,
  LIVE_QUERY_BYTE_BUDGET,
  readLiveQueryRows,
} from "../lib/liveQueryBounds";
import { rejectRequest } from "../lib/observability/errors";

const MAX_CALENDAR_MEETING_ROWS = 1000;
const MAX_CALENDAR_RANGE_MS = 45 * 24 * 60 * 60 * 1000;

const calendarMeetingValidator = v.object({
  meeting: v.object({
    _id: v.id("meetings"),
    scheduledAt: v.number(),
    durationMinutes: v.number(),
    status: literals("scheduled", "completed", "held", "canceled", "no_show"),
    meetingJoinUrl: v.optional(v.string()),
    zoomJoinUrl: v.optional(v.string()),
  }),
  leadName: v.string(),
  eventTypeName: v.union(v.string(), v.null()),
  dealStage: v.union(dealStageValidator, v.null()),
  dealOutcome: v.union(dealOutcomeValidator, v.null()),
  dealPosition: v.union(literals(...DEAL_POSITIONS), v.null()),
  dealSystemLoss: v.union(literals("stale", "no_show", "canceled"), v.null()),
});

// A meeting whose deal is gone shows no deal.
const NO_DEAL = {
  dealStage: null,
  dealOutcome: null,
  dealPosition: null,
  dealSystemLoss: null,
} as const;

/**
 * Get a bounded set of the closer's meetings within a date range, canceled ones
 * included (docs/plans/phase-5-deal-status.md §6.3).
 *
 * Each meeting comes with the person's name, its event type and its deal's
 * label (`meetingDealLabelOf`): the stage, outcome and position, and the
 * loss the system wrote, such as a no-show or a cancellation. Used by the
 * calendar view to render meeting blocks. The envelope reports partial reads;
 * meeting entries retain their existing shape.
 *
 * Args:
 * - startDate: Unix ms timestamp for the start of the range
 * - endDate: Unix ms timestamp for the end of the range
 */
export const getMeetingsForRange = query({
  args: {
    startDate: v.number(),
    endDate: v.number(),
  },
  returns: v.object({
    meetings: v.array(calendarMeetingValidator),
    isPartial: v.boolean(),
  }),
  handler: async (ctx, { startDate, endDate }) => {
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);
    return await readCloserCalendarMeetings(ctx, tenantId, userId, startDate, endDate);
  },
});

/** Bounded calendar read, with smaller budgets available to backend tests. */
export async function readCloserCalendarMeetings(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  userId: Id<"users">,
  startDate: number,
  endDate: number,
  maxRows = MAX_CALENDAR_MEETING_ROWS,
  byteBudget = LIVE_QUERY_BYTE_BUDGET,
) {
  if (startDate >= endDate) {
    throw new Error("startDate must be earlier than endDate");
  }

  if (endDate - startDate > MAX_CALENDAR_RANGE_MS) {
    throw rejectRequest(
      "calendar.range_too_long",
      "Calendar range cannot exceed 45 days.",
      { tenantId },
    );
  }

  const read = await readLiveQueryRows(
    ctx.db.query("meetings").withIndex(
      "by_tenantId_and_assignedCloserId_and_scheduledAt",
      (q) => q
        .eq("tenantId", tenantId)
        .eq("assignedCloserId", userId)
        .gte("scheduledAt", startDate)
        .lt("scheduledAt", endDate),
    ),
    maxRows,
    createLiveReadState(),
    byteBudget,
  );
  const myMeetings = read.rows;

  const opportunityIds = [
    ...new Set(myMeetings.map((meeting) => meeting.opportunityId)),
  ];
  const opportunities = await Promise.all(
    opportunityIds.map(async (opportunityId) => ({
      opportunityId,
      opportunity: await ctx.db.get("opportunities", opportunityId),
    })),
  );
  const opportunityById = new Map<
    Id<"opportunities">,
    Doc<"opportunities">
  >();
  const eventTypeConfigIds = new Set<Id<"eventTypeConfigs">>();

  for (const { opportunityId, opportunity } of opportunities) {
    if (!opportunity || opportunity.tenantId !== tenantId) {
      continue;
    }
    opportunityById.set(opportunityId, opportunity);
    if (opportunity.eventTypeConfigId) {
      eventTypeConfigIds.add(opportunity.eventTypeConfigId);
    }
  }

  const eventTypeConfigs = await Promise.all(
    [...eventTypeConfigIds].map(async (eventTypeConfigId) => ({
      eventTypeConfigId,
      eventTypeConfig: await ctx.db.get("eventTypeConfigs", eventTypeConfigId),
    })),
  );
  const eventTypeNameById = new Map<
    Id<"eventTypeConfigs">,
    string | null
  >(
    eventTypeConfigs.map(({ eventTypeConfigId, eventTypeConfig }) => [
      eventTypeConfigId,
      eventTypeConfig?.displayName ?? null,
    ]),
  );

  const meetings = myMeetings.map((meeting) => {
    const opportunity = opportunityById.get(meeting.opportunityId);
    const eventTypeName = opportunity?.eventTypeConfigId
      ? (eventTypeNameById.get(opportunity.eventTypeConfigId) ?? null)
      : null;

    return {
      // What a block draws; the meeting's copy of the deal status stays out.
      meeting: {
        _id: meeting._id,
        scheduledAt: meeting.scheduledAt,
        durationMinutes: meeting.durationMinutes,
        status: meeting.status,
        meetingJoinUrl: meeting.meetingJoinUrl,
        zoomJoinUrl: meeting.zoomJoinUrl,
      },
      leadName: meeting.leadName ?? "Unknown",
      eventTypeName,
      ...(opportunity ? meetingDealLabelOf(opportunity) : NO_DEAL),
    };
  });
  return { meetings, isPartial: read.capped };
}
