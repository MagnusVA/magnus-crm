import { stopCallDecisionsOnPayment } from "../automation/paymentHooks";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { checkPaymentCapacity } from "../payments/capacity";
import { insertPaymentAggregate } from "../reporting/writeHooks";
import { recordPayment } from "./leadLifecycle";
import { expectedError } from "./observability/errors";

type RowFields = Omit<
  Doc<"paymentRecords">,
  "_id" | "_creationTime" | "status" | "statusChangedAt" | "opportunityId" | "attributedCloserId" | "recordedByUserId"
> & {
  opportunityId: Id<"opportunities">;
  attributedCloserId: Id<"users">;
};

/** Every writer a person stands behind: the row names its recorder. */
export type PaymentWriteFields = RowFields & {
  recordedByUserId: Id<"users">;
};

/**
 * An automatic write (phase 3 contract §2.13): a Whop payment the system
 * recorded with no person. It names the automatic decision that wrote it,
 * which becomes its applied receipt in the same mutation (invariant A9).
 */
export type AutomaticPaymentWriteFields = Omit<RowFields, "origin" | "recordedVia" | "automationDecisionId" | "providerPaymentId"> & {
  origin: "provider";
  recordedVia: "provider";
  automationDecisionId: Id<"resultAutomationDecisions">;
  providerPaymentId: Id<"providerPayments">;
};

async function insertRow(ctx: MutationCtx, fields: RowFields & { recordedByUserId?: Id<"users"> }) {
  const deal = await ctx.db.get("opportunities", fields.opportunityId);
  if (!deal || deal.tenantId !== fields.tenantId) throw new Error("Payment deal not found");
  const capacity = await checkPaymentCapacity(ctx, {
    opportunityId: deal._id,
    leadId: deal.leadId,
  });
  if (!capacity.ok) {
    throw expectedError("payment.capacity_hold", "This payment would exceed the CRM's payment capacity. Contact Billing.");
  }
  const paymentId = await ctx.db.insert("paymentRecords", {
    ...fields,
    status: "recorded",
    statusChangedAt: fields.recordedAt,
  });
  await recordPayment(ctx, paymentId);
  await insertPaymentAggregate(ctx, paymentId);
  // Money for this person cancels a pending refusal on any of their deals.
  await stopCallDecisionsOnPayment(ctx, {
    tenantId: deal.tenantId,
    leadId: deal.leadId,
    opportunityId: deal._id,
    paidAt: fields.recordedAt,
    refusalOnly: true,
  });
  return paymentId;
}

export async function insertRecordedPayment(
  ctx: MutationCtx,
  fields: PaymentWriteFields,
): Promise<Id<"paymentRecords">> {
  // A caller that loses its recorder through a cast still fails here.
  if (!fields.recordedByUserId) throw new Error("A recorded payment needs its recorder");
  return await insertRow(ctx, fields);
}

/**
 * The only way to insert a payment row with no recorder. Kept apart from
 * `insertRecordedPayment` so no existing writer can drop its recorder by
 * accident. Throws unless the row is a provider row naming its decision.
 */
export async function insertAutomaticPayment(
  ctx: MutationCtx,
  fields: AutomaticPaymentWriteFields,
): Promise<Id<"paymentRecords">> {
  const loose = fields as AutomaticPaymentWriteFields & { recordedByUserId?: unknown };
  if (fields.origin !== "provider" || fields.recordedVia !== "provider" || !fields.automationDecisionId ||
      !fields.providerPaymentId || loose.recordedByUserId !== undefined) {
    throw new Error("A payment with no recorder must be a provider row an automatic decision wrote");
  }
  const decision = await ctx.db.get("resultAutomationDecisions", fields.automationDecisionId);
  if (decision?.tenantId !== fields.tenantId || decision.mode !== "automatic" || decision.state !== "ready" ||
      decision.providerPaymentId !== fields.providerPaymentId || decision.opportunityId !== fields.opportunityId) {
    throw new Error(`Decision ${fields.automationDecisionId} is not a ready automatic decision for this payment`);
  }
  return await insertRow(ctx, fields);
}
