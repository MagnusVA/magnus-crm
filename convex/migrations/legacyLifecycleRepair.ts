import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { computeLatestActivityAt } from "../lib/opportunityActivity";
import { updateOpportunityMeetingRefs } from "../lib/opportunityMeetingRefs";
import { rebuildQualificationRowsForOpportunity } from "../operations/projections";
import { replaceOperationsMeetingStats } from "../operations/meetingStats";
import {
  meetingsByStatus,
  opportunityByStatus,
} from "../reporting/aggregates";

export type FinalOpportunityStatus =
  | "qualified_pending"
  | "scheduled"
  | "payment_received"
  | "follow_up_scheduled"
  | "reschedule_link_sent"
  | "lost"
  | "canceled"
  | "no_show";

export type FinalMeetingStatus =
  | "scheduled"
  | "completed"
  | "canceled"
  | "no_show";

type OpportunityPatch = Partial<Doc<"opportunities">>;
type MeetingPatch = Partial<Doc<"meetings">>;

export type RepairDecision = {
  opportunityPatch: OpportunityPatch;
  meetingPatch: MeetingPatch;
  evidence:
    | "payment"
    | "converted_customer"
    | "canceled"
    | "no_show"
    | "follow_up_terminal_payment"
    | "follow_up_terminal_lost"
    | "follow_up"
    | "lost"
    | "scheduled";
};

const LEGACY_OPPORTUNITY_STATUSES = new Set<Doc<"opportunities">["status"]>([
  "meeting_overran",
  "in_progress",
]);

const LEGACY_MEETING_STATUSES = new Set<Doc<"meetings">["status"]>([
  "meeting_overran",
  "in_progress",
]);

export const FINAL_OPPORTUNITY_STATUSES = [
  "qualified_pending",
  "scheduled",
  "payment_received",
  "follow_up_scheduled",
  "reschedule_link_sent",
  "lost",
  "canceled",
  "no_show",
] as const satisfies readonly FinalOpportunityStatus[];

export const FINAL_MEETING_STATUSES = [
  "scheduled",
  "completed",
  "canceled",
  "no_show",
] as const satisfies readonly FinalMeetingStatus[];

export const ACTIVE_FINAL_OPPORTUNITY_STATUSES = new Set<FinalOpportunityStatus>([
  "qualified_pending",
  "scheduled",
  "follow_up_scheduled",
  "reschedule_link_sent",
]);

export function isLegacyOpportunityStatus(
  status: Doc<"opportunities">["status"] | undefined,
): boolean {
  return status !== undefined && LEGACY_OPPORTUNITY_STATUSES.has(status);
}

export function isLegacyMeetingStatus(
  status: Doc<"meetings">["status"] | undefined,
): boolean {
  return status !== undefined && LEGACY_MEETING_STATUSES.has(status);
}

export function isFinalOpportunityStatus(
  status: Doc<"opportunities">["status"],
): status is FinalOpportunityStatus {
  return !isLegacyOpportunityStatus(status);
}

export function isFinalMeetingStatus(
  status: Doc<"meetings">["status"],
): status is FinalMeetingStatus {
  return !isLegacyMeetingStatus(status);
}

function hasKeys(patch: Record<string, unknown>): boolean {
  return Object.keys(patch).length > 0;
}

async function loadLatestPaymentForOpportunity(
  ctx: MutationCtx,
  opportunityId: Id<"opportunities">,
  meetingId?: Id<"meetings">,
): Promise<Doc<"paymentRecords"> | null> {
  const payments = await ctx.db
    .query("paymentRecords")
    .withIndex("by_opportunityId_and_recordedAt", (q) =>
      q.eq("opportunityId", opportunityId),
    )
    .order("desc")
    .take(25);

  return payments.find((payment) => payment.meetingId === meetingId) ?? payments[0] ?? null;
}

async function loadConvertedCustomer(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    leadId: Id<"leads">;
    opportunityId: Id<"opportunities">;
    meetingId?: Id<"meetings">;
  },
): Promise<Doc<"customers"> | null> {
  const customers = await ctx.db
    .query("customers")
    .withIndex("by_tenantId_and_leadId", (q) =>
      q.eq("tenantId", args.tenantId).eq("leadId", args.leadId),
    )
    .take(25);

  return (
    customers.find(
      (customer) =>
        customer.winningOpportunityId === args.opportunityId ||
        customer.winningMeetingId === args.meetingId,
    ) ?? null
  );
}

async function loadLatestFollowUpForOpportunity(
  ctx: MutationCtx,
  opportunityId: Id<"opportunities">,
): Promise<Doc<"followUps"> | null> {
  const followUps = await ctx.db
    .query("followUps")
    .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opportunityId))
    .take(50);

  return followUps.sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
}

