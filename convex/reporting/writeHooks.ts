import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import {
  insertBillingPaymentAggregates,
  replaceBillingPaymentAggregates,
} from "../billing/aggregates";
import { rebuildLeadCustomerSearchRow } from "../leadCustomers/projection";
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
  isSlackQualificationAggregateEligible,
  meetingsByStatus,
  opportunityByStage,
  paymentSums,
  slackQualificationsByTime,
  slackQualificationsByUser,
} from "./aggregates";

import {
  deletePipelineHealthAggregates,
  insertPipelineHealthAggregates,
  replacePipelineHealthAggregates,
} from "./pipelineHealthAggregates";

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
  const meeting = await ctx.db.get("meetings", meetingId);
  if (!meeting) {
    throw new Error(`Meeting ${meetingId} not found for reporting aggregate sync`);
  }
  return meeting;
}

async function getOpportunityOrThrow(
  ctx: MutationCtx,
  opportunityId: Id<"opportunities">,
): Promise<Doc<"opportunities">> {
  const opportunity = await ctx.db.get("opportunities", opportunityId);
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
  const payment = await ctx.db.get("paymentRecords", paymentId);
  if (!payment) {
    throw new Error(`Payment ${paymentId} not found for reporting aggregate sync`);
  }
  return payment;
}

export async function insertMeetingAggregate(
  ctx: MutationCtx,
  meetingId: Id<"meetings">,
): Promise<Doc<"meetings">> {
  const meeting = await getMeetingOrThrow(ctx, meetingId);
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
  const meeting = await getMeetingOrThrow(ctx, meetingId);
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
  await opportunityByStage.insert(ctx, opportunity);
  await insertPipelineHealthAggregates(ctx, opportunity);
  if (isSlackQualificationAggregateEligible(opportunity)) {
    await slackQualificationsByUser.insert(ctx, opportunity);
    await slackQualificationsByTime.insert(ctx, opportunity);
  }
  await upsertOpportunitySearchProjection(ctx, opportunityId);
  await rebuildLeadCustomerSearchRow(
    ctx,
    opportunity.tenantId,
    opportunity.leadId,
  );
  return opportunity;
}

export async function replaceOpportunityAggregate(
  ctx: MutationCtx,
  oldOpportunity: Doc<"opportunities">,
  opportunityId: Id<"opportunities">,
): Promise<Doc<"opportunities">> {
  const opportunity = await getOpportunityOrThrow(ctx, opportunityId);
  await opportunityByStage.replace(ctx, oldOpportunity, opportunity);
  await replacePipelineHealthAggregates(ctx, oldOpportunity, opportunity);

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
  await rebuildLeadCustomerSearchRow(
    ctx,
    opportunity.tenantId,
    opportunity.leadId,
  );
  return opportunity;
}

export async function deleteOpportunityAggregate(
  ctx: MutationCtx,
  oldOpportunity: Doc<"opportunities">,
): Promise<void> {
  await opportunityByStage.delete(ctx, oldOpportunity);
  await deletePipelineHealthAggregates(ctx, oldOpportunity);
  if (isSlackQualificationAggregateEligible(oldOpportunity)) {
    await slackQualificationsByUser.deleteIfExists(ctx, oldOpportunity);
    await slackQualificationsByTime.deleteIfExists(ctx, oldOpportunity);
  }
  await deleteOpportunitySearchProjection(ctx, oldOpportunity._id);
}

export async function insertPaymentAggregate(
  ctx: MutationCtx,
  paymentId: Id<"paymentRecords">,
): Promise<Doc<"paymentRecords">> {
  const payment = await getPaymentOrThrow(ctx, paymentId);
  await insertBillingPaymentAggregates(ctx, payment);
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
  await replaceBillingPaymentAggregates(ctx, oldPayment, payment);

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
