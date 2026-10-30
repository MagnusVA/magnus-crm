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
import { resolvePaymentType } from "../lib/paymentTypes";

const MAX_CALENDAR_MEETING_ROWS = 1000;
const MAX_CALENDAR_RANGE_MS = 45 * 24 * 60 * 60 * 1000;
// Won deals whose collected amount the board shows, and the payments read per deal.
const MAX_WON_DEALS_WITH_AMOUNT = 100;
const MAX_PAYMENTS_PER_WON_DEAL = 50;

const calendarMeetingValidator = v.object({
  meeting: v.object({
    _id: v.id("meetings"),
    scheduledAt: v.number(),
    durationMinutes: v.number(),
    status: literals("scheduled", "held", "canceled", "no_show"),
    meetingJoinUrl: v.optional(v.string()),
    zoomJoinUrl: v.optional(v.string()),
    // Calendly's location type ("zoom", "google_conference", ...): the call's gate.
    meetingLocationType: v.optional(v.string()),
    // The program booked: the meeting's own, else the deal's first booking's.
    bookingProgramName: v.optional(v.string()),
  }),
  leadName: v.string(),
  eventTypeName: v.union(v.string(), v.null()),
  dealStage: v.union(dealStageValidator, v.null()),
  dealOutcome: v.union(dealOutcomeValidator, v.null()),
  dealPosition: v.union(literals(...DEAL_POSITIONS), v.null()),
  dealSystemLoss: v.union(literals("stale", "no_show", "canceled"), v.null()),
  // A won deal's collected amount, counted as the closer's cash figure counts
  // it: no disputed payments, no deposits. Absent for open and lost deals, and
  // when the deal's payments are in more than one currency.
  wonAmount: v.optional(v.object({ amountMinor: v.number(), currency: v.string() })),
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
 * loss the system wrote, such as a no-show or a cancellation, plus the call's
 * gate and booked program. Used by the closer's Today board. The envelope reports partial reads;
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

  const wonAmountByOpportunityId = await readWonAmounts(
    ctx,
    tenantId,
    [...opportunityById.values()].filter(
      (opportunity) => meetingDealLabelOf(opportunity).dealPosition === "won",
    ),
  );

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
        meetingLocationType: meeting.meetingLocationType,
        bookingProgramName:
          meeting.bookingProgramName ?? opportunity?.firstBookingProgramName,
      },
      leadName: meeting.leadName ?? "Unknown",
      eventTypeName,
      ...(opportunity ? meetingDealLabelOf(opportunity) : NO_DEAL),
      ...(wonAmountByOpportunityId.has(meeting.opportunityId)
        ? { wonAmount: wonAmountByOpportunityId.get(meeting.opportunityId) }
        : {}),
    };
  });
  return { meetings, isPartial: read.capped };
}

/**
 * Each won deal's collected amount, from its recorded payments. Disputed
 * payments and deposits don't count, as in the closer's cash figure. A deal
 * with no counted payment, or with payments in two currencies, gets none.
 */
async function readWonAmounts(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  wonDeals: Array<Doc<"opportunities">>,
) {
  const amounts = new Map<Id<"opportunities">, { amountMinor: number; currency: string }>();
  const reads = await Promise.all(
    wonDeals.slice(0, MAX_WON_DEALS_WITH_AMOUNT).map(async (opportunity) => ({
      opportunityId: opportunity._id,
      payments: await ctx.db
        .query("paymentRecords")
        .withIndex("by_opportunityId_and_recordedAt", (q) =>
          q.eq("opportunityId", opportunity._id),
        )
        .take(MAX_PAYMENTS_PER_WON_DEAL),
    })),
  );
  for (const { opportunityId, payments } of reads) {
    let amountMinor = 0;
    const currencies = new Set<string>();
    for (const payment of payments) {
      if (
        payment.tenantId !== tenantId ||
        payment.status === "disputed" ||
        resolvePaymentType(payment.paymentType) === "deposit"
      ) {
        continue;
      }
      amountMinor += payment.amountMinor;
      currencies.add(payment.currency);
    }
    if (currencies.size === 1) {
      amounts.set(opportunityId, { amountMinor, currency: [...currencies][0] });
    }
  }
  return amounts;
}
