import { expectedError } from "./lib/observability/errors";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { rowsInForce } from "./lib/workSchedule";
import { requireTenantUser } from "./requireTenantUser";
import { tenantBusinessToday } from "./lib/tenantBusinessDay";
import { createLiveReadState } from "./lib/liveQueryBounds";
import { readScheduleRows, validateWeeklyScheduledHours, writeDatedWeek } from "./workSchedules/datedRows";

const weeklyScheduledHoursValidator = v.object({
  monday: v.number(),
  tuesday: v.number(),
  wednesday: v.number(),
  thursday: v.number(),
  friday: v.number(),
  saturday: v.number(),
  sunday: v.number(),
});

// A save takes the whole week, or null to drop today's change and go back to
// the week in force before today (Undo of a first schedule passes null).
// Every save returns the business date the change applies from. Rows are
// dated (convex/lib/workSchedule.ts, "Dated schedules"); `writeDatedWeek`
// in convex/workSchedules/datedRows.ts holds the rule.
const weekOrNullValidator = v.union(weeklyScheduledHoursValidator, v.null());

export const listSlackQualifierSchedules = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const slackUsers = await ctx.db
      .query("slackUsers")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .take(300);

    // The week in force today, one row per weekday, as before rows were dated.
    const today = await tenantBusinessToday(ctx, tenantId);
    const state = createLiveReadState();
    const schedules = [];
    for (const slackUser of slackUsers) {
      const scan = await readScheduleRows(
        ctx,
        tenantId,
        { table: "slackQualifierSchedules", slackUserId: slackUser.slackUserId },
        state,
      );
      schedules.push(...rowsInForce(scan.rows, today));
      if (scan.capped) break;
    }

    return { slackUsers, schedules };
  },
});

export const setSlackQualifierWeeklySchedule = mutation({
  args: {
    slackUserId: v.string(),
    scheduledHours: weekOrNullValidator,
  },
  handler: async (ctx, args) => {
    const { tenantId, userId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    if (args.scheduledHours) validateWeeklyScheduledHours(args.scheduledHours);

    const slackUser = await ctx.db
      .query("slackUsers")
      .withIndex("by_tenantId_and_slackUserId", (q) =>
        q.eq("tenantId", tenantId).eq("slackUserId", args.slackUserId),
      )
      .unique();
    if (!slackUser) throw expectedError("work_schedule.rejected", "Slack qualifier not found.");

    return await writeDatedWeek(ctx, {
      tenantId,
      userId,
      owner: { table: "slackQualifierSchedules", slackUserId: args.slackUserId },
      scheduledHours: args.scheduledHours,
    });
  },
});

export const listDmCloserSchedules = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const [dmClosers, attributionTeams] = await Promise.all([
      ctx.db
        .query("dmClosers")
        .withIndex("by_tenantId_and_teamId", (q) => q.eq("tenantId", tenantId))
        .take(300),
      ctx.db
        .query("attributionTeams")
        .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
        .take(300),
    ]);

    // The week in force today, one row per weekday, as before rows were dated.
    const today = await tenantBusinessToday(ctx, tenantId);
    const state = createLiveReadState();
    const schedules = [];
    for (const dmCloser of dmClosers) {
      const scan = await readScheduleRows(
        ctx,
        tenantId,
        { table: "dmCloserSchedules", dmCloserId: dmCloser._id },
        state,
      );
      schedules.push(...rowsInForce(scan.rows, today));
      if (scan.capped) break;
    }

    return { dmClosers, attributionTeams, schedules };
  },
});

export const setDmCloserWeeklySchedule = mutation({
  args: {
    dmCloserId: v.id("dmClosers"),
    scheduledHours: weekOrNullValidator,
  },
  handler: async (ctx, args) => {
    const { tenantId, userId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    if (args.scheduledHours) validateWeeklyScheduledHours(args.scheduledHours);

    const dmCloser = await ctx.db.get("dmClosers", args.dmCloserId);
    if (!dmCloser || dmCloser.tenantId !== tenantId) {
      throw expectedError("work_schedule.rejected", "DM closer not found.");
    }

    return await writeDatedWeek(ctx, {
      tenantId,
      userId,
      owner: { table: "dmCloserSchedules", dmCloserId: dmCloser._id },
      scheduledHours: args.scheduledHours,
    });
  },
});

export const setLeadGenWeeklySchedule = mutation({
  args: {
    workerId: v.id("leadGenWorkers"),
    scheduledHours: weekOrNullValidator,
  },
  handler: async (ctx, args) => {
    const { tenantId, userId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    if (args.scheduledHours) validateWeeklyScheduledHours(args.scheduledHours);

    const worker = await ctx.db.get("leadGenWorkers", args.workerId);
    if (!worker || worker.tenantId !== tenantId) {
      throw expectedError("work_schedule.rejected", "Lead gen worker not found.");
    }

    return await writeDatedWeek(ctx, {
      tenantId,
      userId,
      owner: { table: "leadGenWorkerSchedules", workerId: worker._id },
      workerUserId: worker.userId,
      scheduledHours: args.scheduledHours,
    });
  },
});
