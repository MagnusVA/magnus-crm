import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { resolvePaymentType } from "../lib/paymentTypes";
import {
  DEAL_POSITIONS,
  dealPosition,
  dealStageOf,
  stageOfPosition,
  type DealPosition,
} from "../opportunities/stages";
import { opportunityByStage } from "../reporting/aggregates";
import { isPersonLoss } from "../reporting/lib/outcomeDerivation";
import { canRecordMeetingOutcome } from "../opportunities/dealGuards";
import { createLiveReadState, readLiveQueryRows } from "../lib/liveQueryBounds";
import schema from "../schema";

const MAX_CLOSER_PAYMENT_SCAN_ROWS = 2500;
const MAX_CLOSER_MEETING_ROWS = 2000;
const CLOSER_MEETING_BYTE_BUDGET = 4 * 1024 * 1024;
const NEXT_MEETING_CANDIDATES = 25;
// Today's calls that haven't ended yet come back too (the client drops them),
// so the limits leave room for a full day of calls.
const NEEDS_OUTCOME_CANDIDATES = 50;
const NEEDS_OUTCOME_LIMIT = 30;

function emptyPositionCounts(): Record<DealPosition, number> {
  return { qualified: 0, booked: 0, call_held: 0, follow_up: 0, won: 0, lost: 0 };
}

// The closer's pipeline tabs and dashboard strip, by the six positions
// (docs/plans/phase-5-deal-status.md §6.2).

/** The closer's deals per position, all time, from opportunityByStage (§6.2). */
export async function countCloserPipelineByStage(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  closerId: Id<"users">,
): Promise<{ counts: Record<DealPosition, number>; total: number }> {
  const positionCounts = await opportunityByStage.countBatch(
    ctx,
    DEAL_POSITIONS.map((position) => {
      const { stage, outcome } = stageOfPosition(position);
      return { namespace: tenantId, bounds: { prefix: [stage, outcome, closerId] } };
    }),
  );
  const counts = emptyPositionCounts();
  let total = 0;
  DEAL_POSITIONS.forEach((position, index) => {
    counts[position] = positionCounts[index] ?? 0;
    total += counts[position];
  });
  return { counts, total };
}

/**
 * The deals behind the closer's meetings scheduled in [startDate, endDate),
 * still the closer's: what the dashboard strip counts for its period.
 */
export async function readCloserMeetingDeals(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  closerId: Id<"users">,
  startDate: number,
  endDate: number,
  maxRows = MAX_CLOSER_MEETING_ROWS,
  byteBudget = CLOSER_MEETING_BYTE_BUDGET,
): Promise<{
  deals: Array<Doc<"opportunities">>;
  attendance: { held: number; noShow: number };
  isMeetingDataTruncated: boolean;
}> {
  const read = await readLiveQueryRows(
    ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_assignedCloserId_and_scheduledAt", (q) =>
        q
          .eq("tenantId", tenantId)
          .eq("assignedCloserId", closerId)
          .gte("scheduledAt", startDate)
          .lt("scheduledAt", endDate),
      ),
    maxRows,
    createLiveReadState(),
    byteBudget,
  );
  const opportunityIds = new Set(read.rows.map((meeting) => meeting.opportunityId));
  // The calls' attendance, for the show-up rate: every call the closer was
  // assigned in the range, whoever owns its deal now.
  const attendance = { held: 0, noShow: 0 };
  for (const meeting of read.rows) {
    if (meeting.status === "held") attendance.held += 1;
    if (meeting.status === "no_show") attendance.noShow += 1;
  }

  const deals: Array<Doc<"opportunities">> = [];
  for (const opportunityId of opportunityIds) {
    const opportunity = await ctx.db.get("opportunities", opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      continue;
    }
    // Belt-and-braces: only count opportunities still owned by this closer.
    if (opportunity.assignedCloserId !== closerId) {
      continue;
    }
    deals.push(opportunity);
  }
  return { deals, attendance, isMeetingDataTruncated: read.capped };
}

/**
 * The strip's counts by position (§6.2). `won` and `lost` feed the close
 * rate: lost counts only the deals a person lost, so the canceled and no-show
 * deals, Lost since the backfill, leave the rate where it was.
 */
export function countStripByStage(deals: Array<Doc<"opportunities">>): {
  counts: Record<DealPosition, number>;
  total: number;
  won: number;
  lost: number;
} {
  const counts = emptyPositionCounts();
  let lost = 0;
  for (const opportunity of deals) {
    const { stage, outcome } = dealStageOf(opportunity);
    counts[dealPosition(stage, outcome)] += 1;
    if (isPersonLoss(opportunity)) {
      lost += 1;
    }
  }
  return { counts, total: deals.length, won: counts.won, lost };
}

/**
 * The closer's payments that count as cash: attributed to the closer,
 * recorded in [startDate, endDate), not disputed and not a deposit. Reads at
 * most MAX_CLOSER_PAYMENT_SCAN_ROWS; `isPaymentDataTruncated` says there were
 * more. Today's Performance and My Pipeline both count cash with it.
 */
