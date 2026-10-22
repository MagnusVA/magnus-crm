import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query, type QueryCtx } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import {
  assertValidDateRange,
  getActiveClosers,
  getUserDisplayName,
  reportingUserIdentity,
} from "./lib/helpers";
import {
  deriveCallOutcomeByStage,
  needsRescheduleLinkCheck,
  type CallOutcome,
} from "./lib/outcomeDerivation";

const MAX_MEETING_SCAN_ROWS = 2000;
const MAX_PAYMENT_SCAN_ROWS = 2000;
// Far above the reschedule links one deal gets.
const RESCHEDULE_LINK_SCAN = 10;

export type OutcomeCounts = Record<CallOutcome, number>;

export function emptyOutcomeCounts(): OutcomeCounts {
  return {
    sold: 0,
    lost: 0,
    no_show: 0,
    canceled: 0,
    rescheduled: 0,
    dq: 0,
    follow_up: 0,
    scheduled: 0,
  };
}

/** What the team report derives each meeting's outcome from. */
export type TeamOutcomeInputs = {
  meetings: Array<Doc<"meetings">>;
  opportunityById: Map<Id<"opportunities">, Doc<"opportunities"> | null>;
  opportunityHasPayment: Set<Id<"opportunities">>;
  rescheduledMeetingIds: Set<Id<"meetings">>;
  isTruncated: boolean;
};

/**
 * The meetings scheduled in the range with their deals, the deals paid in the
 * range, and the meetings another meeting in the range reschedules.
 */
export async function readTeamOutcomeInputs(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  startDate: number,
  endDate: number,
): Promise<TeamOutcomeInputs> {
  const [meetingRows, paymentRows] = await Promise.all([
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

  const opportunityIds = [
    ...new Set(meetings.map((meeting) => meeting.opportunityId)),
  ];
  const opportunities = await Promise.all(
    opportunityIds.map(async (opportunityId) => [
      opportunityId,
      await ctx.db.get("opportunities", opportunityId),
    ] as const),
  );
  const opportunityById = new Map<
    Id<"opportunities">,
    Doc<"opportunities"> | null
  >(opportunities);

  const opportunityHasPayment = new Set<Id<"opportunities">>();
  for (const payment of payments) {
    // Every payment is a deal payment (docs/plans/phase-4-customers.md D12).
    if (payment.status !== "disputed" && payment.opportunityId) {
      opportunityHasPayment.add(payment.opportunityId);
    }
  }

  const rescheduledMeetingIds = new Set<Id<"meetings">>();
  for (const meeting of meetings) {
    if (meeting.rescheduledFromMeetingId) {
      rescheduledMeetingIds.add(meeting.rescheduledFromMeetingId);
    }
  }

  return {
    meetings,
    opportunityById,
    opportunityHasPayment,
    rescheduledMeetingIds,
    isTruncated,
  };
}

export type MeetingOutcome = {
  meeting: Doc<"meetings">;
  opportunity: Doc<"opportunities">;
  outcome: CallOutcome;
};

/**
 * Whether the deal has a pending reschedule link: the scheduling link task a
 * closer sends after a no-show (§4.5).
 */
export async function hasPendingRescheduleLink(
  ctx: QueryCtx,
  opportunityId: Id<"opportunities">,
): Promise<boolean> {
  const links = await ctx.db
    .query("followUps")
    .withIndex("by_opportunityId_and_status_and_reason", (q) =>
      q
        .eq("opportunityId", opportunityId)
        .eq("status", "pending")
        .eq("reason", "no_show_follow_up"),
    )
    .take(RESCHEDULE_LINK_SCAN);
  return links.some((link) => link.type === "scheduling_link");
}

/**
 * Each meeting's outcome from its deal's stage and outcome (§6.6). It reads
 * the reschedule links of the deals at Follow-up whose meeting was held, the
 * only ones the derivation needs them for.
 */
export async function meetingOutcomesByStage(
  ctx: QueryCtx,
  inputs: TeamOutcomeInputs,
): Promise<MeetingOutcome[]> {
  const linkChecks = new Map<Id<"opportunities">, Promise<boolean>>();
  const outcomes: MeetingOutcome[] = [];
  for (const meeting of inputs.meetings) {
    const opportunity = inputs.opportunityById.get(meeting.opportunityId);
    if (!opportunity) {
      continue;
    }
    let hasLink = false;
    if (needsRescheduleLinkCheck(meeting, opportunity)) {
      let check = linkChecks.get(opportunity._id);
      if (!check) {
        check = hasPendingRescheduleLink(ctx, opportunity._id);
        linkChecks.set(opportunity._id, check);
      }
      hasLink = await check;
    }
    outcomes.push({
      meeting,
      opportunity,
      outcome: deriveCallOutcomeByStage(
        meeting,
        opportunity,
        inputs.opportunityHasPayment.has(meeting.opportunityId),
        inputs.rescheduledMeetingIds.has(meeting._id),
        hasLink,
      ),
    });
  }
  return outcomes;
}

export function tallyOutcomesByCloser(
  outcomes: MeetingOutcome[],
): Map<Id<"users">, OutcomeCounts> {
  const perCloser = new Map<Id<"users">, OutcomeCounts>();
  for (const { meeting, outcome } of outcomes) {
    const counts = perCloser.get(meeting.assignedCloserId) ?? emptyOutcomeCounts();
    counts[outcome] += 1;
    perCloser.set(meeting.assignedCloserId, counts);
  }
  return perCloser;
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

    const [closers, inputs] = await Promise.all([
      getActiveClosers(ctx, tenantId),
      readTeamOutcomeInputs(ctx, tenantId, startDate, endDate),
    ]);
    // Each meeting's outcome from its deal's stage, outcome and loss
    // (docs/plans/phase-5-deal-status.md §6.6).
    const perCloser = tallyOutcomesByCloser(await meetingOutcomesByStage(ctx, inputs));

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
      closerOutcomes: await Promise.all(closers.map(async (closer) => ({
        closerId: closer._id,
        closerName: getUserDisplayName(closer),
        closer: await reportingUserIdentity(ctx, closer),
        outcomes: perCloser.get(closer._id) ?? emptyOutcomeCounts(),
      }))),
      derived: {
        lostDeals: teamOutcome.lost,
        rebookRate,
        rebookNumerator: teamOutcome.rescheduled,
        rebookDenominator,
      },
      isTruncated: inputs.isTruncated,
    };
  },
});
