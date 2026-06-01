import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { weekdays, type Weekday } from "./lib/workSchedule";
import { requireTenantUser } from "./requireTenantUser";

const weeklyScheduledHoursValidator = v.object({
  monday: v.number(),
  tuesday: v.number(),
  wednesday: v.number(),
  thursday: v.number(),
  friday: v.number(),
  saturday: v.number(),
  sunday: v.number(),
});

type WeeklyScheduledHours = Record<Weekday, number>;

function validateScheduledHours(hours: number) {
  if (!Number.isFinite(hours) || hours < 0 || hours > 24) {
    throw new Error("Scheduled hours must be between 0 and 24");
  }
}

function validateWeeklyScheduledHours(schedule: WeeklyScheduledHours) {
  for (const weekday of weekdays) {
    validateScheduledHours(schedule[weekday]);
  }
}

export const listSlackQualifierSchedules = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const [slackUsers, schedules] = await Promise.all([
      ctx.db
        .query("slackUsers")
        .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
        .take(300),
      ctx.db
        .query("slackQualifierSchedules")
        .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
        .take(2_100),
    ]);

    return { slackUsers, schedules };
  },
});

export const setSlackQualifierWeeklySchedule = mutation({
  args: {
    slackUserId: v.string(),
    scheduledHours: weeklyScheduledHoursValidator,
  },
  handler: async (ctx, args) => {
    const { tenantId, userId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    validateWeeklyScheduledHours(args.scheduledHours);

    const slackUser = await ctx.db
      .query("slackUsers")
      .withIndex("by_tenantId_and_slackUserId", (q) =>
        q.eq("tenantId", tenantId).eq("slackUserId", args.slackUserId),
      )
      .unique();
    if (!slackUser) throw new Error("Slack qualifier not found.");

    const now = Date.now();
    let changedRows = 0;

    for (const weekday of weekdays) {
      const scheduledHours = args.scheduledHours[weekday];
      const existing = await ctx.db
        .query("slackQualifierSchedules")
        .withIndex("by_tenantId_and_slackUserId_and_weekday", (q) =>
          q
            .eq("tenantId", tenantId)
            .eq("slackUserId", args.slackUserId)
            .eq("weekday", weekday),
        )
        .unique();

      if (existing && existing.scheduledHours === scheduledHours) continue;

      const patch = {
        scheduledHours,
        updatedByUserId: userId,
        updatedAt: now,
      };

      if (existing) {
        await ctx.db.patch(existing._id, patch);
      } else {
        await ctx.db.insert("slackQualifierSchedules", {
          tenantId,
          slackUserId: args.slackUserId,
          weekday,
          ...patch,
        });
      }

      changedRows += 1;
    }

    return { changedRows };
  },
});

export const listDmCloserSchedules = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const [dmClosers, attributionTeams, schedules] = await Promise.all([
      ctx.db
        .query("dmClosers")
        .withIndex("by_tenantId_and_teamId", (q) => q.eq("tenantId", tenantId))
        .take(300),
      ctx.db
        .query("attributionTeams")
        .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
        .take(300),
      ctx.db
        .query("dmCloserSchedules")
        .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
        .take(2_100),
    ]);

    return { dmClosers, attributionTeams, schedules };
  },
});

export const setDmCloserWeeklySchedule = mutation({
  args: {
    dmCloserId: v.id("dmClosers"),
    scheduledHours: weeklyScheduledHoursValidator,
  },
  handler: async (ctx, args) => {
    const { tenantId, userId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    validateWeeklyScheduledHours(args.scheduledHours);

    const dmCloser = await ctx.db.get(args.dmCloserId);
    if (!dmCloser || dmCloser.tenantId !== tenantId) {
      throw new Error("DM closer not found.");
    }

    const now = Date.now();
    let changedRows = 0;

    for (const weekday of weekdays) {
      const scheduledHours = args.scheduledHours[weekday];
      const existing = await ctx.db
        .query("dmCloserSchedules")
        .withIndex("by_tenantId_and_dmCloserId_and_weekday", (q) =>
          q
            .eq("tenantId", tenantId)
            .eq("dmCloserId", args.dmCloserId)
            .eq("weekday", weekday),
        )
        .unique();

      if (existing && existing.scheduledHours === scheduledHours) continue;

      const patch = {
        scheduledHours,
        updatedByUserId: userId,
        updatedAt: now,
      };

      if (existing) {
        await ctx.db.patch(existing._id, patch);
      } else {
        await ctx.db.insert("dmCloserSchedules", {
          tenantId,
          dmCloserId: args.dmCloserId,
          weekday,
          ...patch,
        });
      }

      changedRows += 1;
    }

    return { changedRows };
  },
});
