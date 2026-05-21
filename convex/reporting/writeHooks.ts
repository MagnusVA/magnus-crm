import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import {
  resolveLegacyCompatibleAttributedCloserId,
  resolveLegacyCompatiblePaymentCommissionable,
} from "../lib/paymentTypes";
import {
  deleteOpportunitySearchProjection,
  upsertOpportunitySearchProjection,
} from "../lib/opportunitySearch";
import {
  insertOperationsMeetingStats,
  replaceOperationsMeetingStats,
} from "../operations/meetingStats";
import {
  customerConversions,
  isSlackQualificationAggregateEligible,
  leadTimeline,
  meetingsByStatus,
  opportunityByStatus,
  paymentSums,
  slackQualificationsByTime,
  slackQualificationsByUser,
} from "./aggregates";

function isPaymentAggregateEligible(payment: Doc<"paymentRecords">): boolean {
  return (
    resolveLegacyCompatiblePaymentCommissionable(payment) &&
    resolveLegacyCompatibleAttributedCloserId(payment) !== undefined
  );
}

async function getMeetingOrThrow(
  ctx: MutationCtx,
  meetingId: Id<"meetings">,
): Promise<Doc<"meetings">> {
  const meeting = await ctx.db.get(meetingId);
  if (!meeting) {
    throw new Error(`Meeting ${meetingId} not found for reporting aggregate sync`);
  }
  return meeting;
}

async function getOpportunityOrThrow(
  ctx: MutationCtx,
  opportunityId: Id<"opportunities">,
): Promise<Doc<"opportunities">> {
  const opportunity = await ctx.db.get(opportunityId);
  if (!opportunity) {
    throw new Error(
      `Opportunity ${opportunityId} not found for reporting aggregate sync`,
    );
  }
  return opportunity;
}

async function getPaymentOrThrow(
  ctx: MutationCtx,
  paymentId: Id<"paymentRecords">,
): Promise<Doc<"paymentRecords">> {
  const payment = await ctx.db.get(paymentId);
  if (!payment) {
    throw new Error(`Payment ${paymentId} not found for reporting aggregate sync`);
  }
  return payment;
}

async function getMeetingWithOpportunityStatus(
  ctx: MutationCtx,
  meetingId: Id<"meetings">,
): Promise<Doc<"meetings">> {
  const meeting = await getMeetingOrThrow(ctx, meetingId);
  const opportunity = await ctx.db.get(meeting.opportunityId);
  const opportunityStatus = opportunity?.status;
  if (meeting.opportunityStatus !== opportunityStatus) {
    await ctx.db.patch(meeting._id, { opportunityStatus });
    return { ...meeting, opportunityStatus };
  }
  return meeting;
}

async function syncMeetingOpportunityStatusForOpportunity(
  ctx: MutationCtx,
  opportunity: Doc<"opportunities">,
) {
  const meetings = await ctx.db
    .query("meetings")
    .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opportunity._id))
    .take(200);

  await Promise.all(
    meetings.map(async (meeting) => {
      if (meeting.opportunityStatus === opportunity.status) {
        return;
      }
      const nextMeeting = {
        ...meeting,
        opportunityStatus: opportunity.status,
      };
      await ctx.db.patch(meeting._id, {
        opportunityStatus: opportunity.status,
      });
      await replaceOperationsMeetingStats(ctx, meeting, nextMeeting);
    }),
  );
}

export async function insertMeetingAggregate(
  ctx: MutationCtx,
  meetingId: Id<"meetings">,
): Promise<Doc<"meetings">> {
  const meeting = await getMeetingWithOpportunityStatus(ctx, meetingId);
  await Promise.all([
    meetingsByStatus.insert(ctx, meeting),
    insertOperationsMeetingStats(ctx, meeting),
  ]);
  return meeting;
}

export async function replaceMeetingAggregate(
  ctx: MutationCtx,
  oldMeeting: Doc<"meetings">,
  meetingId: Id<"meetings">,
): Promise<Doc<"meetings">> {
  const meeting = await getMeetingWithOpportunityStatus(ctx, meetingId);
  await Promise.all([
    meetingsByStatus.replace(ctx, oldMeeting, meeting),
    replaceOperationsMeetingStats(ctx, oldMeeting, meeting),
  ]);
  return meeting;
}

export async function insertOpportunityAggregate(
  ctx: MutationCtx,
  opportunityId: Id<"opportunities">,
): Promise<Doc<"opportunities">> {
  const opportunity = await getOpportunityOrThrow(ctx, opportunityId);
  await opportunityByStatus.insert(ctx, opportunity);
  if (isSlackQualificationAggregateEligible(opportunity)) {
    await slackQualificationsByUser.insert(ctx, opportunity);
    await slackQualificationsByTime.insert(ctx, opportunity);
  }
  await upsertOpportunitySearchProjection(ctx, opportunityId);
  return opportunity;
}

