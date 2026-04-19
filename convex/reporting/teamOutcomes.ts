import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import {
  assertValidDateRange,
  getActiveClosers,
  getUserDisplayName,
} from "./lib/helpers";
import {
  deriveCallOutcome,
  type CallOutcome,
} from "./lib/outcomeDerivation";

const MAX_MEETING_SCAN_ROWS = 2000;
const MAX_PAYMENT_SCAN_ROWS = 2000;

type OutcomeCounts = Record<CallOutcome, number>;

function emptyOutcomeCounts(): OutcomeCounts {
  return {
    sold: 0,
    lost: 0,
    no_show: 0,
    canceled: 0,
    rescheduled: 0,
    dq: 0,
    follow_up: 0,
    in_progress: 0,
    scheduled: 0,
  };
}

export const getTeamOutcomeMix = query({
  args: {
    startDate: v.number(),
    endDate: v.number(),
  },
  handler: async (ctx, { startDate, endDate }) => {
    assertValidDateRange(startDate, endDate);

    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const [closers, meetingRows, paymentRows] = await Promise.all([
      getActiveClosers(ctx, tenantId),
      ctx.db
        .query("meetings")
        .withIndex("by_tenantId_and_scheduledAt", (q) =>
          q.eq("tenantId", tenantId).gte("scheduledAt", startDate).lt("scheduledAt", endDate),
        )
        .take(MAX_MEETING_SCAN_ROWS + 1),
      ctx.db
        .query("paymentRecords")
        .withIndex("by_tenantId_and_recordedAt", (q) =>
          q.eq("tenantId", tenantId).gte("recordedAt", startDate).lt("recordedAt", endDate),
        )
        .take(MAX_PAYMENT_SCAN_ROWS + 1),
    ]);

    const meetings = meetingRows.slice(0, MAX_MEETING_SCAN_ROWS);
    const payments = paymentRows.slice(0, MAX_PAYMENT_SCAN_ROWS);
    const isTruncated =
      meetingRows.length > MAX_MEETING_SCAN_ROWS ||
      paymentRows.length > MAX_PAYMENT_SCAN_ROWS;

    const perCloser = new Map<Id<"users">, OutcomeCounts>();
    const opportunityIds = [
      ...new Set(meetings.map((meeting) => meeting.opportunityId)),
    ];
    const opportunities = await Promise.all(
      opportunityIds.map(async (opportunityId) => [
        opportunityId,
        await ctx.db.get(opportunityId),
      ] as const),
    );
    const opportunityById = new Map<
      Id<"opportunities">,
      Doc<"opportunities"> | null
    >(opportunities);

    const opportunityHasPayment = new Set<Id<"opportunities">>();
    for (const payment of payments) {
      if (
        payment.status !== "disputed" &&
        payment.contextType === "opportunity" &&
        payment.opportunityId
      ) {
        opportunityHasPayment.add(payment.opportunityId);
      }
    }

    const rescheduledMeetingIds = new Set<Id<"meetings">>();
    for (const meeting of meetings) {
      if (meeting.rescheduledFromMeetingId) {
        rescheduledMeetingIds.add(meeting.rescheduledFromMeetingId);
      }
    }

    for (const meeting of meetings) {
      const opportunity = opportunityById.get(meeting.opportunityId);
      if (!opportunity) {
        continue;
      }

      const counts = perCloser.get(meeting.assignedCloserId) ?? emptyOutcomeCounts();
      const outcome = deriveCallOutcome(
        meeting,
        opportunity,
        opportunityHasPayment.has(meeting.opportunityId),
        rescheduledMeetingIds.has(meeting._id),
      );
      counts[outcome] += 1;
      perCloser.set(meeting.assignedCloserId, counts);
    }

    const teamOutcome = Array.from(perCloser.values()).reduce<OutcomeCounts>(
      (accumulator, counts) => {
        for (const outcome of Object.keys(counts) as CallOutcome[]) {
          accumulator[outcome] += counts[outcome];
        }
        return accumulator;
      },
      emptyOutcomeCounts(),
    );

    const rebookDenominator = teamOutcome.canceled + teamOutcome.no_show;
    const rebookRate =
      rebookDenominator > 0 ? teamOutcome.rescheduled / rebookDenominator : null;

    return {
      teamOutcome,
      closerOutcomes: closers.map((closer) => ({
        closerId: closer._id,
        closerName: getUserDisplayName(closer),
        outcomes: perCloser.get(closer._id) ?? emptyOutcomeCounts(),
      })),
      derived: {
        lostDeals: teamOutcome.lost,
        rebookRate,
        rebookNumerator: teamOutcome.rescheduled,
        rebookDenominator,
      },
      isTruncated,
    };
  },
});
