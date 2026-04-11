import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import {
  getEffectiveRange,
  unavailabilityReasonValidator,
  validateCloser,
} from "../lib/unavailabilityValidation";
import { listAffectedMeetingsForCloserInRange } from "./shared";

export const createCloserUnavailability = mutation({
  args: {
    closerId: v.id("users"),
    date: v.number(),
    reason: unavailabilityReasonValidator,
    note: v.optional(v.string()),
    isFullDay: v.boolean(),
    startTime: v.optional(v.number()),
    endTime: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    console.log("[Unavailability] createCloserUnavailability called", {
      closerId: args.closerId,
      date: args.date,
      reason: args.reason,
      isFullDay: args.isFullDay,
    });

    const { userId, tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    await validateCloser(ctx, args.closerId, tenantId);

    if (!args.isFullDay) {
      if (args.startTime === undefined || args.endTime === undefined) {
        throw new Error(
          "Partial-day unavailability requires both startTime and endTime",
        );
      }

      if (args.startTime >= args.endTime) {
        throw new Error("startTime must be before endTime");
      }
    }

    const existing = await ctx.db
      .query("closerUnavailability")
      .withIndex("by_closerId_and_date", (q) =>
        q.eq("closerId", args.closerId).eq("date", args.date),
      )
      .first();

    if (existing) {
      throw new Error(
        "An unavailability record already exists for this closer on this date",
      );
    }

    const now = Date.now();
    const unavailabilityId = await ctx.db.insert("closerUnavailability", {
      tenantId,
      closerId: args.closerId,
      date: args.date,
      startTime: args.isFullDay ? undefined : args.startTime,
      endTime: args.isFullDay ? undefined : args.endTime,
      isFullDay: args.isFullDay,
      reason: args.reason,
      note: args.note,
      createdByUserId: userId,
      createdAt: now,
    });

    const { rangeStart, rangeEnd } = getEffectiveRange({
      date: args.date,
      isFullDay: args.isFullDay,
      startTime: args.startTime,
      endTime: args.endTime,
    });

    const affectedMeetings = await listAffectedMeetingsForCloserInRange(ctx, {
      tenantId,
      closerId: args.closerId,
      rangeStart,
      rangeEnd,
    });

    console.log("[Unavailability] createCloserUnavailability completed", {
      unavailabilityId,
      affectedCount: affectedMeetings.length,
    });

    return {
      unavailabilityId,
      affectedMeetings,
    };
  },
});