export async function replaceOpportunityAggregate(
  ctx: MutationCtx,
  oldOpportunity: Doc<"opportunities">,
  opportunityId: Id<"opportunities">,
): Promise<Doc<"opportunities">> {
  const opportunity = await getOpportunityOrThrow(ctx, opportunityId);
  await opportunityByStatus.replace(ctx, oldOpportunity, opportunity);

  const oldEligible = isSlackQualificationAggregateEligible(oldOpportunity);
  const nextEligible = isSlackQualificationAggregateEligible(opportunity);
  if (oldEligible && nextEligible) {
    await slackQualificationsByUser.replaceOrInsert(
      ctx,
      oldOpportunity,
      opportunity,
    );
    await slackQualificationsByTime.replaceOrInsert(
      ctx,
      oldOpportunity,
      opportunity,
    );
  } else if (oldEligible) {
    await slackQualificationsByUser.deleteIfExists(ctx, oldOpportunity);
    await slackQualificationsByTime.deleteIfExists(ctx, oldOpportunity);
  } else if (nextEligible) {
    await slackQualificationsByUser.insertIfDoesNotExist(ctx, opportunity);
    await slackQualificationsByTime.insertIfDoesNotExist(ctx, opportunity);
  }

  await upsertOpportunitySearchProjection(ctx, opportunityId);
  if (oldOpportunity.status !== opportunity.status) {
    await syncMeetingOpportunityStatusForOpportunity(ctx, opportunity);
  }
  return opportunity;
}

export async function deleteOpportunityAggregate(
  ctx: MutationCtx,
  oldOpportunity: Doc<"opportunities">,
): Promise<void> {
  await opportunityByStatus.deleteIfExists(ctx, oldOpportunity);
  if (isSlackQualificationAggregateEligible(oldOpportunity)) {
    await slackQualificationsByUser.deleteIfExists(ctx, oldOpportunity);
    await slackQualificationsByTime.deleteIfExists(ctx, oldOpportunity);
  }
  await deleteOpportunitySearchProjection(ctx, oldOpportunity._id);
}

export async function insertLeadAggregate(
  ctx: MutationCtx,
  leadId: Id<"leads">,
): Promise<Doc<"leads">> {
  const lead = await ctx.db.get(leadId);
  if (!lead) {
    throw new Error(`Lead ${leadId} not found for reporting aggregate sync`);
  }
  await leadTimeline.insert(ctx, lead);
  return lead;
}

export async function insertPaymentAggregate(
  ctx: MutationCtx,
  paymentId: Id<"paymentRecords">,
): Promise<Doc<"paymentRecords">> {
  const payment = await getPaymentOrThrow(ctx, paymentId);
  if (isPaymentAggregateEligible(payment)) {
    await paymentSums.insert(ctx, payment);
  }
  return payment;
}

export async function replacePaymentAggregate(
  ctx: MutationCtx,
  oldPayment: Doc<"paymentRecords">,
  paymentId: Id<"paymentRecords">,
): Promise<Doc<"paymentRecords">> {
  const payment = await getPaymentOrThrow(ctx, paymentId);
  const oldEligible = isPaymentAggregateEligible(oldPayment);
  const nextEligible = isPaymentAggregateEligible(payment);

  if (oldEligible && nextEligible) {
    // Legacy rows may become aggregate-eligible during a widen/migrate rollout
    // before they were ever inserted into the aggregate. Use the idempotent
    // path so backfills can safely repair or create the aggregate entry.
    await paymentSums.replaceOrInsert(ctx, oldPayment, payment);
  } else if (oldEligible) {
    await paymentSums.deleteIfExists(ctx, oldPayment);
  } else if (nextEligible) {
    await paymentSums.insertIfDoesNotExist(ctx, payment);
  }
  return payment;
}

export async function insertCustomerAggregate(
  ctx: MutationCtx,
  customerId: Id<"customers">,
): Promise<Doc<"customers">> {
  const customer = await ctx.db.get(customerId);
  if (!customer) {
    throw new Error(
      `Customer ${customerId} not found for reporting aggregate sync`,
    );
  }
  await customerConversions.insert(ctx, customer);
  return customer;
}

export async function deleteCustomerAggregate(
  ctx: MutationCtx,
  customerId: Id<"customers">,
): Promise<void> {
  const customer = await ctx.db.get(customerId);
  if (!customer) {
    return;
  }
  await customerConversions.delete(ctx, customer);
}
