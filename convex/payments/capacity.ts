import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

// How much one write may add before a person has to look (build contract
// §2.2). Both are holds, not errors: past them, a reader that derives from
// every row (enrollments, the matcher) would have to read part of a range.

/** Stored rows on one deal, disputed included. The 40th insert is the last. */
export const PAYMENT_ROWS_PER_DEAL_HOLD = 40;
/** Deals one person has. A person with 100 deals gets no new payment row. */
export const DEALS_PER_PERSON_HOLD = 100;

/**
 * Whether one more payment row fits on the deal and the person. Read inside
 * the inserting mutation, so a concurrent insert on either range re-runs it.
 */
export async function checkPaymentCapacity(
  ctx: QueryCtx | MutationCtx,
  args: { opportunityId: Id<"opportunities">; leadId: Id<"leads"> },
): Promise<{ ok: true } | { ok: false; code: "capacity_hold"; bound: "deal_payments" | "person_deals" }> {
  const deal = await ctx.db.get("opportunities", args.opportunityId);
  if (!deal) throw new Error(`Deal ${args.opportunityId} not found`);

  const rows = await ctx.db.query("paymentRecords")
    .withIndex("by_opportunityId_and_recordedAt", (q) => q.eq("opportunityId", args.opportunityId))
    .take(PAYMENT_ROWS_PER_DEAL_HOLD);
  if (rows.length >= PAYMENT_ROWS_PER_DEAL_HOLD) return { ok: false, code: "capacity_hold", bound: "deal_payments" };

  const deals = await ctx.db.query("opportunities")
    .withIndex("by_tenantId_and_leadId", (q) => q.eq("tenantId", deal.tenantId).eq("leadId", args.leadId))
    .take(DEALS_PER_PERSON_HOLD);
  if (deals.length >= DEALS_PER_PERSON_HOLD) return { ok: false, code: "capacity_hold", bound: "person_deals" };

  return { ok: true };
}
