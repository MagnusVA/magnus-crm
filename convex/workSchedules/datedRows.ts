import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { addBusinessDays } from "../reporting/lib/hondurasBusinessTime";
import {
  createLiveReadState,
  readLiveQueryRows,
  type LiveReadState,
} from "../lib/liveQueryBounds";
import { expectedError } from "../lib/observability/errors";
import { tenantBusinessToday } from "../lib/tenantBusinessDay";
import { rowInForce, weekdays, type WeekHours, type Weekday } from "../lib/workSchedule";

// Reads and writes of the three dated schedule tables (convex/lib/
// workSchedule.ts, "Dated schedules"). Every schedule read goes through
// `readScheduleRows`, per owner, and every write through `writeDatedWeek`.

export function validateScheduledHours(hours: number) {
  if (!Number.isFinite(hours) || hours < 0 || hours > 24) {
    throw expectedError("work_schedule.rejected", "Scheduled hours must be between 0 and 24");
  }
}

export function validateWeeklyScheduledHours(schedule: WeekHours) {
  for (const weekday of weekdays) {
    validateScheduledHours(schedule[weekday]);
  }
}

/** Whose schedule: one lead gen worker, one Slack qualifier, or one DM closer. */
export type ScheduleOwner =
  | { table: "leadGenWorkerSchedules"; workerId: Id<"leadGenWorkers"> }
  | { table: "slackQualifierSchedules"; slackUserId: string }
  | { table: "dmCloserSchedules"; dmCloserId: Id<"dmClosers"> };

export type ScheduleTable = ScheduleOwner["table"];
export type ScheduleRow<Table extends ScheduleTable = ScheduleTable> = Doc<Table>;
type RowFor<Owner extends ScheduleOwner> = Doc<Owner["table"]>;

/**
 * A person's rows grow by one per weekday each time that weekday changes.
 * 700 rows is 100 changes of every weekday; past it a read reports `capped`.
 */
export const SCHEDULE_ROWS_PER_OWNER = 700;

function ownerQuery(ctx: QueryCtx, tenantId: Id<"tenants">, owner: ScheduleOwner, weekday?: Weekday) {
  switch (owner.table) {
    case "leadGenWorkerSchedules":
      return ctx.db
        .query("leadGenWorkerSchedules")
        .withIndex("by_tenantId_and_workerId_and_weekday_and_effectiveFrom", (q) => {
          const range = q.eq("tenantId", tenantId).eq("workerId", owner.workerId);
          return weekday ? range.eq("weekday", weekday) : range;
        });
    case "slackQualifierSchedules":
      return ctx.db
        .query("slackQualifierSchedules")
        .withIndex("by_tenantId_and_slackUserId_and_weekday_and_effectiveFrom", (q) => {
          const range = q.eq("tenantId", tenantId).eq("slackUserId", owner.slackUserId);
          return weekday ? range.eq("weekday", weekday) : range;
        });
    case "dmCloserSchedules":
      return ctx.db
        .query("dmCloserSchedules")
        .withIndex("by_tenantId_and_dmCloserId_and_weekday_and_effectiveFrom", (q) => {
          const range = q.eq("tenantId", tenantId).eq("dmCloserId", owner.dmCloserId);
          return weekday ? range.eq("weekday", weekday) : range;
        });
  }
}

/**
 * The owner's row in force for `weekday` on `dayKey`, newest first through
 * the index: the first row that had started by then. Reads the rows dated
 * after `dayKey` on the way, so it suits recent days.
 */
export async function scheduleRowInForceOn<Owner extends ScheduleOwner>(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  owner: Owner,
  weekday: Weekday,
  dayKey: string,
): Promise<RowFor<Owner> | null> {
  const query = ownerQuery(ctx, tenantId, owner, weekday).order("desc") as AsyncIterable<RowFor<Owner>>;
  for await (const row of query) {
    if (row.effectiveFrom === undefined || row.effectiveFrom <= dayKey) return row;
  }
  return null;
}

/** Whether the owner has any schedule row, on any date. */
export async function hasScheduleRows(ctx: QueryCtx, tenantId: Id<"tenants">, owner: ScheduleOwner) {
  return (await ownerQuery(ctx, tenantId, owner).first()) !== null;
}

/**
 * Every schedule row of one owner, all weekdays and dates. `capped` means the
 * rows are partial (the owner has more than `SCHEDULE_ROWS_PER_OWNER` rows, or
 * the shared live-read budget ran out), so the caller flags its answer.
 */
export async function readScheduleRows<Owner extends ScheduleOwner>(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  owner: Owner,
  state: LiveReadState = createLiveReadState(),
): Promise<{ rows: RowFor<Owner>[]; capped: boolean }> {
  const query = ownerQuery(ctx, tenantId, owner) as AsyncIterable<RowFor<Owner>>;
  const scan = await readLiveQueryRows(query, SCHEDULE_ROWS_PER_OWNER, state);
  return scan;
}

type RowPatch = { scheduledHours: number; updatedByUserId: Id<"users">; updatedAt: number };

