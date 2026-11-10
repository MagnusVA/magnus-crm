import type { Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import {
  readLiveDocuments,
  readLiveQueryRows,
} from "../../../lib/liveQueryBounds";
import { meetingAttendanceDisplay } from "../../../../lib/status-config";

/** Index bounds exclude future starts. End-time display is shared with the web. */
export function scheduledCandidates(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  now: number,
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
              .lt("scheduledAt", now),
        )
    : ctx.db
        .query("meetings")
        .withIndex("by_tenantId_and_status_and_scheduledAt", (q) =>
          q
            .eq("tenantId", tenantId)
            .eq("status", "scheduled")
            .lt("scheduledAt", now),
        );
}
export async function readNotRecorded(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  now: number,
  closerId?: Id<"users">,
) {
  const scan = await readLiveQueryRows(
    scheduledCandidates(ctx, tenantId, now, closerId),
    500,
  );
  return {
    rows: scan.rows.filter(
      (row) => meetingAttendanceDisplay(row, now) === "not_recorded",
    ),
    capped: scan.capped,
  };
}
export async function pageNotRecorded(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  options: {
    now: number;
    closerId?: Id<"users">;
    cursor?: string;
    limit: number;
  },
) {
  const page = await scheduledCandidates(
    ctx,
    tenantId,
    options.now,
    options.closerId,
  ).paginate({
    cursor: options.cursor ?? null,
    numItems: options.limit,
    maximumRowsRead: options.limit,
    maximumBytesRead: 512 * 1024,
  });
  const scan = await readLiveDocuments(
    page.page.map((row) => row._id),
    (id) => ctx.db.get("meetings", id),
  );
  return {
    rows: scan.rows.filter(
      (row) =>
        row.tenantId === tenantId &&
        meetingAttendanceDisplay(row, options.now) === "not_recorded",
    ),
    isPartial: !page.isDone || scan.capped,
    cursor: page.isDone ? null : page.continueCursor,
  };
}
