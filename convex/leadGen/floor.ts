import {
  businessDateForInstant,
  businessDayRange,
} from "../../lib/businessDay";
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { assertLeadGenBusinessDayReady } from "../lib/businessDayRebuildState";
import { createLiveReadState, readLiveQueryRows } from "../lib/liveQueryBounds";
import { rejectRequest } from "../lib/observability/errors";
import { getTenantBusinessDay } from "../lib/tenantBusinessDay";
import { hoursOn } from "../lib/workSchedule";
import { countWorkerResparkResults } from "./resparkReports";
import { listWorkersCore, listWorkerSchedulesCore } from "./workers";

/** Cursors carry scope, never authority. Every reader still authorizes its caller. */
export function encodeLeadGenCursor(scope: string, position: string): string {
  return JSON.stringify({ version: 1, scope, position });
}

export function decodeLeadGenCursor(
  cursor: string | undefined,
  scope: string,
): string | null {
  if (cursor === undefined) return null;
  try {
    const value = JSON.parse(cursor);
    if (
      value.version === 1 &&
      value.scope === scope &&
      typeof value.position === "string"
    ) {
      return value.position;
    }
  } catch {
    /* An invalid cursor is a caller error, not a fresh page. */
  }
  throw rejectRequest(
    "lead_gen.invalid_cursor",
    "That cursor doesn't match these filters. Start again without a cursor.",
  );
}

export function trimLeadGenText(value: string, maxBytes = 500): string {
  // Bound JSON bytes as well as characters, including escaped control text.
  let text = value.slice(0, 500);
  const encoder = new TextEncoder();
  while (encoder.encode(JSON.stringify(text)).length - 2 > maxBytes)
    text = text.slice(0, -1);
  return text;
}

/** Roster first: even a scheduled specialist with no activity has a row. */
export async function readLeadGenFloor(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    teamId?: Id<"attributionTeams">;
    cursor?: string;
    now: number;
  },
) {
  await assertLeadGenBusinessDayReady(ctx, args.tenantId);
  if (args.teamId) {
    const team = await ctx.db.get("attributionTeams", args.teamId);
    if (!team || team.tenantId !== args.tenantId) {
      throw rejectRequest(
        "lead_gen.team_not_found",
        "That team isn't in this workspace.",
      );
    }
  }
  const businessDay = await getTenantBusinessDay(ctx, args.tenantId);
  const dayKey = businessDateForInstant(args.now, businessDay);
  const { start, end } = businessDayRange(dayKey, businessDay);
  const scope = JSON.stringify([
    "floor",
    args.tenantId,
    dayKey,
    args.teamId ?? null,
  ]);
  const page = await listWorkersCore(ctx, {
    ...args,
    includeInactive: true,
    paginationOpts: {
      numItems: 25,
      cursor: decodeLeadGenCursor(args.cursor, scope),
    },
  });
  const state = createLiveReadState();
  const schedules = await listWorkerSchedulesCore(ctx, {
    tenantId: args.tenantId,
    workerIds: page.page.map((worker) => worker._id),
    today: dayKey,
    state,
  });
  const resparkCounts = await countWorkerResparkResults(
    ctx,
    args.tenantId,
    page.page.map((worker) => worker._id),
    start,
    end,
  );
  const specialists = [];
  for (const worker of page.page) {
    const stats = await readLiveQueryRows(
      ctx.db
        .query("leadGenDailyStats")
        .withIndex("by_tenantId_and_workerId_and_dayKey", (q) =>
          q
            .eq("tenantId", args.tenantId)
            .eq("workerId", worker._id)
            .eq("dayKey", dayKey),
        ),
      100,
      state,
    );
    const lastCapture = await ctx.db
      .query("leadGenSubmissions")
      .withIndex("by_tenantId_and_workerId_and_submittedAt", (q) =>
        q
          .eq("tenantId", args.tenantId)
          .eq("workerId", worker._id)
          .gte("submittedAt", start)
          .lt("submittedAt", end),
      )
      .order("desc")
      .first();
    const batch = await ctx.db
      .query("resparkBatches")
      .withIndex("by_tenantId_and_userId_and_createdAt", (q) =>
        q.eq("tenantId", args.tenantId).eq("userId", worker.userId),
      )
      .order("desc")
      .first();
    const openBatch =
      batch &&
      batch.workerId === worker._id &&
      batch.heldUntil > args.now &&
      batch.completedAt === undefined &&
      worker.teamId !== undefined &&
      batch.teamId === worker.teamId
        ? batch
        : null;
    const items = openBatch
      ? await readLiveQueryRows(
          ctx.db
            .query("resparkBatchItems")
            .withIndex("by_batchId_and_position", (q) =>
              q.eq("batchId", openBatch._id),
            ),
          100,
          state,
        )
      : null;
    const team = worker.teamId
      ? await ctx.db.get("attributionTeams", worker.teamId)
      : null;
    const scheduledHours = hoursOn(
      schedules.rows.filter((row) => row.workerId === worker._id),
      dayKey,
    );
    const captures = stats.rows.reduce(
      (total, row) => total + row.submissions,
      0,
    );
    const respark = resparkCounts.get(worker._id)!;
    const isPartial =
      schedules.capped || stats.capped || Boolean(items?.capped);
    const flags: Array<
      "scheduled_no_entries" | "no_team" | "inactive_with_schedule"
    > = [];
    if (!isPartial && scheduledHours > 0 && captures + respark.resparks === 0)
      flags.push("scheduled_no_entries");
    if (!team || team.tenantId !== args.tenantId) flags.push("no_team");
    if (!worker.isActive && scheduledHours > 0)
      flags.push("inactive_with_schedule");
    // An inactive specialist shows only when today has something to say:
    // captures, resparks, or a schedule the flag above calls out.
    if (
      !worker.isActive &&
      !lastCapture &&
      scheduledHours === 0 &&
      respark.resparks + respark.notAFit === 0
    )
      continue;
    const name = worker.displayName ?? worker.email;
    const teamName = team?.tenantId === args.tenantId ? team.displayName : null;
    specialists.push({
      workerId: worker._id,
      name: trimLeadGenText(name),
      active: worker.isActive,
      teamId: team?.tenantId === args.tenantId ? team._id : null,
      team: teamName === null ? null : trimLeadGenText(teamName),
      scheduledHours,
      captures,
      unique: stats.rows.reduce(
        (total, row) => total + row.uniqueProspectsSubmitted,
        0,
      ),
      dupes: stats.rows.reduce(
        (total, row) => total + row.duplicateProspectSubmissions,
        0,
      ),
      resparks: respark.resparks,
      notAFit: respark.notAFit,
      lastCaptureAt: lastCapture?.submittedAt ?? null,
      openBatch: openBatch
        ? {
            batchId: openBatch._id,
            size: openBatch.size,
            worked: items!.rows.filter(
              (item) =>
                item.tenantId === args.tenantId && item.result !== undefined,
            ).length,
            heldUntil: openBatch.heldUntil,
          }
        : null,
      flags,
      isPartial,
      textTruncated:
        trimLeadGenText(name) !== name ||
        (teamName !== null && trimLeadGenText(teamName) !== teamName),
    });
  }
  return {
    dayKey,
    specialists,
    isPartial: !page.isDone || state.capped || specialists.some((row) => row.isPartial),
    cursor: page.isDone
      ? null
      : encodeLeadGenCursor(scope, page.continueCursor),
  };
}
