import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { listPersonEnrollments } from "./read";

// Payments on one deal at one instant: a handful at most.
const SAME_TIME_PAYMENT_LIMIT = 20;

/**
 * The enrollments in [startDate, endDate) that are their person's first, in
 * `enrolledAt` order. A person who buys a second program counts once, at
 * their first (docs/plans/phase-4-customers.md §6.3). Reads at most `limit`
 * enrollments in the range; `isTruncated` says the range held more.
 */
export async function listFirstEnrollmentsInRange(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  startDate: number,
  endDate: number,
  limit: number,
): Promise<{ enrollments: Doc<"enrollments">[]; isTruncated: boolean }> {
  const rows = await ctx.db
    .query("enrollments")
    .withIndex("by_tenantId_and_enrolledAt", (q) =>
      q.eq("tenantId", tenantId).gte("enrolledAt", startDate).lt("enrolledAt", endDate),
    )
    .take(limit + 1);
  const inRange = rows.slice(0, limit);

  const leadIds = [...new Set(inRange.map((enrollment) => enrollment.leadId))];
  const firstPairs = await Promise.all(
    leadIds.map(async (leadId) => {
      const [first] = await listPersonEnrollments(ctx, tenantId, leadId);
      return [leadId, first?._id] as const;
    }),
  );
  const firstByLead = new Map<Id<"leads">, Id<"enrollments"> | undefined>(firstPairs);

  return {
    enrollments: inRange.filter(
      (enrollment) => firstByLead.get(enrollment.leadId) === enrollment._id,
    ),
    isTruncated: rows.length > limit,
  };
}

/**
 * The payment an enrollment's times come from: on its deal, for its program,
 * not disputed, at its `enrolledAt`, the earliest created (§4.1). Null when
 * the enrollment is stale.
 */
export async function enrollmentFirstPayment(
  ctx: QueryCtx,
  enrollment: Pick<Doc<"enrollments">, "tenantId" | "opportunityId" | "programId" | "enrolledAt">,
): Promise<Doc<"paymentRecords"> | null> {
  const payments = await ctx.db
    .query("paymentRecords")
    .withIndex("by_opportunityId_and_recordedAt", (q) =>
      q.eq("opportunityId", enrollment.opportunityId).eq("recordedAt", enrollment.enrolledAt),
    )
    .take(SAME_TIME_PAYMENT_LIMIT);
  return (
    payments.find(
      (payment) =>
        payment.tenantId === enrollment.tenantId &&
        payment.programId === enrollment.programId &&
        payment.status !== "disputed",
    ) ?? null
  );
}