function canceledAtFor(
  meeting: Doc<"meetings"> | null,
  opportunity: Doc<"opportunities">,
  now: number,
): number {
  return meeting?.canceledAt ?? opportunity.canceledAt ?? now;
}

function noShowAtFor(
  meeting: Doc<"meetings"> | null,
  opportunity: Doc<"opportunities">,
  now: number,
): number {
  return meeting?.noShowMarkedAt ?? opportunity.noShowAt ?? now;
}

function lostAtFor(opportunity: Doc<"opportunities">, now: number): number {
  return opportunity.lostAt ?? now;
}

function paymentDecision(recordedAt: number): RepairDecision {
  return {
    evidence: "payment",
    opportunityPatch: {
      status: "payment_received",
      paymentReceivedAt: recordedAt,
    },
    meetingPatch: {
      status: "completed",
      completedAt: recordedAt,
    },
  };
}

function convertedCustomerDecision(customer: Doc<"customers">): RepairDecision {
  return {
    evidence: "converted_customer",
    opportunityPatch: {
      status: "payment_received",
      paymentReceivedAt: customer.convertedAt,
    },
    meetingPatch: {
      status: "completed",
      completedAt: customer.convertedAt,
    },
  };
}

function canceledDecision(timestamp: number): RepairDecision {
  return {
    evidence: "canceled",
    opportunityPatch: {
      status: "canceled",
      canceledAt: timestamp,
    },
    meetingPatch: {
      status: "canceled",
      canceledAt: timestamp,
      completedAt: undefined,
    },
  };
}

function noShowDecision(timestamp: number): RepairDecision {
  return {
    evidence: "no_show",
    opportunityPatch: {
      status: "no_show",
      noShowAt: timestamp,
    },
    meetingPatch: {
      status: "no_show",
      noShowMarkedAt: timestamp,
      completedAt: timestamp,
    },
  };
}

function followUpDecision(followUp: Doc<"followUps">, now: number): RepairDecision {
  const completedAt = followUp.completedAt ?? now;

  if (followUp.completionOutcome === "payment_received") {
    return {
      evidence: "follow_up_terminal_payment",
      opportunityPatch: {
        status: "payment_received",
        paymentReceivedAt: completedAt,
      },
      meetingPatch: {
        status: "completed",
        completedAt,
      },
    };
  }

  if (
    followUp.completionOutcome === "lost" ||
    followUp.completionOutcome === "no_response_given_up"
  ) {
    return {
      evidence: "follow_up_terminal_lost",
      opportunityPatch: {
        status: "lost",
        lostAt: completedAt,
        ...(followUp.completionNote ? { lostReason: followUp.completionNote } : {}),
      },
      meetingPatch: {
        status: "completed",
        completedAt,
      },
    };
  }

  return {
    evidence: "follow_up",
    opportunityPatch: {
      status: "follow_up_scheduled",
    },
    meetingPatch: {
      status: "completed",
      completedAt: now,
    },
  };
}

function lostDecision(opportunity: Doc<"opportunities">, now: number): RepairDecision {
  const lostAt = lostAtFor(opportunity, now);
  return {
    evidence: "lost",
    opportunityPatch: {
      status: "lost",
      lostAt,
    },
    meetingPatch: {
      status: "completed",
      completedAt: lostAt,
    },
  };
}

function scheduledDecision(): RepairDecision {
  return {
    evidence: "scheduled",
    opportunityPatch: {
      status: "scheduled",
    },
    meetingPatch: {
      status: "scheduled",
      completedAt: undefined,
    },
  };
}

export async function deriveLifecycleRepair(
  ctx: MutationCtx,
  args: {
    meeting: Doc<"meetings"> | null;
    opportunity: Doc<"opportunities">;
    now: number;
  },
): Promise<RepairDecision> {
  const { meeting, opportunity, now } = args;
  const payment = await loadLatestPaymentForOpportunity(
    ctx,
    opportunity._id,
    meeting?._id,
  );
  if (payment) {
    return paymentDecision(payment.recordedAt);
  }

  const convertedCustomer = await loadConvertedCustomer(ctx, {
    tenantId: opportunity.tenantId,
    leadId: opportunity.leadId,
    opportunityId: opportunity._id,
    meetingId: meeting?._id,
  });
  if (convertedCustomer) {
    return convertedCustomerDecision(convertedCustomer);
  }

  if (
    meeting?.status === "canceled" ||
    opportunity.status === "canceled" ||
    meeting?.canceledAt !== undefined ||
    opportunity.canceledAt !== undefined
  ) {
    return canceledDecision(canceledAtFor(meeting, opportunity, now));
  }

  if (
    meeting?.status === "no_show" ||
    opportunity.status === "no_show" ||
    meeting?.noShowMarkedAt !== undefined ||
    opportunity.noShowAt !== undefined
  ) {
    return noShowDecision(noShowAtFor(meeting, opportunity, now));
  }

  const followUp = await loadLatestFollowUpForOpportunity(ctx, opportunity._id);
  if (followUp) {
    return followUpDecision(followUp, now);
  }

  if (
    opportunity.status === "lost" ||
    opportunity.lostAt !== undefined ||
    opportunity.lostByUserId !== undefined ||
    opportunity.lostReason !== undefined
  ) {
    return lostDecision(opportunity, now);
  }

  return scheduledDecision();
}

