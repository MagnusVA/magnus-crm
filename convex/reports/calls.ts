import type { ReaderArgs } from "../analytics/assistantTypes";
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { query, type QueryCtx } from "../_generated/server";
import {
  businessDateForInstant,
  type BusinessDaySetting,
} from "../../lib/businessDay";
import { getTenantBusinessDay } from "../lib/tenantBusinessDay";
import { assertValidDateRange } from "../reporting/lib/helpers";
import { requireTenantUser } from "../requireTenantUser";
import { REPORT_ADMIN_ROLES } from "./lib/access";
import {
  loadCallFacts,
  readRangeMeetings,
  type CallFacts,
  type CallType,
} from "./lib/callFacts";

import { attendanceFields } from "./lib/validators";

export const leadTimeBuckets = [
  "same_day",
  "next_day",
  "2_3_days",
  "4_7_days",
  "8_plus_days",
] as const;
export type Attendance = { held: number; noShow: number; notRecorded: number };
export type CallsSummary = {
  counts: {
    scheduled: number;
    moved: number;
    canceled: number;
    upcoming: number;
    due: number;
    held: number;
    noShow: number;
    notRecorded: number;
    rebooked: number;
    rebookedHeld: number;
    rebookedNoShow: number;
  };
  byType: Record<CallType, Attendance & { due: number }>;
  leadTime: Array<Attendance & { bucket: (typeof leadTimeBuckets)[number] }>;
  noShowMarkers: Record<"closer" | "admin" | "calendly" | "unknown", number>;
  noShowReasons: Array<{ reason: string; count: number }>;
  mode: Record<"priority" | "standard", Attendance>;
  recordMinutes: number[];
  byDay: Array<
    Attendance & { dayKey: string; canceled: number; moved: number }
  >;
  owed: Array<{
    meetingId: Id<"meetings">;
    opportunityId: Id<"opportunities">;
    scheduledAt: number;
    closerId: Id<"users">;
    closerName: string;
    leadName: string;
    programName: string;
  }>;
  owedTotal: number;
  partial: boolean;
};
export type CallsFilters = {
  programId?: Id<"tenantPrograms"> | null;
  closerId?: Id<"users"> | null;
  callType?: CallType | null;
};
export const attendance = (): Attendance => ({
  held: 0,
  noShow: 0,
  notRecorded: 0,
});

export function buildCallsSummary(
  input: CallFacts,
  filters: CallsFilters,
  setting: BusinessDaySetting,
): CallsSummary {
  const answer: CallsSummary = {
    counts: {
      scheduled: 0,
      moved: 0,
      canceled: 0,
      upcoming: 0,
      due: 0,
      held: 0,
      noShow: 0,
      notRecorded: 0,
      rebooked: 0,
      rebookedHeld: 0,
      rebookedNoShow: 0,
    },
    byType: {
      new: { ...attendance(), due: 0 },
      follow_up: { ...attendance(), due: 0 },
    },
    leadTime: leadTimeBuckets.map((bucket) => ({ bucket, ...attendance() })),
    noShowMarkers: { closer: 0, admin: 0, calendly: 0, unknown: 0 },
    noShowReasons: [],
    mode: { priority: attendance(), standard: attendance() },
    recordMinutes: [],
    byDay: [],
    owed: [],
    owedTotal: 0,
    partial: input.partial,
  };
  const days = new Map<string, CallsSummary["byDay"][number]>();
  const reasons = new Map<string, number>();
  for (const fact of input.facts) {
    const m = fact.meeting;
    if (
      (filters.programId && m.bookingProgramId !== filters.programId) ||
      (filters.closerId && fact.closerId !== filters.closerId) ||
      (filters.callType && fact.callType !== filters.callType)
    )
      continue;
    const dayKey = businessDateForInstant(m.scheduledAt, setting);
    const day = days.get(dayKey) ?? {
      dayKey,
      ...attendance(),
      canceled: 0,
      moved: 0,
    };
    days.set(dayKey, day);
    if (fact.status === "moved") {
      answer.counts.moved++;
      day.moved++;
      continue;
    }
    answer.counts.scheduled++;
    if (fact.recordMinutes !== null)
      answer.recordMinutes.push(fact.recordMinutes);
    if (fact.rebooked) {
      answer.counts.rebooked++;
      if (fact.status === "held") answer.counts.rebookedHeld++;
      if (fact.status === "no_show") answer.counts.rebookedNoShow++;
    }
    if (fact.status === "canceled") {
      answer.counts.canceled++;
      day.canceled++;
      continue;
    }
    if (fact.due) {
      answer.counts.due++;
      answer.byType[fact.callType].due++;
    }
    if (fact.status === "upcoming") {
      answer.counts.upcoming++;
      continue;
    }
    const key =
      fact.status === "held"
        ? "held"
        : fact.status === "no_show"
          ? "noShow"
          : "notRecorded";
    answer.counts[key]++;
    answer.byType[fact.callType][key]++;
    day[key]++;
    answer.mode[fact.standard ? "standard" : "priority"][key]++;
    if (fact.callType === "new") {
      const daysAhead = Math.max(
        0,
        Math.floor((m.scheduledAt - m.createdAt) / 86_400_000),
      );
      const bucket =
        daysAhead === 0
          ? 0
          : daysAhead === 1
            ? 1
            : daysAhead <= 3
              ? 2
              : daysAhead <= 7
                ? 3
                : 4;
      answer.leadTime[bucket][key]++;
    }
    if (fact.status === "no_show") {
      const source =
        m.noShowSource === "admin_manual"
          ? "admin"
          : m.noShowSource === "calendly_webhook"
            ? "calendly"
            : (m.noShowSource ?? "unknown");
      answer.noShowMarkers[source]++;
      const reason = m.noShowReason ?? "unknown";
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
    if (fact.status === "not_recorded")
      answer.owed.push({
        meetingId: m._id,
        opportunityId: m.opportunityId,
        scheduledAt: m.scheduledAt,
        closerId: fact.closerId,
        closerName: fact.closerName,
        leadName: fact.leadName,
        programName: fact.programName,
      });
  }
  answer.noShowReasons = [...reasons]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => a.reason.localeCompare(b.reason));
  answer.byDay = [...days.values()].sort((a, b) =>
    a.dayKey.localeCompare(b.dayKey),
  );
  answer.owedTotal = answer.owed.length;
  answer.owed.sort(
    (a, b) =>
      a.scheduledAt - b.scheduledAt || a.meetingId.localeCompare(b.meetingId),
  );
  answer.owed = answer.owed.slice(0, 200);
  return answer;
}

