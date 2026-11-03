import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  addBusinessDays,
  businessDateForInstant,
  businessDayRange,
  businessDayStart,
} from "../../lib/businessDay";
import { queueSecondOpinion } from "./trigger";

/** Freeze the cron's time across pages, including non-whole-hour time zones. */
export const run = internalMutation({
  args: { now: v.optional(v.number()), cursor: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const page = await ctx.db
      .query("tenants")
      .paginate({ cursor: args.cursor ?? null, numItems: 25 });
    for (const tenant of page.page) {
      if (!tenant.secondOpinion || tenant.secondOpinion.mode === "off")
        continue;
      const currentDate = businessDateForInstant(now, tenant.businessDay);
      const closedAt = businessDayStart(currentDate, tenant.businessDay);
      if (closedAt > now - 3600_000 && closedAt <= now) {
        const range = businessDayRange(
          addBusinessDays(currentDate, -1),
          tenant.businessDay,
        );
        await ctx.scheduler.runAfter(
          0,
          internal.secondOpinion.sweep.tenantDay,
          { tenantId: tenant._id, start: range.start, end: range.end },
        );
      }
    }
    if (!page.isDone)
      await ctx.scheduler.runAfter(0, internal.secondOpinion.sweep.run, {
        now,
        cursor: page.continueCursor,
      });
    return null;
  },
});
export const tenantDay = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    start: v.number(),
    end: v.number(),
    cursor: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_scheduledAt", (q) =>
        q
          .eq("tenantId", args.tenantId)
          .gte("scheduledAt", args.start)
          .lt("scheduledAt", args.end),
      )
      .paginate({ cursor: args.cursor ?? null, numItems: 25 });
    for (const meeting of page.page)
      if (meeting.status === "scheduled")
        await queueSecondOpinion(ctx, {
          meetingId: meeting._id,
          trigger: "day_closed",
        });
    if (!page.isDone)
      await ctx.scheduler.runAfter(0, internal.secondOpinion.sweep.tenantDay, {
        ...args,
        cursor: page.continueCursor,
      });
    return null;
  },
});