export async function deriveMeetingRepair(
  ctx: MutationCtx,
  args: {
    meeting: Doc<"meetings">;
    opportunity: Doc<"opportunities"> | null;
    now: number;
  },
): Promise<RepairDecision> {
  if (args.opportunity) {
    return await deriveLifecycleRepair(ctx, {
      meeting: args.meeting,
      opportunity: args.opportunity,
      now: args.now,
    });
  }

  return scheduledDecision();
}

export async function deriveOpportunityRepair(
  ctx: MutationCtx,
  opportunity: Doc<"opportunities">,
  now: number,
): Promise<{
  linkedMeeting: Doc<"meetings"> | null;
  repair: RepairDecision;
}> {
  const linkedMeeting = await ctx.db
    .query("meetings")
    .withIndex("by_opportunityId_and_scheduledAt", (q) =>
      q.eq("opportunityId", opportunity._id),
    )
    .order("desc")
    .first();

  return {
    linkedMeeting,
    repair: await deriveLifecycleRepair(ctx, {
      meeting: linkedMeeting,
      opportunity,
      now,
    }),
  };
}

export async function syncMeetingOpportunityStatusProjection(
  ctx: MutationCtx,
  opportunity: Doc<"opportunities">,
): Promise<void> {
  for await (const meeting of ctx.db
    .query("meetings")
    .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opportunity._id))) {
    if (meeting.opportunityStatus === opportunity.status) {
      continue;
    }

    const nextMeeting = {
      ...meeting,
      opportunityStatus: opportunity.status,
    };
    await ctx.db.patch(meeting._id, {
      opportunityStatus: opportunity.status,
    });
    await replaceOperationsMeetingStats(ctx, meeting, nextMeeting);
  }
}

export async function refreshOpportunityStatusProjections(
  ctx: MutationCtx,
  opportunityId: Id<"opportunities">,
): Promise<void> {
  const opportunity = await ctx.db.get(opportunityId);
  if (!opportunity) {
    return;
  }

  await syncMeetingOpportunityStatusProjection(ctx, opportunity);
  await updateOpportunityMeetingRefs(ctx, opportunity._id);
  await rebuildQualificationRowsForOpportunity(ctx, opportunity._id);
}

export async function applyLifecycleRepair(
  ctx: MutationCtx,
  args: {
    beforeMeeting: Doc<"meetings"> | null;
    meetingPatch: MeetingPatch;
    beforeOpportunity: Doc<"opportunities"> | null;
    opportunityPatch: OpportunityPatch;
    now: number;
  },
): Promise<void> {
  if (args.beforeMeeting && hasKeys(args.meetingPatch)) {
    await ctx.db.patch(args.beforeMeeting._id, args.meetingPatch);
    const afterMeeting = await ctx.db.get(args.beforeMeeting._id);
    if (!afterMeeting) {
      throw new Error(`Meeting ${args.beforeMeeting._id} missing after repair`);
    }
    await meetingsByStatus.replaceOrInsert(
      ctx,
      args.beforeMeeting,
      afterMeeting,
    );
    await replaceOperationsMeetingStats(
      ctx,
      args.beforeMeeting,
      afterMeeting,
    );
  }

  if (args.beforeOpportunity && hasKeys(args.opportunityPatch)) {
    const updatedAt = args.opportunityPatch.updatedAt ?? args.now;
    const nextOpportunity = {
      ...args.beforeOpportunity,
      ...args.opportunityPatch,
      updatedAt,
    };
    await ctx.db.patch(args.beforeOpportunity._id, {
      ...args.opportunityPatch,
      updatedAt,
      latestActivityAt: computeLatestActivityAt(nextOpportunity),
    });
    const afterOpportunity = await ctx.db.get(args.beforeOpportunity._id);
    if (!afterOpportunity) {
      throw new Error(
        `Opportunity ${args.beforeOpportunity._id} missing after repair`,
      );
    }
    await opportunityByStatus.replaceOrInsert(
      ctx,
      args.beforeOpportunity,
      afterOpportunity,
    );
  }

  if (args.beforeOpportunity) {
    await refreshOpportunityStatusProjections(ctx, args.beforeOpportunity._id);
  }
}
