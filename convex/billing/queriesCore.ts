import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { enrichBillingPaymentDetail } from "./enrichment";

/** Same tenant check and enrichment as the public billing detail reader. */
export async function buildPaymentDetail(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  paymentRecordId: Id<"paymentRecords">,
) {
  const payment = await ctx.db.get("paymentRecords", paymentRecordId);
  if (!payment || payment.tenantId !== tenantId) return null;
  return await enrichBillingPaymentDetail(ctx, tenantId, payment);
}
