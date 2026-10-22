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
import { meterDocument, meterRange, type ReadMeter } from "../reporting/lib/readMeter";

const PIPELINE_STATUSES = [
  "qualified_pending",
  "scheduled",
  "follow_up_scheduled",
  "reschedule_link_sent",
  "payment_received",
  "lost",
  "canceled",
  "no_show",
] as const;

type PipelineStatus = (typeof PIPELINE_STATUSES)[number];
const MAX_CLOSER_PAYMENT_SCAN_ROWS = 2500;
const PIPELINE_STATUS_SET = new Set<string>(PIPELINE_STATUSES);

function emptyCounts(): Record<PipelineStatus, number> {
  return {
    qualified_pending: 0,
    scheduled: 0,
    follow_up_scheduled: 0,
    reschedule_link_sent: 0,
    payment_received: 0,
    lost: 0,
    canceled: 0,
    no_show: 0,
  };
}

function emptyPositionCounts(): Record<DealPosition, number> {
  return { qualified: 0, booked: 0, call_held: 0, follow_up: 0, won: 0, lost: 0 };
}

// The closer's pipeline tabs and dashboard strip, counted two ways
// (docs/plans/phase-5-deal-status.md §6.2): by the six positions, which the
// screens show, and by status, which only the parity queries in
// convex/opportunities/stageParity.ts read to compare them. PR 9 removes the
// status ways.

/** The closer's deals per status, all time: the pipeline tabs before PR 5. */
export async function countCloserPipelineByStatus(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  closerId: Id<"users">,
  meter?: ReadMeter,
): Promise<{ counts: Record<PipelineStatus, number>; total: number }> {
  const counts = emptyCounts();
  let total = 0;

  for (const status of PIPELINE_STATUSES) {
    let count = 0;
    meterRange(meter);
    for await (const opportunity of ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_assignedCloserId_and_status_and_createdAt", (q) =>
        q
          .eq("tenantId", tenantId)
          .eq("assignedCloserId", closerId)
          .eq("status", status),
      )) {
      meterDocument(meter, opportunity);
      count += opportunity.status === status ? 1 : 0;
    }
    counts[status] = count;
    total += count;
  }

  return { counts, total };
}

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
  meter?: ReadMeter,
): Promise<Array<Doc<"opportunities">>> {
  const opportunityIds = new Set<Id<"opportunities">>();
  meterRange(meter);
  for await (const meeting of ctx.db
    .query("meetings")
    .withIndex("by_tenantId_and_assignedCloserId_and_scheduledAt", (q) =>
      q
        .eq("tenantId", tenantId)
        .eq("assignedCloserId", closerId)
        .gte("scheduledAt", startDate)
        .lt("scheduledAt", endDate),
    )) {
    meterDocument(meter, meeting);
    opportunityIds.add(meeting.opportunityId);
  }

  const deals: Array<Doc<"opportunities">> = [];
  for (const opportunityId of opportunityIds) {
    const opportunity = await ctx.db.get("opportunities", opportunityId);
    meterRange(meter);
    meterDocument(meter, opportunity);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      continue;
    }
    // Belt-and-braces: only count opportunities still owned by this closer.
    if (opportunity.assignedCloserId !== closerId) {
      continue;
    }
    deals.push(opportunity);
  }
  return deals;
}

/** The strip's counts by status before PR 5; its close rate was won ÷ (won + lost). */
export function countStripByStatus(deals: Array<Doc<"opportunities">>): {
  counts: Record<PipelineStatus, number>;
  total: number;
} {
  const counts = emptyCounts();
  let total = 0;
  for (const opportunity of deals) {
    if (!PIPELINE_STATUS_SET.has(opportunity.status)) {
      continue;
    }
    counts[opportunity.status as PipelineStatus] += 1;
    total += 1;
  }
  return { counts, total };
}

/**
 * The strip's counts by position (§6.2). `won` and `lost` feed the close
 * rate: lost counts only the deals a person lost, so the canceled and no-show
 * deals, Lost since the backfill, leave the rate where it is today.
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

async function getCashCollectedForCloserInRange(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    userId: Id<"users">;
    startDate: number;
    endDate: number;
  },
) {
  const payments = await ctx.db
    .query("paymentRecords")
    .withIndex("by_tenantId_and_attributedCloserId_and_recordedAt", (q) =>
      q
        .eq("tenantId", args.tenantId)
        .eq("attributedCloserId", args.userId)
        .gte("recordedAt", args.startDate)
        .lt("recordedAt", args.endDate),
    )
    .take(MAX_CLOSER_PAYMENT_SCAN_ROWS + 1);

  let cashCollectedMinor = 0;
  let cashPaymentCount = 0;

  for (const payment of payments.slice(0, MAX_CLOSER_PAYMENT_SCAN_ROWS)) {
    if (
      payment.status === "disputed" ||
      !payment.commissionable ||
      resolvePaymentType(payment.paymentType) === "deposit"
    ) {
      continue;
    }

    cashCollectedMinor += payment.amountMinor;
    cashPaymentCount += 1;
  }

  return {
    cashCollectedMinor,
    cashPaymentCount,
    isPaymentDataTruncated: payments.length > MAX_CLOSER_PAYMENT_SCAN_ROWS,
  };
}

/**
 * Get the closer's next upcoming meeting.
 *
 * Returns the soonest meeting (by scheduledAt) with status "scheduled"
 * that belongs to an opportunity assigned to this closer.
 *
 * Enriched with lead info and opportunity data.
 * Returns null if no upcoming meetings.
 */
export const getNextMeeting = query({
  args: {},
  handler: async (ctx) => {
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);
    const now = Date.now();

    for await (const meeting of ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_assignedCloserId_and_scheduledAt", (q) =>
        q
          .eq("tenantId", tenantId)
          .eq("assignedCloserId", userId)
          .gte("scheduledAt", now),
      )) {
      if (meeting.status !== "scheduled") {
        continue;
      }

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

    return null;
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
 * status left it. Plus the cash collected in the range.
 */
export const getPipelineSummary = query({
  args: {
    startDate: v.optional(v.number()),
    endDate: v.optional(v.number()),
  },
  handler: async (ctx, { startDate, endDate }) => {
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);

    // ── Filtered mode ──────────────────────────────────────────────────────
    // Resolve the closer's meetings inside the requested range, then count
    // their deals by position. Uses the same index the calendar does, so
    // this is bounded by what's on screen there.
    if (startDate !== undefined && endDate !== undefined) {
      if (startDate >= endDate) {
        throw new Error("startDate must be earlier than endDate");
      }

      const { counts, total, won, lost } = countStripByStage(
        await readCloserMeetingDeals(ctx, tenantId, userId, startDate, endDate),
      );

      const cash = await getCashCollectedForCloserInRange(ctx, {
        tenantId,
        userId,
        startDate,
        endDate,
      });

      return { counts, total, decided: { won, lost }, ...cash };
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