async function deleteRow(ctx: MutationCtx, table: ScheduleTable, id: ScheduleRow["_id"]) {
  switch (table) {
    case "leadGenWorkerSchedules":
      return await ctx.db.delete(table, id as Id<"leadGenWorkerSchedules">);
    case "slackQualifierSchedules":
      return await ctx.db.delete(table, id as Id<"slackQualifierSchedules">);
    case "dmCloserSchedules":
      return await ctx.db.delete(table, id as Id<"dmCloserSchedules">);
  }
}

async function patchRow(ctx: MutationCtx, table: ScheduleTable, id: ScheduleRow["_id"], patch: RowPatch) {
  switch (table) {
    case "leadGenWorkerSchedules":
      return await ctx.db.patch(table, id as Id<"leadGenWorkerSchedules">, patch);
    case "slackQualifierSchedules":
      return await ctx.db.patch(table, id as Id<"slackQualifierSchedules">, patch);
    case "dmCloserSchedules":
      return await ctx.db.patch(table, id as Id<"dmCloserSchedules">, patch);
  }
}

/**
 * Saves `scheduledHours` for `days` from today on, or with null drops today's
 * change for them. Per weekday, against `before` (the row in force yesterday)
 * and today's row:
 * - a week whose hours match `before` deletes today's row, so Undo back to the
 *   earlier week leaves no trace;
 * - other hours patch today's row, or insert one dated today. With no `before`
 *   it inserts even 0 h, so a first save sets every day;
 * - null deletes today's row.
 * Days before today never change. `changedRows` counts inserts, patches and
 * deletes.
 */
export async function writeDatedWeek(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    userId: Id<"users">;
    owner: ScheduleOwner;
    /** Lead gen rows carry the worker's user. */
    workerUserId?: Id<"users">;
    scheduledHours: Partial<WeekHours> | null;
    days?: readonly Weekday[];
  },
): Promise<{ changedRows: number; effectiveFrom: string }> {
  const today = await tenantBusinessToday(ctx, args.tenantId);
  const yesterday = addBusinessDays(today, -1);
  const now = Date.now();
  let changedRows = 0;
  let rowCount: number | undefined;

  for (const weekday of args.days ?? weekdays) {
    // Newest first: today's row, then the one in force before it. Rows are
    // never dated after today, so a few cover both.
    const rows = (await ownerQuery(ctx, args.tenantId, args.owner, weekday)
      .order("desc")
      .take(8)) as ScheduleRow[];
    const todayRow = rows.find((row) => row.effectiveFrom === today) ?? null;
    const before = rowInForce(rows, weekday, yesterday);

    if (args.scheduledHours === null) {
      if (todayRow) {
        await deleteRow(ctx, args.owner.table, todayRow._id);
        changedRows += 1;
      }
      continue;
    }

    const scheduledHours = args.scheduledHours[weekday];
    if (scheduledHours === undefined) continue;

    if (before && before.scheduledHours === scheduledHours) {
      if (todayRow) {
        await deleteRow(ctx, args.owner.table, todayRow._id);
        changedRows += 1;
      }
      continue;
    }

    if (todayRow) {
      if (todayRow.scheduledHours !== scheduledHours) {
        await patchRow(ctx, args.owner.table, todayRow._id, { scheduledHours, updatedByUserId: args.userId, updatedAt: now });
        changedRows += 1;
      }
      continue;
    }

    // Reads load an owner's whole history up to SCHEDULE_ROWS_PER_OWNER rows;
    // refuse a new row that would pass it, so past days never lose their rows.
    // Patches and deletes (an Undo) never add rows, so they always go through.
    rowCount ??= (await ownerQuery(ctx, args.tenantId, args.owner).take(SCHEDULE_ROWS_PER_OWNER)).length;
    if (rowCount >= SCHEDULE_ROWS_PER_OWNER) {
      throw expectedError("work_schedule.rejected", "This schedule has changed too many times to save another change. Contact support.");
    }
    const fields = { weekday, scheduledHours, effectiveFrom: today, updatedByUserId: args.userId, updatedAt: now };
    switch (args.owner.table) {
      case "leadGenWorkerSchedules":
        if (!args.workerUserId) throw new Error("Lead gen schedule rows need the worker's user");
        await ctx.db.insert("leadGenWorkerSchedules", {
          tenantId: args.tenantId,
          workerId: args.owner.workerId,
          userId: args.workerUserId,
          ...fields,
        });
        break;
      case "slackQualifierSchedules":
        await ctx.db.insert("slackQualifierSchedules", {
          tenantId: args.tenantId,
          slackUserId: args.owner.slackUserId,
          ...fields,
        });
        break;
      case "dmCloserSchedules":
        await ctx.db.insert("dmCloserSchedules", {
          tenantId: args.tenantId,
          dmCloserId: args.owner.dmCloserId,
          ...fields,
        });
        break;
    }
    rowCount += 1;
    changedRows += 1;
  }

  return { changedRows, effectiveFrom: today };
}
