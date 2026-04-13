import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
  getEffectiveRange,
  type UnavailabilityReason,
} from "../lib/unavailabilityValidation";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

type TenantContext = QueryCtx | MutationCtx;

export type AffectedMeeting = {
  meetingId: Id<"meetings">;
  opportunityId: Id<"opportunities">;
  scheduledAt: number;
  durationMinutes: number;
  leadName: string | undefined;
  meetingJoinUrl: string | undefined;
  status: Doc<"meetings">["status"];
};

export type BusyRange = {
  rangeStart: number;
  rangeEnd: number;
  reason: UnavailabilityReason;
  isFullDay: boolean;
};

export type CloserSchedule = {
  closerId: Id<"users">;
  closerName: string;
  meetings: Array<{
    meetingId: Id<"meetings">;
    opportunityId: Id<"opportunities">;
    scheduledAt: number;
    durationMinutes: number;
    leadName: string | undefined;
  }>;
  meetingsToday: number;
  blockedRanges: BusyRange[];
  isAvailable: boolean;
  unavailabilityReason: UnavailabilityReason | null;
};

export function getDayRange(date: number): {
  dayStart: number;
  dayEnd: number;
} {
  return {
    dayStart: date,
    dayEnd: date + ONE_DAY_MS,
  };
}

export function getUserDisplayName(
  user:
    | {
        fullName?: string;
        email: string;
      }
    | null
    | undefined,
): string {
  return user?.fullName ?? user?.email ?? "Unknown";
}

export function getReasonLabel(reason: UnavailabilityReason): string {
  return reason.charAt(0).toUpperCase() + reason.slice(1);
}

export async function listAffectedMeetingsForCloserInRange(
  ctx: TenantContext,
  {
    tenantId,
    closerId,
    rangeStart,
    rangeEnd,
  }: {
    tenantId: Id<"tenants">;
    closerId: Id<"users">;
    rangeStart: number;
    rangeEnd: number;
  },
): Promise<AffectedMeeting[]> {
  const affectedMeetings: AffectedMeeting[] = [];

  for await (const meeting of ctx.db
    .query("meetings")
    .withIndex("by_tenantId_and_assignedCloserId_and_scheduledAt", (q) =>
      q
        .eq("tenantId", tenantId)
        .eq("assignedCloserId", closerId)
        .gte("scheduledAt", rangeStart)
        .lt("scheduledAt", rangeEnd),
    )) {
    if (meeting.status !== "scheduled") {
      continue;
    }

    affectedMeetings.push({
      meetingId: meeting._id,
      opportunityId: meeting.opportunityId,
      scheduledAt: meeting.scheduledAt,
      durationMinutes: meeting.durationMinutes,
      leadName: meeting.leadName,
      meetingJoinUrl: meeting.meetingJoinUrl,
      status: meeting.status,
    });
  }

  affectedMeetings.sort((a, b) => a.scheduledAt - b.scheduledAt);

  return affectedMeetings;
}

export async function buildCloserSchedulesForDate(
  ctx: TenantContext,
  {
    tenantId,
    date,
    closerIds,
  }: {
    tenantId: Id<"tenants">;
    date: number;
    closerIds: readonly Id<"users">[];
  },
): Promise<Map<Id<"users">, CloserSchedule>> {
  const uniqueCloserIds = [...new Set(closerIds)];
  const schedules = new Map<Id<"users">, CloserSchedule>();
  const { dayStart, dayEnd } = getDayRange(date);

  const closers = await Promise.all(
    uniqueCloserIds.map(async (closerId) => ({
      closerId,
      closer: await ctx.db.get(closerId),
    })),
  );

  for (const { closerId, closer } of closers) {
    if (!closer || closer.tenantId !== tenantId || closer.role !== "closer") {
      continue;
    }

    schedules.set(closerId, {
      closerId,
      closerName: getUserDisplayName(closer),
      meetings: [],
      meetingsToday: 0,
      blockedRanges: [],
      isAvailable: true,
      unavailabilityReason: null,
    });
  }

  if (schedules.size === 0) {
    return schedules;
  }

  for await (const record of ctx.db
    .query("closerUnavailability")
    .withIndex("by_tenantId_and_date", (q) =>
      q.eq("tenantId", tenantId).eq("date", date),
    )) {
    const schedule = schedules.get(record.closerId);
    if (!schedule) {
      continue;
    }

    const blockedRange = {
      ...getEffectiveRange(record),
      reason: record.reason,
      isFullDay: record.isFullDay,
    };

    schedule.blockedRanges.push(blockedRange);

    if (record.isFullDay) {
      schedule.isAvailable = false;
      schedule.unavailabilityReason = record.reason;
    }
  }

  await Promise.all(
    [...schedules.entries()].map(async ([closerId, schedule]) => {
      for await (const meeting of ctx.db
        .query("meetings")
        .withIndex("by_tenantId_and_assignedCloserId_and_scheduledAt", (q) =>
          q
            .eq("tenantId", tenantId)
            .eq("assignedCloserId", closerId)
            .gte("scheduledAt", dayStart)
            .lt("scheduledAt", dayEnd),
        )) {
        if (meeting.status !== "scheduled") {
          continue;
        }

        schedule.meetings.push({
          meetingId: meeting._id,
          opportunityId: meeting.opportunityId,
          scheduledAt: meeting.scheduledAt,
          durationMinutes: meeting.durationMinutes,
          leadName: meeting.leadName,
        });
      }
    }),
  );

  for (const schedule of schedules.values()) {
    schedule.meetings.sort((a, b) => a.scheduledAt - b.scheduledAt);
    schedule.meetingsToday = schedule.meetings.length;
  }

  return schedules;
}
