import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { checkPaymentCapacity } from "../payments/capacity";
import { insertPaymentAggregate } from "../reporting/writeHooks";
import { recordPayment } from "./leadLifecycle";
import { expectedError } from "./observability/errors";

export type PaymentWriteFields = Omit<
  Doc<"paymentRecords">,
  "_id" | "_creationTime" | "status" | "statusChangedAt" | "opportunityId" | "attributedCloserId" | "recordedByUserId"
> & {
  opportunityId: Id<"opportunities">;
  attributedCloserId: Id<"users">;
  recordedByUserId: Id<"users">;
};

export async function insertRecordedPayment(
  ctx: MutationCtx,
  fields: PaymentWriteFields,
): Promise<Id<"paymentRecords">> {
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
  return paymentId;
}
