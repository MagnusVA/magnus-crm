import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import {
  customerConversions,
  leadTimeline,
  meetingsByStatus,
  opportunityByStatus,
  paymentSums,
} from "./aggregates";

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

export async function insertMeetingAggregate(
  ctx: MutationCtx,
  meetingId: Id<"meetings">,
): Promise<Doc<"meetings">> {
  const meeting = await getMeetingOrThrow(ctx, meetingId);
  await meetingsByStatus.insert(ctx, meeting);
  return meeting;
}

export async function replaceMeetingAggregate(
  ctx: MutationCtx,
  oldMeeting: Doc<"meetings">,
  meetingId: Id<"meetings">,
): Promise<Doc<"meetings">> {
  const meeting = await getMeetingOrThrow(ctx, meetingId);
  await meetingsByStatus.replace(ctx, oldMeeting, meeting);
  return meeting;
}

export async function insertOpportunityAggregate(
  ctx: MutationCtx,
  opportunityId: Id<"opportunities">,
): Promise<Doc<"opportunities">> {
  const opportunity = await getOpportunityOrThrow(ctx, opportunityId);
  await opportunityByStatus.insert(ctx, opportunity);
  return opportunity;
}

export async function replaceOpportunityAggregate(
  ctx: MutationCtx,
  oldOpportunity: Doc<"opportunities">,
  opportunityId: Id<"opportunities">,
): Promise<Doc<"opportunities">> {
  const opportunity = await getOpportunityOrThrow(ctx, opportunityId);
  await opportunityByStatus.replace(ctx, oldOpportunity, opportunity);
  return opportunity;
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
  await paymentSums.insert(ctx, payment);
  return payment;
}

export async function replacePaymentAggregate(
  ctx: MutationCtx,
  oldPayment: Doc<"paymentRecords">,
  paymentId: Id<"paymentRecords">,
): Promise<Doc<"paymentRecords">> {
  const payment = await getPaymentOrThrow(ctx, paymentId);
  await paymentSums.replace(ctx, oldPayment, payment);
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
