import type { QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { readLiveQueryRows } from "../lib/liveQueryBounds";
const OPEN_COUNT_LIMIT = 99;
export async function buildBookingReviewCount(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
) {
  // A bounded live read, not an aggregate: the banner shows "99+" past the
  // bound, and the queue is empty on most days.
  const { rows, capped } = await readLiveQueryRows(
    ctx.db
      .query("bookingReviews")
      .withIndex("by_tenantId_and_status_and_createdAt", (q) =>
        q.eq("tenantId", tenantId).eq("status", "open"),
      ),
    OPEN_COUNT_LIMIT,
  );
  return { count: rows.length, capped };
}
