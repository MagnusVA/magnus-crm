import type { Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import {
  readLiveDocuments,
  readLiveQueryRows,
} from "../../../lib/liveQueryBounds";
import { readOwedTotal } from "../../../reports/pipeline";
import { meetingAttendanceDisplay } from "../../../../lib/status-config";

/**
 * Scheduled meetings that started by `cutoff`. The caller freezes `cutoff`
 * (the queue keeps it in its cursor), so every page reads the same index
 * range: a bound recomputed from Date.now() on each call is a different query,
 * and Convex refuses the previous page's cursor for it.
 */
export function scheduledCandidates(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  cutoff: number,
  closerId?: Id<"users">,
) {
  return closerId
    ? ctx.db
        .query("meetings")
        .withIndex(
          "by_tenantId_and_assignedCloserId_and_status_and_scheduledAt",
          (q) =>
            q
              .eq("tenantId", tenantId)
              .eq("assignedCloserId", closerId)
              .eq("status", "scheduled")
              .lte("scheduledAt", cutoff),
        )
    : ctx.db
        .query("meetings")
        .withIndex("by_tenantId_and_status_and_scheduledAt", (q) =>
          q
            .eq("tenantId", tenantId)
            .eq("status", "scheduled")
            .lte("scheduledAt", cutoff),
        );
}

/**
 * The whole not-recorded backlog as of `now`: the exact count from the
 * Pipeline report's aggregate path, or null with the bounded scan's lower
 * bound when the aggregate can't vouch for it.
 */
export async function countNotRecorded(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  now: number,
) {
  const scheduled = await readLiveQueryRows(
    scheduledCandidates(ctx, tenantId, now),
    500,
  );
  const due = scheduled.rows.filter(
    (row) => meetingAttendanceDisplay(row, now) === "not_recorded",
  );
  const exact = await readOwedTotal(ctx, tenantId, now, scheduled);
  return {
    count: exact,
    atLeast: due.length,
    oldest: due.length
      ? Math.min(...due.map((r) => r.scheduledAt + r.durationMinutes * 60000))
      : null,
  };
}

export async function pageNotRecorded(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  options: {
    cutoff: number;
    closerId?: Id<"users">;
    cursor: string | null;
    limit: number;
  },
) {
  const page = await scheduledCandidates(
    ctx,
    tenantId,
    options.cutoff,
    options.closerId,
  ).paginate({
    cursor: options.cursor,
    numItems: options.limit,
    maximumRowsRead: options.limit,
    maximumBytesRead: 512 * 1024,
  });
  const scan = await readLiveDocuments(
    page.page.map((row) => row._id),
    (id) => ctx.db.get("meetings", id),
  );
  return {
    // A row can stop being due between the index page and this read: it was
    // recorded, or it is still running at the cutoff.
    rows: scan.rows.filter(
      (row) =>
        row.tenantId === tenantId &&
        meetingAttendanceDisplay(row, options.cutoff) === "not_recorded",
    ),
    isDone: page.isDone && !scan.capped,
    continueCursor: page.continueCursor,
  };
}