export async function readCountedCloserPayments(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    userId: Id<"users">;
    startDate: number;
    endDate: number;
  },
): Promise<{ payments: Array<Doc<"paymentRecords">>; isPaymentDataTruncated: boolean }> {
  const rows = await ctx.db
    .query("paymentRecords")
    .withIndex("by_tenantId_and_attributedCloserId_and_recordedAt", (q) =>
      q
        .eq("tenantId", args.tenantId)
        .eq("attributedCloserId", args.userId)
        .gte("recordedAt", args.startDate)
        .lt("recordedAt", args.endDate),
    )
    .take(MAX_CLOSER_PAYMENT_SCAN_ROWS + 1);

  const payments = rows
    .slice(0, MAX_CLOSER_PAYMENT_SCAN_ROWS)
    .filter(
      (payment) =>
        payment.status !== "disputed" &&
        resolvePaymentType(payment.paymentType) !== "deposit",
    );
  return { payments, isPaymentDataTruncated: rows.length > MAX_CLOSER_PAYMENT_SCAN_ROWS };
}

async function getCashCollectedForCloserInRange(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    userId: Id<"users">;
    startDate: number;
    endDate: number;
  },
) {
  const { payments, isPaymentDataTruncated } = await readCountedCloserPayments(ctx, args);
  let cashCollectedMinor = 0;
  for (const payment of payments) {
    cashCollectedMinor += payment.amountMinor;
  }
  return {
    cashCollectedMinor,
    cashPaymentCount: payments.length,
    isPaymentDataTruncated,
  };
}

/**
 * The closer's first scheduled call starting at or after `from`, on a deal
 * still assigned to them.
 *
 * Today passes the end of the business day, so this is the next call after
 * today's; today's next call comes from the board's own calls. Queries don't
 * read the clock (Convex re-runs them on data changes, not as time passes),
 * so the argument moves once a day.
 *
 * Enriched with lead info and opportunity data.
 * Returns null if there's no such call, or an incomplete result if the
 * candidate limit prevents ruling out a later eligible meeting.
 */
export const getNextMeeting = query({
  args: { from: v.number() },
  returns: v.union(
    v.null(),
    v.object({ meeting: v.null(), incomplete: v.literal(true) }),
    v.object({
      meeting: schema.doc("meetings"),
      opportunity: schema.doc("opportunities"),
      lead: v.union(schema.doc("leads"), v.null()),
      eventTypeName: v.union(v.string(), v.null()),
    }),
  ),
  handler: async (ctx, { from }) => {
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);

    const candidates = await ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_assignedCloserId_and_status_and_scheduledAt", (q) =>
        q
          .eq("tenantId", tenantId)
          .eq("assignedCloserId", userId)
          .eq("status", "scheduled")
          .gte("scheduledAt", from),
      )
      .order("asc")
      .take(NEXT_MEETING_CANDIDATES);

    for (const meeting of candidates) {
      const opportunity = await ctx.db.get("opportunities", meeting.opportunityId);
      if (
        !opportunity ||
        opportunity.tenantId !== tenantId ||
        opportunity.assignedCloserId !== userId
      ) {
        continue;
      }

      const [lead, eventTypeConfig] = await Promise.all([
        ctx.db.get("leads", opportunity.leadId),
        opportunity.eventTypeConfigId
          ? ctx.db.get("eventTypeConfigs", opportunity.eventTypeConfigId)
          : Promise.resolve(null),
      ]);

      return {
        meeting,
        opportunity,
        lead,
        eventTypeName: eventTypeConfig?.displayName ?? null,
      };
    }

    return candidates.length === NEXT_MEETING_CANDIDATES
      ? { meeting: null, incomplete: true as const }
      : null;
  },
});

/**
 * The closer's calls still owed an outcome, newest first: meetings still
 * `scheduled` that start before `before`, whose deal is still the closer's
 * and still takes a meeting outcome (`canRecordMeetingOutcome`), so each one
 * opens on a working outcome bar.
 *
 * Today passes the end of the business day, so the argument moves once a
 * day; queries don't read the clock. Today's calls that haven't ended yet
 * are in the list, and the client keeps the ended ones ("Not recorded",
 * `meetingAttendanceDisplay`) as its clock passes their end.
 *
 * Reads at most NEEDS_OUTCOME_CANDIDATES meetings back from `before` through
 * the attendance index and returns up to NEEDS_OUTCOME_LIMIT. `isPartial`
 * says there may be more than the list holds.
 */
