import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { getEffectiveRange } from "../lib/unavailabilityValidation";
import {
  buildCloserSchedulesForDate,
  getUserDisplayName,
  listAffectedMeetingsForCloserInRange,
} from "./shared";

export const getUnavailabilityWithMeetings = query({
  args: { unavailabilityId: v.id("closerUnavailability") },
  handler: async (ctx, { unavailabilityId }) => {
    console.log("[Unavailability] getUnavailabilityWithMeetings called", {
      unavailabilityId,
    });

    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const unavailability = await ctx.db.get(unavailabilityId);
    if (!unavailability || unavailability.tenantId !== tenantId) {
      throw new Error("Unavailability record not found");
    }

    const closer = await ctx.db.get(unavailability.closerId);
    const createdBy = await ctx.db.get(unavailability.createdByUserId);
    const { rangeStart, rangeEnd } = getEffectiveRange(unavailability);

    const affectedMeetings = await listAffectedMeetingsForCloserInRange(ctx, {
      tenantId,
      closerId: unavailability.closerId,
      rangeStart,
      rangeEnd,
    });

    const affectedMeetingsById = new Map<
      Id<"meetings">,
      (typeof affectedMeetings)[number] & { alreadyReassigned: boolean }
    >();

    for (const meeting of affectedMeetings) {
      affectedMeetingsById.set(meeting.meetingId, {
        ...meeting,
        alreadyReassigned: false,
      });
    }

    for await (const reassignment of ctx.db
      .query("meetingReassignments")
      .withIndex("by_unavailabilityId", (q) =>
        q.eq("unavailabilityId", unavailabilityId),
      )) {
      const meeting = await ctx.db.get(reassignment.meetingId);
      if (!meeting || meeting.tenantId !== tenantId) {
        continue;
      }

      affectedMeetingsById.set(meeting._id, {
        meetingId: meeting._id,
        opportunityId: meeting.opportunityId,
        scheduledAt: meeting.scheduledAt,
        durationMinutes: meeting.durationMinutes,
        leadName: meeting.leadName,
        meetingJoinUrl: meeting.meetingJoinUrl,
        status: meeting.status,
        alreadyReassigned: true,
      });
    }

    const result = [...affectedMeetingsById.values()].sort(
      (a, b) => a.scheduledAt - b.scheduledAt,
    );

    console.log("[Unavailability] getUnavailabilityWithMeetings completed", {
      unavailabilityId,
      affectedCount: result.length,
    });

    return {
      unavailability: {
        ...unavailability,
        closerName: getUserDisplayName(closer),
        createdByName: getUserDisplayName(createdBy),
      },
      affectedMeetings: result,
      rangeStart,
      rangeEnd,
    };
  },
});

export const getAvailableClosersForDate = query({
  args: {
    date: v.number(),
    excludeCloserId: v.id("users"),
  },
  handler: async (ctx, { date, excludeCloserId }) => {
    console.log("[Unavailability] getAvailableClosersForDate called", {
      date,
      excludeCloserId,
    });

    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const closerIds: Id<"users">[] = [];
    for await (const user of ctx.db
      .query("users")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))) {
      if (user.role === "closer" && user._id !== excludeCloserId) {
        closerIds.push(user._id);
      }
    }

    const schedules = await buildCloserSchedulesForDate(ctx, {
      tenantId,
      date,
      closerIds,
    });

    const result = [...schedules.values()]
      .map((schedule) => ({
        closerId: schedule.closerId,
        closerName: schedule.closerName,
        isAvailable: schedule.isAvailable,
        unavailabilityReason: schedule.unavailabilityReason,
        meetingsToday: schedule.meetingsToday,
        meetings: schedule.meetings.map((meeting) => ({
          scheduledAt: meeting.scheduledAt,
          durationMinutes: meeting.durationMinutes,
        })),
        blockedRanges: schedule.blockedRanges,
      }))
      .sort((a, b) => a.closerName.localeCompare(b.closerName));

    console.log("[Unavailability] getAvailableClosersForDate completed", {
      totalClosers: result.length,
      availableCount: result.filter((closer) => closer.isAvailable).length,
    });

    return result;
  },
});

export const getRecentReassignments = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { limit }) => {
    console.log("[Unavailability] getRecentReassignments called", { limit });

    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const boundedLimit = Math.max(1, Math.min(limit ?? 20, 50));
    const reassignments = await ctx.db
      .query("meetingReassignments")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .order("desc")
      .take(boundedLimit);

    const userIds = new Set<Id<"users">>();
    const meetingIds = new Set<Id<"meetings">>();

    for (const reassignment of reassignments) {
      userIds.add(reassignment.fromCloserId);
      userIds.add(reassignment.toCloserId);
      userIds.add(reassignment.reassignedByUserId);
      meetingIds.add(reassignment.meetingId);
    }

    const usersById = new Map<
      Id<"users">,
      { fullName?: string; email: string }
    >();
    for (const userId of userIds) {
      const user = await ctx.db.get(userId);
      if (user && user.tenantId === tenantId) {
        usersById.set(userId, user);
      }
    }

    const meetingsById = new Map<
      Id<"meetings">,
      {
        scheduledAt: number;
        leadName: string | undefined;
      }
    >();
    for (const meetingId of meetingIds) {
      const meeting = await ctx.db.get(meetingId);
      if (meeting && meeting.tenantId === tenantId) {
        meetingsById.set(meetingId, {
          scheduledAt: meeting.scheduledAt,
          leadName: meeting.leadName,
        });
      }
    }

    return reassignments.map((reassignment) => {
      const meeting = meetingsById.get(reassignment.meetingId);

      return {
        ...reassignment,
        fromCloserName: getUserDisplayName(
          usersById.get(reassignment.fromCloserId),
        ),
        toCloserName: getUserDisplayName(usersById.get(reassignment.toCloserId)),
        reassignedByName: getUserDisplayName(
          usersById.get(reassignment.reassignedByUserId),
        ),
        meetingScheduledAt: meeting?.scheduledAt,
        leadName: meeting?.leadName,
      };
    });
  },
});
