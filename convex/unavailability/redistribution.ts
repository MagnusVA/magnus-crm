import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { mutation } from "../_generated/server";
import { updateOpportunityMeetingRefs } from "../lib/opportunityMeetingRefs";
import { syncOpportunityMeetingsAssignedCloser } from "../lib/syncOpportunityMeetingsAssignedCloser";
import {
  getEffectiveRange,
  isMeetingInRange,
  validateCloser,
} from "../lib/unavailabilityValidation";
import { validateTransition } from "../lib/statusTransitions";
import { requireTenantUser } from "../requireTenantUser";
import {
  buildCloserSchedulesForDate,
  type CloserSchedule,
  getReasonLabel,
} from "./shared";

const BUFFER_MINUTES = 15;
const BUFFER_MS = BUFFER_MINUTES * 60 * 1000;

function isSlotFree(
  schedule: CloserSchedule,
  meetingStart: number,
  meetingDuration: number,
): boolean {
  if (!schedule.isAvailable) {
    return false;
  }

  const meetingEnd = meetingStart + meetingDuration * 60 * 1000;

  for (const blockedRange of schedule.blockedRanges) {
    if (
      meetingStart < blockedRange.rangeEnd &&
      meetingEnd > blockedRange.rangeStart
    ) {
      return false;
    }
  }

  for (const existingMeeting of schedule.meetings) {
    const existingEnd =
      existingMeeting.scheduledAt + existingMeeting.durationMinutes * 60 * 1000;
    const conflictStart = existingMeeting.scheduledAt - BUFFER_MS;
    const conflictEnd = existingEnd + BUFFER_MS;

    if (meetingStart < conflictEnd && meetingEnd > conflictStart) {
      return false;
    }
  }

  return true;
}

function computeScore(
  schedule: CloserSchedule,
  meetingStart: number,
  meetingDuration: number,
): number {
  const baseScore = Math.max(0, 100 - schedule.meetingsToday * 10);
  const meetingEnd = meetingStart + meetingDuration * 60 * 1000;
  let minGap = Number.POSITIVE_INFINITY;

  for (const existingMeeting of schedule.meetings) {
    const existingEnd =
      existingMeeting.scheduledAt + existingMeeting.durationMinutes * 60 * 1000;
    const gapBefore = existingMeeting.scheduledAt - meetingEnd;
    const gapAfter = meetingStart - existingEnd;
    const gap =
      gapBefore >= 0
        ? gapBefore
        : gapAfter >= 0
          ? gapAfter
          : Number.POSITIVE_INFINITY;

    if (gap < minGap) {
      minGap = gap;
    }
  }

  const gapBonus =
    minGap === Number.POSITIVE_INFINITY
      ? 20
      : Math.min(20, Math.floor(minGap / BUFFER_MS) * 5);

  return baseScore + gapBonus;
}

