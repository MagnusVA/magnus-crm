import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { listFirstEnrollmentsInRange } from "../enrollments/firstEnrollments";

// New customers the dashboard reads in one period at most; past it the count
// is a lower bound. Production has 274 customers in all.
export const MAX_NEW_CUSTOMER_SCAN_ROWS = 2500;

/** A period's new customers; `isTruncated` says the read stopped at its cap. */
export type NewCustomerCount = { count: number; isTruncated: boolean };

/**
 * People whose first enrollment falls in [periodStart, periodEnd): a second
 * program doesn't count a person again (docs/plans/phase-4-customers.md §6.3).
 */
export async function countNewCustomersFromEnrollments(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  periodStart: number,
  periodEnd: number,
): Promise<NewCustomerCount> {
  const { enrollments, isTruncated } = await listFirstEnrollmentsInRange(
    ctx,
    tenantId,
    periodStart,
    periodEnd,
    MAX_NEW_CUSTOMER_SCAN_ROWS,
  );
  return { count: enrollments.length, isTruncated };
}