export const getMeetingsNeedingOutcome = query({
  args: { before: v.number() },
  returns: v.object({
    meetings: v.array(
      v.object({
        meetingId: v.id("meetings"),
        scheduledAt: v.number(),
        durationMinutes: v.number(),
        leadName: v.string(),
        programName: v.union(v.string(), v.null()),
      }),
    ),
    isPartial: v.boolean(),
  }),
  handler: async (ctx, { before }) => {
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);

    const candidates = await ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_assignedCloserId_and_status_and_scheduledAt", (q) =>
        q
          .eq("tenantId", tenantId)
          .eq("assignedCloserId", userId)
          .eq("status", "scheduled")
          .lt("scheduledAt", before),
      )
      .order("desc")
      .take(NEEDS_OUTCOME_CANDIDATES);

    const meetings = [];
    for (const meeting of candidates) {
      if (meetings.length === NEEDS_OUTCOME_LIMIT) {
        break;
      }
      const opportunity = await ctx.db.get("opportunities", meeting.opportunityId);
      if (
        !opportunity ||
        opportunity.tenantId !== tenantId ||
        opportunity.assignedCloserId !== userId ||
        !canRecordMeetingOutcome(opportunity)
      ) {
        continue;
      }
      const eventTypeConfig =
        meeting.bookingProgramName || opportunity.firstBookingProgramName || !opportunity.eventTypeConfigId
          ? null
          : await ctx.db.get("eventTypeConfigs", opportunity.eventTypeConfigId);
      meetings.push({
        meetingId: meeting._id,
        scheduledAt: meeting.scheduledAt,
        durationMinutes: meeting.durationMinutes,
        leadName: meeting.leadName ?? "Unknown",
        programName:
          meeting.bookingProgramName ??
          opportunity.firstBookingProgramName ??
          eventTypeConfig?.displayName ??
          null,
      });
    }

    return {
      meetings,
      isPartial:
        meetings.length === NEEDS_OUTCOME_LIMIT ||
        candidates.length === NEEDS_OUTCOME_CANDIDATES,
    };
  },
});

/**
 * The closer's deals by position (docs/plans/phase-5-deal-status.md §6.2).
 *
 * **All-time mode** (no dates): the pipeline page's tabs, each position's
 * count from `opportunityByStage`, and `total` their sum.
 *
 * **Filtered mode** (`startDate` and `endDate`): the dashboard strip. The
 * deals behind the closer's meetings scheduled in [startDate, endDate), by
 * position, with `decided` for the close rate: the won deals and the deals a
 * person lost, so the missed meetings' losses leave the rate where the
 * status left it. Plus the cash collected in the range, and the attendance
 * of the closer's calls in the range (`heldCount`, `noShowCount`) for the
 * show-up rate: held / (held + no-show).
 */
export const getPipelineSummary = query({
  args: {
    startDate: v.optional(v.number()),
    endDate: v.optional(v.number()),
  },
  returns: v.object({
    counts: v.object({
      qualified: v.number(),
      booked: v.number(),
      call_held: v.number(),
      follow_up: v.number(),
      won: v.number(),
      lost: v.number(),
    }),
    total: v.number(),
    decided: v.union(v.object({ won: v.number(), lost: v.number() }), v.null()),
    cashCollectedMinor: v.union(v.number(), v.null()),
    cashPaymentCount: v.union(v.number(), v.null()),
    isPaymentDataTruncated: v.boolean(),
    isMeetingDataTruncated: v.optional(v.boolean()),
    heldCount: v.optional(v.number()),
    noShowCount: v.optional(v.number()),
  }),
  handler: async (ctx, { startDate, endDate }) => {
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);

    // ── Filtered mode ──────────────────────────────────────────────────────
    // Resolve the closer's meetings inside the requested range, then count
    // their deals by position, within the live meeting row and byte bounds.
    if (startDate !== undefined && endDate !== undefined) {
      if (startDate >= endDate) {
        throw new Error("startDate must be earlier than endDate");
      }

      const { deals, attendance, isMeetingDataTruncated } = await readCloserMeetingDeals(
        ctx, tenantId, userId, startDate, endDate,
      );
      const { counts, total, won, lost } = countStripByStage(deals);

      const cash = await getCashCollectedForCloserInRange(ctx, {
        tenantId,
        userId,
        startDate,
        endDate,
      });

      return {
        counts,
        total,
        decided: { won, lost },
        isMeetingDataTruncated,
        heldCount: attendance.held,
        noShowCount: attendance.noShow,
        ...cash,
      };
    }

    // ── All-time mode (pipeline page tabs) ─────────────────────────────────
    const { counts, total } = await countCloserPipelineByStage(ctx, tenantId, userId);

    return {
      counts,
      total,
      decided: null,
      cashCollectedMinor: null,
      cashPaymentCount: null,
      isPaymentDataTruncated: false,
    };
  },
});

/**
 * Get the closer's profile status.
 *
 * Used to determine if the closer is linked to a Calendly member.
 * If not, the dashboard shows a warning banner.
 */
export const getCloserProfile = query({
  args: {},
  handler: async (ctx) => {
    const { userId } = await requireTenantUser(ctx, ["closer"]);

    const user = await ctx.db.get("users", userId);
    if (!user) throw new Error("User not found");

    return {
      fullName: user.fullName,
      email: user.email,
      role: user.role,
      isCalendlyLinked: !!user.calendlyUserUri,
      calendlyUserUri: user.calendlyUserUri,
    };
  },
});
