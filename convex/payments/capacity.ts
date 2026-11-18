import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { paymentCounts } from "../lib/enrollments";

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

const OTHER_DEAL_PAYMENT_READ_LIMIT = 100;
/** Nobody logs a charge more than a day before Whop collects it. */
const LOGGED_BEFORE_COLLECTED_MS = 24 * 60 * 60 * 1000;

/**
 * An email match cannot tell whether unlinked cash on another deal is this
 * charge. Cash recorded more than a day before Whop collected the money cannot
 * be it, so a returning customer's old payments hold nothing.
 */
export async function otherDealCashHold(
  ctx: QueryCtx | MutationCtx,
  payment: Pick<Doc<"providerPayments">, "_id" | "tenantId" | "paidAt">,
  deal: Pick<Doc<"opportunities">, "_id" | "leadId">,
  personDeals?: Doc<"opportunities">[],
): Promise<"unlinked_manual_payment" | "read_limit" | null> {
  const deals = personDeals ?? await ctx.db.query("opportunities")
    .withIndex("by_tenantId_and_leadId", (q) => q.eq("tenantId", payment.tenantId).eq("leadId", deal.leadId))
    .take(DEALS_PER_PERSON_HOLD);
  if (deals.length >= DEALS_PER_PERSON_HOLD) return "read_limit";

  // The cutoff is part of the index range, so old history costs no reads.
  const since = payment.paidAt === undefined ? -Infinity : payment.paidAt - LOGGED_BEFORE_COLLECTED_MS;
  let remaining = OTHER_DEAL_PAYMENT_READ_LIMIT;
  for (const other of deals) {
    if (other._id === deal._id) continue;
    const limit = Math.min(remaining, PAYMENT_ROWS_PER_DEAL_HOLD);
    const rows = await ctx.db.query("paymentRecords")
      .withIndex("by_opportunityId_and_recordedAt", (q) => q.eq("opportunityId", other._id).gte("recordedAt", since))
      .take(limit + 1);
    if (rows.length > limit || rows.some((row) => row.tenantId !== payment.tenantId)) return "read_limit";
    if (rows.some((row) => paymentCounts(row) && !row.providerPaymentId &&
        !row.distinctFromProviderPaymentIds?.includes(payment._id))) return "unlinked_manual_payment";
    remaining -= rows.length;
  }
  return null;
}