export const autoDistributeMeetings = mutation({
  args: {
    unavailabilityId: v.id("closerUnavailability"),
    meetingIds: v.array(v.id("meetings")),
    candidateCloserIds: v.array(v.id("users")),
  },
  handler: async (ctx, args) => {
    console.log("[Redistribution] autoDistributeMeetings called", {
      unavailabilityId: args.unavailabilityId,
      meetingCount: args.meetingIds.length,
      candidateCount: args.candidateCloserIds.length,
    });

    const { userId, tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const unavailability = await ctx.db.get(args.unavailabilityId);
    if (!unavailability || unavailability.tenantId !== tenantId) {
      throw new Error("Unavailability record not found");
    }

    const candidateCloserIds = [
      ...new Set(
        args.candidateCloserIds.filter(
          (closerId) => closerId !== unavailability.closerId,
        ),
      ),
    ];

    const schedules = await buildCloserSchedulesForDate(ctx, {
      tenantId,
      date: unavailability.date,
      closerIds: candidateCloserIds,
    });

    const meetingsToAssign: Array<{
      meetingId: (typeof args.meetingIds)[number];
      opportunityId: Id<"opportunities">;
      scheduledAt: number;
      durationMinutes: number;
      fromCloserId: Id<"users">;
    }> = [];
    const unassigned: Array<{
      meetingId: Id<"meetings">;
      reason: string;
    }> = [];

    for (const meetingId of [...new Set(args.meetingIds)]) {
      const meeting = await ctx.db.get(meetingId);
      if (!meeting || meeting.tenantId !== tenantId) {
        unassigned.push({
          meetingId,
          reason: "Meeting not found",
        });
        continue;
      }

      if (meeting.status !== "scheduled") {
        unassigned.push({
          meetingId,
          reason: `Meeting is already ${meeting.status}`,
        });
        continue;
      }

      const opportunity = await ctx.db.get(meeting.opportunityId);
      if (!opportunity || opportunity.tenantId !== tenantId) {
        unassigned.push({
          meetingId,
          reason: "Opportunity not found",
        });
        continue;
      }

      if (!opportunity.assignedCloserId) {
        unassigned.push({
          meetingId,
          reason: "Meeting has no assigned closer",
        });
        continue;
      }

      if (opportunity.assignedCloserId !== unavailability.closerId) {
        unassigned.push({
          meetingId,
          reason: "Meeting is no longer assigned to the unavailable closer",
        });
        continue;
      }

      meetingsToAssign.push({
        meetingId,
        opportunityId: meeting.opportunityId,
        scheduledAt: meeting.scheduledAt,
        durationMinutes: meeting.durationMinutes,
        fromCloserId: opportunity.assignedCloserId,
      });
    }

    meetingsToAssign.sort((a, b) => a.scheduledAt - b.scheduledAt);

    const assigned: Array<{
      meetingId: Id<"meetings">;
      toCloserId: Id<"users">;
      toCloserName: string;
    }> = [];
    const now = Date.now();
    const reasonLabel = getReasonLabel(unavailability.reason);

    for (const meeting of meetingsToAssign) {
      let bestCandidate: CloserSchedule | null = null;
      let bestScore = Number.NEGATIVE_INFINITY;

      for (const schedule of schedules.values()) {
        if (
          !isSlotFree(schedule, meeting.scheduledAt, meeting.durationMinutes)
        ) {
          continue;
        }

        const score = computeScore(
          schedule,
          meeting.scheduledAt,
          meeting.durationMinutes,
        );

        if (score > bestScore) {
          bestCandidate = schedule;
          bestScore = score;
        }
      }

      if (!bestCandidate) {
        unassigned.push({
          meetingId: meeting.meetingId,
          reason: "No available closer with a free time slot",
        });
        continue;
      }

      await ctx.db.patch(meeting.opportunityId, {
        assignedCloserId: bestCandidate.closerId,
        updatedAt: now,
      });
      await syncOpportunityMeetingsAssignedCloser(
        ctx,
        meeting.opportunityId,
        bestCandidate.closerId,
      );
      await ctx.db.patch(meeting.meetingId, {
        reassignedFromCloserId: meeting.fromCloserId,
      });
      await ctx.db.insert("meetingReassignments", {
        tenantId,
        meetingId: meeting.meetingId,
        opportunityId: meeting.opportunityId,
        fromCloserId: meeting.fromCloserId,
        toCloserId: bestCandidate.closerId,
        reason: `${reasonLabel} - auto-distributed`,
        unavailabilityId: args.unavailabilityId,
        reassignedByUserId: userId,
        reassignedAt: now,
      });

      bestCandidate.meetings.push({
        meetingId: meeting.meetingId,
        opportunityId: meeting.opportunityId,
        scheduledAt: meeting.scheduledAt,
        durationMinutes: meeting.durationMinutes,
        leadName: undefined,
      });
      bestCandidate.meetingsToday += 1;

      assigned.push({
        meetingId: meeting.meetingId,
        toCloserId: bestCandidate.closerId,
        toCloserName: bestCandidate.closerName,
      });
    }

    console.log("[Redistribution] autoDistributeMeetings completed", {
      assignedCount: assigned.length,
      unassignedCount: unassigned.length,
    });

    return { assigned, unassigned };
  },
});

export const manuallyResolveMeeting = mutation({
  args: {
    meetingId: v.id("meetings"),
    unavailabilityId: v.id("closerUnavailability"),
    action: v.union(v.literal("assign"), v.literal("cancel")),
    targetCloserId: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    console.log("[Redistribution] manuallyResolveMeeting called", {
      meetingId: args.meetingId,
      action: args.action,
      targetCloserId: args.targetCloserId,
    });

    const { userId, tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const meeting = await ctx.db.get(args.meetingId);
    if (!meeting || meeting.tenantId !== tenantId) {
      throw new Error("Meeting not found");
    }

    const opportunity = await ctx.db.get(meeting.opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found");
    }

    const unavailability = await ctx.db.get(args.unavailabilityId);
    if (!unavailability || unavailability.tenantId !== tenantId) {
      throw new Error("Unavailability record not found");
    }

    const now = Date.now();
    const reasonLabel = getReasonLabel(unavailability.reason);

    if (args.action === "assign") {
      if (meeting.status !== "scheduled") {
        throw new Error(
          `Only scheduled meetings can be reassigned (current: ${meeting.status})`,
        );
      }

      if (opportunity.assignedCloserId !== unavailability.closerId) {
        throw new Error("Meeting is no longer assigned to the unavailable closer");
      }

      if (!args.targetCloserId) {
        throw new Error("targetCloserId is required for assign action");
      }

      if (args.targetCloserId === unavailability.closerId) {
        throw new Error("Cannot assign to the unavailable closer");
      }

      const targetCloser = await validateCloser(
        ctx,
        args.targetCloserId,
        tenantId,
      );

      const targetDayUnavailability = await ctx.db
        .query("closerUnavailability")
        .withIndex("by_closerId_and_date", (q) =>
          q.eq("closerId", targetCloser._id).eq("date", unavailability.date),
        )
        .first();

      if (targetDayUnavailability) {
        const { rangeStart, rangeEnd } =
          getEffectiveRange(targetDayUnavailability);
        if (
          targetDayUnavailability.isFullDay ||
          isMeetingInRange(meeting.scheduledAt, rangeStart, rangeEnd)
        ) {
          throw new Error("Target closer is unavailable during this meeting");
        }
      }

      await ctx.db.patch(opportunity._id, {
        assignedCloserId: targetCloser._id,
        updatedAt: now,
      });
      await syncOpportunityMeetingsAssignedCloser(
        ctx,
        opportunity._id,
        targetCloser._id,
      );
      await ctx.db.patch(args.meetingId, {
        reassignedFromCloserId: unavailability.closerId,
      });
      await ctx.db.insert("meetingReassignments", {
        tenantId,
        meetingId: args.meetingId,
        opportunityId: opportunity._id,
        fromCloserId: unavailability.closerId,
        toCloserId: targetCloser._id,
        reason: `${reasonLabel} - manually assigned`,
        unavailabilityId: args.unavailabilityId,
        reassignedByUserId: userId,
        reassignedAt: now,
      });

      return {
        action: "assigned" as const,
        targetCloserName: targetCloser.fullName ?? targetCloser.email,
      };
    }

    if (meeting.status !== "scheduled" && meeting.status !== "canceled") {
      throw new Error(
        `Only scheduled meetings can be canceled from redistribution (current: ${meeting.status})`,
      );
    }

    if (
      meeting.status !== "canceled" &&
      opportunity.assignedCloserId !== unavailability.closerId
    ) {
      throw new Error("Meeting is no longer assigned to the unavailable closer");
    }

    if (meeting.status !== "canceled") {
      await ctx.db.patch(args.meetingId, { status: "canceled" });
      await updateOpportunityMeetingRefs(ctx, opportunity._id);
    }

    await ctx.db.patch(opportunity._id, {
      status:
        opportunity.status === "canceled" ||
        validateTransition(opportunity.status, "canceled")
          ? "canceled"
          : opportunity.status,
      cancellationReason: `Canceled due to closer unavailability (${reasonLabel})`,
      canceledBy: "admin_unavailability_resolution",
      updatedAt: now,
    });

    return { action: "canceled" as const };
  },
});