export const callsSummaryValidator = v.object({
  counts: v.object({
    scheduled: v.number(),
    moved: v.number(),
    canceled: v.number(),
    upcoming: v.number(),
    due: v.number(),
    ...attendanceFields,
    rebooked: v.number(),
    rebookedHeld: v.number(),
    rebookedNoShow: v.number(),
  }),
  byType: v.object({
    new: v.object({ due: v.number(), ...attendanceFields }),
    follow_up: v.object({ due: v.number(), ...attendanceFields }),
  }),
  leadTime: v.array(
    v.object({
      bucket: v.union(
        v.literal("same_day"),
        v.literal("next_day"),
        v.literal("2_3_days"),
        v.literal("4_7_days"),
        v.literal("8_plus_days"),
      ),
      ...attendanceFields,
    }),
  ),
  noShowMarkers: v.object({
    closer: v.number(),
    admin: v.number(),
    calendly: v.number(),
    unknown: v.number(),
  }),
  noShowReasons: v.array(v.object({ reason: v.string(), count: v.number() })),
  mode: v.object({
    priority: v.object(attendanceFields),
    standard: v.object(attendanceFields),
  }),
  recordMinutes: v.array(v.number()),
  byDay: v.array(
    v.object({
      dayKey: v.string(),
      ...attendanceFields,
      canceled: v.number(),
      moved: v.number(),
    }),
  ),
  owed: v.array(
    v.object({
      meetingId: v.id("meetings"),
      opportunityId: v.id("opportunities"),
      scheduledAt: v.number(),
      closerId: v.id("users"),
      closerName: v.string(),
      leadName: v.string(),
      programName: v.string(),
    }),
  ),
  owedTotal: v.number(),
  partial: v.boolean(),
});

export const getCallsSummary = query({
  returns: callsSummaryValidator,
  args: {
    // A minute clock from the page makes time-only changes reactive.
    asOf: v.optional(v.number()),
    startDate: v.number(),
    endDate: v.number(),
    programId: v.optional(v.id("tenantPrograms")),
    closerId: v.optional(v.id("users")),
    callType: v.optional(v.union(v.literal("new"), v.literal("follow_up"))),
  },
  handler: async (ctx, args): Promise<CallsSummary> => {
    const { tenantId } = await requireTenantUser(ctx, [...REPORT_ADMIN_ROLES]);
    return readCallsSummary(ctx, tenantId, args);
  },
});

/** Shared load/build path. Trusted callers must authorize the tenant first. */
export async function readCallsSummary(ctx: QueryCtx, tenantId: Id<"tenants">, args: ReaderArgs<typeof getCallsSummary>): Promise<CallsSummary> {
  assertValidDateRange(args.startDate, args.endDate);
  const meetings = await readRangeMeetings(
    ctx,
    tenantId,
    args.startDate,
    args.endDate,
  );
  const facts = await loadCallFacts(
    ctx,
    tenantId,
    meetings.rows,
    args.asOf ?? Date.now(),
  );
  return buildCallsSummary(
    { facts: facts.facts, partial: facts.partial || meetings.capped },
    args,
    await getTenantBusinessDay(ctx, tenantId),
  );
}
