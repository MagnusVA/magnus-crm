import { meetingAttendanceDisplay, meetingStatusConfig } from "../../../lib/status-config";
import { withAttendanceCounts } from "../../lib/meetingAttendance";
import { requireReportingReady } from "../reportingReadiness";
import type { PaginationOptions, PaginationResult } from "convex/server";
import { v } from "convex/values";
import type { Id } from "../../_generated/dataModel";
import { internalQuery, type QueryCtx } from "../../_generated/server";
import { addBusinessDays } from "../../../lib/businessDay";
import { goalDayCount as countGoalDays, rowInForce, weekdayForBusinessDate } from "../../lib/workSchedule";
import {
  bookingGoalCountsDay,
  loadBookingGoalGroups,
  loadQualifiedGoalGroup,
  qualifiedGoalDayCount,
} from "../../workSchedules/goalDays";
import type { ScheduleOwner, ScheduleRow } from "../../workSchedules/datedRows";
import { loadScheduleRowsByOwner } from "../../workSchedules/rangeHours";
import { createLiveReadState } from "../../lib/liveQueryBounds";
import { bookingCreditForMeeting } from "../../lib/attribution/dealAttributions";
import { leadDisplayFromShape } from "../../lib/leadDisplay";
import {
  dmCloserMemberIdentity,
  leadGenWorkerMemberIdentity,
  slackMemberIdentity,
  userMemberIdentity,
  type MemberAvatarIdentity,
} from "../../lib/memberIdentity";
import { dealStageOf } from "../../opportunities/stages";
import { closeRateCohortDealAt } from "../../reporting/lib/closeRateCohort";
import {
  resolveLegacyCompatibleAttributedCloserId,
  resolvePaymentType,
} from "../../lib/paymentTypes";
import {
  reportKindValidator,
  reportSourceFilterValidator,
  scalarValueValidator,
} from "./contracts";
import {
  REPORT_PAGE_MAX_BYTES_READ,
  REPORT_PAGE_MAX_ROWS_READ,
  REPORT_PAGE_SIZE,
  type ReportSourcePage,
  type ReportSourcePageRequest,
  type ReportSourceRow,
} from "./model";

// Matches the live dashboards' DM closer registry bound.
const DM_CLOSERS_PER_TEAM_LIMIT = 300;

const pageResultValidator = v.object({
  attendanceCountsPartial: v.optional(v.boolean()),
  page: v.array(v.record(v.string(), scalarValueValidator)),
  isDone: v.boolean(),
  continueCursor: v.string(),
  splitCursor: v.union(v.string(), v.null()),
  pageStatus: v.union(
    v.literal("SplitRecommended"),
    v.literal("SplitRequired"),
    v.null(),
  ),
  rowsRead: v.number(),
  estimatedBytes: v.number(),
});

function pagination(cursor: string | null, numItems = REPORT_PAGE_SIZE): PaginationOptions {
  return {
    cursor,
    numItems,
    maximumRowsRead: REPORT_PAGE_MAX_ROWS_READ,
    maximumBytesRead: REPORT_PAGE_MAX_BYTES_READ,
  };
}

function projectedPage<T>(result: PaginationResult<T>, page: ReportSourceRow[]): ReportSourcePage {
  return {
    page,
    isDone: result.isDone,
    continueCursor: result.continueCursor,
    splitCursor: result.splitCursor ?? null,
    pageStatus: result.pageStatus ?? null,
    rowsRead: result.page.length,
    estimatedBytes: new TextEncoder().encode(JSON.stringify(page)).byteLength,
  };
}

function syntheticPage(rows: ReportSourceRow[], cursor: string | null): ReportSourcePage {
  return {
    page: cursor === null ? rows : [],
    isDone: true,
    continueCursor: "",
    splitCursor: null,
    pageStatus: null,
    rowsRead: cursor === null ? rows.length : 0,
    estimatedBytes:
      cursor === null ? new TextEncoder().encode(JSON.stringify(rows)).byteLength : 2,
  };
}

function flattenIdentity(identity: MemberAvatarIdentity) {
  return {
    identityId: identity.id,
    identityName: identity.name,
    identityEmail: identity.email ?? null,
    identityImageUrl: identity.imageUrl ?? null,
    identityImageSource: identity.imageSource,
    identitySecondaryLabel: identity.secondaryLabel ?? null,
    identityIsActive: identity.isActive ?? null,
    identitySource: identity.source,
  };
}

function assertSource(reportKind: ReportSourcePageRequest["reportKind"], sourceKey: string) {
  const allowed: Record<ReportSourcePageRequest["reportKind"], ReadonlySet<string>> = {
    "lead-gen": new Set([
      "lead_gen_workers",
      "lead_gen_sources",
      "teams",
      "lead_gen_worker_schedules",
      "lead_gen_daily",
      "lead_gen_origins",
      "lead_gen_team_origins",
      "lead_gen_filtered_origin_submissions",
      "lead_gen_submissions",
    ]),
    qualifications: new Set([
      "tenant",
      "slack_users",
      "qualifier_schedules",
      "qualification_events",
    ]),
    "booked-calls": new Set([
      "teams",
      "dm_closers",
      "dm_closer_schedules",
      "booked_meetings",
    ]),
    "sales-calls": new Set([
      "users",
      "programs",
      "sales_meeting_stats",
      "sales_close_rate_cohort",
      "sales_calls",
      "sales_payments",
    ]),
  };
  if (!allowed[reportKind].has(sourceKey)) {
    throw new Error(`Source ${sourceKey} does not belong to ${reportKind}.`);
  }
}

async function readLeadGenDaily(ctx: QueryCtx, args: ReportSourcePageRequest) {
  const opts = pagination(args.cursor, 8);
  const result = args.workerId
    ? await ctx.db
        .query("leadGenDailyStats")
        .withIndex("by_tenantId_and_workerId_and_dayKey", (q) =>
          q.eq("tenantId", args.tenantId).eq("workerId", args.workerId!).gte("dayKey", args.startDayKey).lt("dayKey", args.endDayKeyExclusive),
        )
        .paginate(opts)
    : args.teamId
      ? await ctx.db
          .query("leadGenDailyStats")
          .withIndex("by_tenantId_and_teamId_and_dayKey", (q) =>
            q.eq("tenantId", args.tenantId).eq("teamId", args.teamId!).gte("dayKey", args.startDayKey).lt("dayKey", args.endDayKeyExclusive),
          )
          .paginate(opts)
      : args.sourceFilter !== "all"
        ? await ctx.db
            .query("leadGenDailyStats")
            .withIndex("by_tenantId_and_source_and_dayKey", (q) =>
              q.eq("tenantId", args.tenantId).eq("source", args.sourceFilter as "instagram" | "meta_business").gte("dayKey", args.startDayKey).lt("dayKey", args.endDayKeyExclusive),
            )
            .paginate(opts)
        : await ctx.db
            .query("leadGenDailyStats")
            .withIndex("by_tenantId_and_dayKey", (q) =>
              q.eq("tenantId", args.tenantId).gte("dayKey", args.startDayKey).lt("dayKey", args.endDayKeyExclusive),
            )
            .paginate(opts);

  const filtered = result.page.filter(
    (row) =>
      (!args.teamId || row.teamId === args.teamId) &&
      (!args.workerId || row.workerId === args.workerId) &&
      (args.sourceFilter === "all" || row.source === args.sourceFilter),
  );
  // Each day under the worker's schedule in force that day; the bucket's
  // snapshot when none was.
  const scheduleRowsByWorker = await loadScheduleRowsByOwner(ctx, {
    tenantId: args.tenantId,
    keys: filtered.map((row) => row.workerId),
    owner: (workerId) => ({ table: "leadGenWorkerSchedules", workerId }),
  });
  const page: ReportSourceRow[] = filtered.map((row) => ({
    kind: "lead_gen_daily",
    statKey: row.statKey,
    workerId: row.workerId,
    teamId: row.teamId ?? null,
    source: row.source,
    requestedSourceFilter: args.sourceFilter,
    dayKey: row.dayKey,
    submissions: row.submissions,
    uniqueProspects: row.uniqueProspectsSubmitted,
    duplicates: row.duplicateProspectSubmissions,
    scheduledHours:
      rowInForce(scheduleRowsByWorker.get(row.workerId) ?? [], weekdayForBusinessDate(row.dayKey), row.dayKey)
        ?.scheduledHours ?? row.scheduledHours,
  }));
  return projectedPage(result, page);
}

function rangeDayKeys(args: Pick<ReportSourcePageRequest, "startDayKey" | "endDayKeyExclusive">) {
  const days: string[] = [];
  for (let day = args.startDayKey; day < args.endDayKeyExclusive; day = addBusinessDays(day, 1)) days.push(day);
  return days;
}

/**
 * Schedule rows with the days of the range each was in force (`occurrences`):
 * a dated row counts only from its date until the owner's next row for the
 * weekday (convex/lib/workSchedule.ts, "Dated schedules").
 */
async function scheduleRowsWithOccurrences<Row extends ScheduleRow, Key>(
  ctx: QueryCtx,
  args: ReportSourcePageRequest,
  rows: readonly Row[],
  keyOf: (row: Row) => Key,
  owner: (key: Key) => ScheduleOwner,
) {
  const state = createLiveReadState();
  const ownerRows = await loadScheduleRowsByOwner(ctx, {
    tenantId: args.tenantId,
    keys: rows.map(keyOf),
    owner,
    liveReadState: state,
  });
  if (state.capped) throw new Error("Schedules exceed the report's read budget.");
  const days = rangeDayKeys(args);
  return rows.map((row) => {
    const all = ownerRows.get(keyOf(row)) ?? [row];
    const occurrences = days.filter(
      (day) => weekdayForBusinessDate(day) === row.weekday && rowInForce(all, row.weekday, day)?._id === row._id,
    ).length;
    return { row, occurrences };
  });
}

/**
 * The days of the range a goal counts for each team: the days one of its
 * active DM closers works (bookingGoalDayCounts).
 */
async function teamGoalDayCounts(ctx: QueryCtx, args: ReportSourcePageRequest, teamIds: Id<"attributionTeams">[]) {
  const closers = [];
  for (const teamId of teamIds) {
    closers.push(
      ...(await ctx.db
        .query("dmClosers")
        .withIndex("by_tenantId_and_teamId", (q) => q.eq("tenantId", args.tenantId).eq("teamId", teamId))
        .take(DM_CLOSERS_PER_TEAM_LIMIT)),
    );
  }
  const groups = await loadBookingGoalGroups(ctx, { tenantId: args.tenantId, teamIds, dmClosers: closers });
  if (!groups) return null;
  const days = rangeDayKeys(args);
  const last = days[days.length - 1];
  return new Map([...groups].map(([teamId, group]) => [teamId, {
    count: countGoalDays(group, days),
    countsLastDay: last ? bookingGoalCountsDay(group, last) : true,
  }]));
}

/** The days of the range the qualified-leads goal counts (qualifiedGoalDayCount); null if the reads ran out. */
async function qualifiedGoalDays(ctx: QueryCtx, args: ReportSourcePageRequest) {
  const group = await loadQualifiedGoalGroup(ctx, args.tenantId);
  if (!group) return null;
  return qualifiedGoalDayCount(group.slackUsers, group.scheduleRowsBySlackUserId, rangeDayKeys(args));
}

async function readLeadGenOrigins(ctx: QueryCtx, args: ReportSourcePageRequest, teamScoped: boolean) {
  if (teamScoped) {
    const result = args.teamId && args.sourceFilter !== "all"
      ? await ctx.db.query("leadGenTeamOriginStats").withIndex("by_tenantId_and_teamId_and_source_and_dayKey", (q) => q.eq("tenantId", args.tenantId).eq("teamId", args.teamId!).eq("source", args.sourceFilter as "instagram" | "meta_business").gte("dayKey", args.startDayKey).lt("dayKey", args.endDayKeyExclusive)).paginate(pagination(args.cursor))
      : args.teamId
        ? await ctx.db.query("leadGenTeamOriginStats").withIndex("by_tenantId_and_teamId_and_dayKey", (q) => q.eq("tenantId", args.tenantId).eq("teamId", args.teamId!).gte("dayKey", args.startDayKey).lt("dayKey", args.endDayKeyExclusive)).paginate(pagination(args.cursor))
        : args.sourceFilter !== "all"
          ? await ctx.db.query("leadGenTeamOriginStats").withIndex("by_tenantId_and_source_and_dayKey", (q) => q.eq("tenantId", args.tenantId).eq("source", args.sourceFilter as "instagram" | "meta_business").gte("dayKey", args.startDayKey).lt("dayKey", args.endDayKeyExclusive)).paginate(pagination(args.cursor))
          : await ctx.db.query("leadGenTeamOriginStats").withIndex("by_tenantId_and_dayKey", (q) => q.eq("tenantId", args.tenantId).gte("dayKey", args.startDayKey).lt("dayKey", args.endDayKeyExclusive)).paginate(pagination(args.cursor));
    return projectedPage(result, result.page.map((row): ReportSourceRow => ({ kind: "lead_gen_team_origin", teamId: row.teamId ?? null, originKey: row.originKey, source: row.source, originKind: row.originKind, originValue: row.originValue, dayKey: row.dayKey, submissions: row.submissions, uniqueProspects: row.uniqueProspectsSubmitted })));
  }
  const result = args.sourceFilter !== "all"
    ? await ctx.db.query("leadGenOriginStats").withIndex("by_tenantId_and_source_and_dayKey", (q) => q.eq("tenantId", args.tenantId).eq("source", args.sourceFilter as "instagram" | "meta_business").gte("dayKey", args.startDayKey).lt("dayKey", args.endDayKeyExclusive)).paginate(pagination(args.cursor))
    : await ctx.db.query("leadGenOriginStats").withIndex("by_tenantId_and_dayKey", (q) => q.eq("tenantId", args.tenantId).gte("dayKey", args.startDayKey).lt("dayKey", args.endDayKeyExclusive)).paginate(pagination(args.cursor));
  return projectedPage(result, result.page.map((row): ReportSourceRow => ({ kind: "lead_gen_origin", originKey: row.originKey, source: row.source, originKind: row.originKind, originValue: row.originValue, dayKey: row.dayKey, submissions: row.submissions, uniqueProspects: row.uniqueProspectsSubmitted })));
}

async function readLeadGenSubmissions(ctx: QueryCtx, args: ReportSourcePageRequest) {
  const needsHydration = args.sourceKey === "lead_gen_submissions";
  const opts = pagination(args.cursor, needsHydration ? 8 : REPORT_PAGE_SIZE);
  const result = args.workerId
    ? await ctx.db.query("leadGenSubmissions").withIndex("by_tenantId_and_workerId_and_submittedAt", (q) => q.eq("tenantId", args.tenantId).eq("workerId", args.workerId!).gte("submittedAt", args.startTimestamp).lt("submittedAt", args.endTimestampExclusive)).paginate(opts)
    : args.teamId
      ? await ctx.db.query("leadGenSubmissions").withIndex("by_tenantId_and_teamId_and_submittedAt", (q) => q.eq("tenantId", args.tenantId).eq("teamId", args.teamId!).gte("submittedAt", args.startTimestamp).lt("submittedAt", args.endTimestampExclusive)).paginate(opts)
      : args.sourceFilter !== "all"
        ? await ctx.db.query("leadGenSubmissions").withIndex("by_tenantId_and_source_and_submittedAt", (q) => q.eq("tenantId", args.tenantId).eq("source", args.sourceFilter as "instagram" | "meta_business").gte("submittedAt", args.startTimestamp).lt("submittedAt", args.endTimestampExclusive)).paginate(opts)
        : await ctx.db.query("leadGenSubmissions").withIndex("by_tenantId_and_submittedAt", (q) => q.eq("tenantId", args.tenantId).gte("submittedAt", args.startTimestamp).lt("submittedAt", args.endTimestampExclusive)).paginate(opts);
  const filtered = result.page.filter((row) => (!args.teamId || row.teamId === args.teamId) && (!args.workerId || row.workerId === args.workerId) && (args.sourceFilter === "all" || row.source === args.sourceFilter));
  const page = await Promise.all(filtered.map(async (row): Promise<ReportSourceRow> => {
    if (!needsHydration) {
      return {
        kind: "lead_gen_submission", submissionId: row._id, prospectId: row.prospectId,
        workerId: row.workerId, workerDisplayName: "", workerEmail: "", userId: row.userId,
        teamId: row.teamId ?? null, teamName: null, source: row.source,
        originKind: row.originKind, originValue: row.originValue ?? null,
        originRankable: row.originRankable, submittedAt: row.submittedAt,
        voidedAt: row.voidedAt ?? null, voidedByUserId: row.voidedByUserId ?? null,
        voidReason: row.voidReason ?? null, normalizedHandle: null, rawHandle: null,
        profileUrl: null, clientSubmissionKey: row.clientSubmissionKey ?? null,
        createdAt: row.createdAt,
      };
    }
    // Registry dimensions supply worker/team labels during finalization. Eight
    // prospects plus the 1 MiB primary page stay below the 16 MiB read limit,
    // even if every related document reaches Convex's 1 MiB document limit.
    const prospect = await ctx.db.get("leadGenProspects", row.prospectId);
    const tenantProspect = prospect?.tenantId === args.tenantId ? prospect : null;
    return {
      kind: "lead_gen_submission", submissionId: row._id, prospectId: row.prospectId,
      workerId: row.workerId, workerDisplayName: "", workerEmail: "",
      userId: row.userId, teamId: row.teamId ?? null, teamName: null,
      source: row.source, originKind: row.originKind, originValue: row.originValue ?? null,
      originRankable: row.originRankable, submittedAt: row.submittedAt, voidedAt: row.voidedAt ?? null,
      voidedByUserId: row.voidedByUserId ?? null, voidReason: row.voidReason ?? null,
      normalizedHandle: tenantProspect?.normalizedHandle ?? null, rawHandle: tenantProspect?.rawHandle ?? null,
      profileUrl: tenantProspect?.profileUrl ?? null, clientSubmissionKey: row.clientSubmissionKey ?? null, createdAt: row.createdAt,
    };
  }));
  return projectedPage(result, page);
}

async function readRegistry(ctx: QueryCtx, args: ReportSourcePageRequest): Promise<ReportSourcePage | null> {
  const opts = pagination(args.cursor);
  if (args.sourceKey === "lead_gen_workers") {
    const result = await ctx.db.query("leadGenWorkers").withIndex("by_tenantId_and_userId", (q) => q.eq("tenantId", args.tenantId)).paginate(opts);
    const page = await Promise.all(result.page.map(async (row): Promise<ReportSourceRow> => {
      const identity = await leadGenWorkerMemberIdentity(ctx, row);
      return { kind: "lead_gen_worker", workerId: row._id, userId: row.userId, teamId: row.teamId ?? null, label: identity.name ?? row.email, email: row.email, isActive: row.isActive, ...flattenIdentity(identity) };
    }));
    return projectedPage(result, page);
  }
  if (args.sourceKey === "lead_gen_sources") {
    const sources = (["instagram", "meta_business"] as const)
      .filter((source) => args.sourceFilter === "all" || source === args.sourceFilter)
      .map((source): ReportSourceRow => ({ kind: "lead_gen_source_dimension", source }));
    return syntheticPage(sources, args.cursor);
  }
  if (args.sourceKey === "teams") {
    const result = await ctx.db.query("attributionTeams").withIndex("by_tenantId", (q) => q.eq("tenantId", args.tenantId)).paginate(args.reportKind === "booked-calls" ? pagination(args.cursor, 8) : opts);
    // Only Booked Calls has team goals.
    const goalDays = args.reportKind === "booked-calls" ? await teamGoalDayCounts(ctx, args, result.page.map((row) => row._id)) : null;
    if (args.reportKind === "booked-calls" && goalDays === null) throw new Error("Team schedules exceed the report's read budget.");
    return projectedPage(result, result.page.map((row): ReportSourceRow => ({ kind: "team", teamId: row._id, label: row.displayName, isActive: row.isActive, bookingDailyQuota: row.bookingDailyQuota ?? null, goalDayCount: goalDays?.get(row._id)?.count ?? null, goalCountsLastDay: goalDays?.get(row._id)?.countsLastDay })));
  }
  if (args.sourceKey === "lead_gen_worker_schedules") {
    const result = await ctx.db.query("leadGenWorkerSchedules").withIndex("by_tenantId_and_workerId_and_weekday_and_effectiveFrom", (q) => q.eq("tenantId", args.tenantId)).paginate(opts);
    const rows = await scheduleRowsWithOccurrences(ctx, args, result.page, (row) => row.workerId, (workerId) => ({ table: "leadGenWorkerSchedules", workerId }));
    return projectedPage(result, rows.map(({ row, occurrences }): ReportSourceRow => ({ kind: "lead_gen_schedule", workerId: row.workerId, weekday: row.weekday, scheduledHours: row.scheduledHours, occurrences })));
  }
  if (args.sourceKey === "slack_users") {
    const result = await ctx.db.query("slackUsers").withIndex("by_tenantId", (q) => q.eq("tenantId", args.tenantId)).paginate(opts);
    return projectedPage(result, result.page.map((row): ReportSourceRow => {
      const identity = slackMemberIdentity(row, row.slackUserId);
      return { kind: "slack_user", slackUserId: row.slackUserId, label: identity.name ?? row.slackUserId, slackUsername: row.username?.trim() || null, ...flattenIdentity(identity) };
    }));
  }
  if (args.sourceKey === "qualifier_schedules") {
    const result = await ctx.db.query("slackQualifierSchedules").withIndex("by_tenantId_and_slackUserId_and_weekday_and_effectiveFrom", (q) => q.eq("tenantId", args.tenantId)).paginate(opts);
    const rows = await scheduleRowsWithOccurrences(ctx, args, result.page, (row) => row.slackUserId, (slackUserId) => ({ table: "slackQualifierSchedules", slackUserId }));
    return projectedPage(result, rows.map(({ row, occurrences }): ReportSourceRow => ({ kind: "qualifier_schedule", slackUserId: row.slackUserId, weekday: row.weekday, scheduledHours: row.scheduledHours, occurrences })));
  }
  if (args.sourceKey === "dm_closers") {
    // Each primary row can hydrate one linked user (including a storage URL),
    // so keep the fan-out well below the action transaction byte budget.
    const result = await ctx.db.query("dmClosers").withIndex("by_tenantId_and_teamId", (q) => q.eq("tenantId", args.tenantId)).paginate(pagination(args.cursor, 4));
    const page = await Promise.all(result.page.map(async (row): Promise<ReportSourceRow> => {
      const linked = row.userId ? await ctx.db.get("users", row.userId) : null;
      const linkedUser = linked?.tenantId === args.tenantId ? linked : null;
      const identity = await dmCloserMemberIdentity(ctx, row, linkedUser);
      return { kind: "dm_closer", dmCloserId: row._id, userId: row.userId ?? null, teamId: row.teamId, label: row.displayName, isActive: row.isActive, hourlyRateMinor: row.hourlyRateMinor ?? null, ...flattenIdentity(identity) };
    }));
    return projectedPage(result, page);
  }
  if (args.sourceKey === "dm_closer_schedules") {
    const result = await ctx.db.query("dmCloserSchedules").withIndex("by_tenantId_and_dmCloserId_and_weekday_and_effectiveFrom", (q) => q.eq("tenantId", args.tenantId)).paginate(opts);
    const rows = await scheduleRowsWithOccurrences(ctx, args, result.page, (row) => row.dmCloserId, (dmCloserId) => ({ table: "dmCloserSchedules", dmCloserId }));
    return projectedPage(result, rows.map(({ row, occurrences }): ReportSourceRow => ({ kind: "dm_closer_schedule", dmCloserId: row.dmCloserId, weekday: row.weekday, scheduledHours: row.scheduledHours, occurrences })));
  }
  if (args.sourceKey === "users") {
    const result = await ctx.db.query("users").withIndex("by_tenantId", (q) => q.eq("tenantId", args.tenantId)).paginate(opts);
    const page = await Promise.all(result.page.map(async (row): Promise<ReportSourceRow> => {
      const identity = await userMemberIdentity(ctx, row);
      return { kind: "user", userId: row._id, label: identity.name ?? row.email, role: row.role, isActive: row.isActive, ...flattenIdentity(identity) };
    }));
    return projectedPage(result, page);
  }
  if (args.sourceKey === "programs") {
    const result = await ctx.db.query("tenantPrograms").withIndex("by_tenantId_and_archivedAt", (q) => q.eq("tenantId", args.tenantId)).paginate(opts);
    return projectedPage(result, result.page.map((row): ReportSourceRow => ({ kind: "program", programId: row._id, label: row.name })));
  }
  return null;
}

async function readQualificationEvents(ctx: QueryCtx, args: ReportSourcePageRequest) {
  const result = await ctx.db.query("slackQualificationEvents").withIndex("by_tenantId_and_submittedAt", (q) => q.eq("tenantId", args.tenantId).gte("submittedAt", args.startTimestamp).lt("submittedAt", args.endTimestampExclusive)).paginate(pagination(args.cursor));
  return projectedPage(result, result.page.map((row): ReportSourceRow => ({ kind: "qualification_event", eventId: row._id, submittedAt: row.submittedAt, slackUserId: row.slackUserId, slackTeamId: row.slackTeamId, fullNameSnapshot: row.fullNameSnapshot, platform: row.platform, handleSnapshot: row.handleSnapshot, leadId: row.leadId ?? null, opportunityId: row.opportunityId ?? null, resultKind: row.resultKind })));
}

// First bookings (anything but a follow_up) with their credit from the
// booking's dm_team and dm_closer rows, as Booked Calls counts them (§6.1).
// Team-only bookings come along for their team's goal; the reducer keeps them
// out of the DM closer counts and the raw list. Two meetings a page, so rows
// are read by meeting.
async function readBookedMeetings(ctx: QueryCtx, args: ReportSourcePageRequest) {
  const result = await ctx.db.query("meetings").withIndex("by_tenantId_and_createdAt", (q) => q.eq("tenantId", args.tenantId).gte("createdAt", args.startTimestamp).lt("createdAt", args.endTimestampExclusive)).paginate(pagination(args.cursor, 2));
  const firstBookings = result.page.filter((row) => row.callClassification !== "follow_up");
  const credited = await Promise.all(firstBookings.map(async (meeting) => ({ meeting, credit: await bookingCreditForMeeting(ctx, args.tenantId, meeting._id) })));
  const booked = credited.filter(({ credit }) => credit.dmCloserId !== undefined || credit.teamId !== undefined);
  const page = await Promise.all(booked.map(async ({ meeting, credit }): Promise<ReportSourceRow> => {
    const [opportunity, team, dmCloser] = await Promise.all([ctx.db.get("opportunities", meeting.opportunityId), credit.teamId ? ctx.db.get("attributionTeams", credit.teamId) : Promise.resolve(null), credit.dmCloserId ? ctx.db.get("dmClosers", credit.dmCloserId) : Promise.resolve(null)]);
    const tenantOpportunity = opportunity?.tenantId === args.tenantId ? opportunity : null;
    const tenantTeam = team?.tenantId === args.tenantId ? team : null;
    const tenantDmCloser = dmCloser?.tenantId === args.tenantId ? dmCloser : null;
    const leadCandidate = tenantOpportunity ? await ctx.db.get("leads", tenantOpportunity.leadId) : null;
    const lead = leadCandidate?.tenantId === args.tenantId ? leadCandidate : null;
    const deal = tenantOpportunity ? dealStageOf(tenantOpportunity) : null;
    return {
      kind: "booked_meeting", meetingId: meeting._id, opportunityId: meeting.opportunityId,
      leadId: lead?._id ?? tenantOpportunity?.leadId ?? null, bookedAt: meeting.createdAt, scheduledAt: meeting.scheduledAt,
      meetingStatus: meeting.status, attendance: meetingStatusConfig[meetingAttendanceDisplay(meeting, Date.now())].label, dealStage: deal?.stage ?? null, dealOutcome: deal?.outcome ?? null,
      bookingProgramId: meeting.bookingProgramId ?? null, bookingProgramName: meeting.bookingProgramName ?? tenantOpportunity?.firstBookingProgramName ?? null,
      leadLabel: lead ? leadDisplayFromShape({ fullName: lead.fullName, email: lead.email, leadId: lead._id }) : meeting.leadName?.trim() || "Unknown lead",
      leadHandle: lead?.socialHandles?.[0]?.handle ?? lead?.email ?? lead?.phone ?? null,
      initialSource: lead?.initialSource ?? null, selfReportedIncome: lead?.selfReportedIncome ?? null,
      attributionTeamId: credit.teamId ?? null, attributionTeamLabel: tenantTeam?.displayName ?? null,
      dmCloserId: credit.dmCloserId ?? null, dmCloserLabel: tenantDmCloser?.displayName ?? null,
    };
  }));
  return projectedPage(result, page);
}

async function readSalesMeetingStats(ctx: QueryCtx, args: ReportSourcePageRequest) {
  await requireReportingReady(ctx, args.tenantId);
  const result = await ctx.db.query("operationsMeetingStatsV2").withIndex("by_tenantId_and_dayKey", (q) => q.eq("tenantId", args.tenantId).gte("dayKey", args.startDayKey).lt("dayKey", args.endDayKeyExclusive)).paginate(pagination(args.cursor));
  const { counts, attendanceCountsPartial } = await withAttendanceCounts(ctx, args.tenantId, result.page);
  return { ...projectedPage(result, counts.map((row): ReportSourceRow => ({ kind: "sales_meeting_stat", attendanceCountsPartial, notRecorded: row.notRecorded, assignedCloserId: row.assignedCloserId, bookingProgramId: row.bookingProgramId ?? null, meetingStatus: row.meetingStatus, count: row.count }))), attendanceCountsPartial };
}

// The close rate cohort, one row per deal: the range's held meetings, kept
// when the meeting is its deal's first held call. Up to two more reads per
// meeting (its deal's first held call, the deal), so pages are smaller.
async function readSalesCloseRateCohort(ctx: QueryCtx, args: ReportSourcePageRequest) {
  const result = await ctx.db.query("meetings").withIndex("by_tenantId_and_status_and_scheduledAt", (q) => q.eq("tenantId", args.tenantId).eq("status", "held").gte("scheduledAt", args.startTimestamp).lt("scheduledAt", args.endTimestampExclusive)).paginate(pagination(args.cursor, 25));
  const page: ReportSourceRow[] = [];
  for (const meeting of result.page) {
    const deal = await closeRateCohortDealAt(ctx, args.tenantId, meeting);
    if (!deal) continue;
    page.push({ kind: "sales_close_rate_deal", opportunityId: deal.opportunityId, closerId: deal.closerId, bookingProgramId: deal.bookingProgramId, won: deal.won });
  }
  return projectedPage(result, page);
}

async function readSalesCalls(ctx: QueryCtx, args: ReportSourcePageRequest) {
  const result = await ctx.db.query("meetings").withIndex("by_tenantId_and_scheduledAt", (q) => q.eq("tenantId", args.tenantId).gte("scheduledAt", args.startTimestamp).lt("scheduledAt", args.endTimestampExclusive)).paginate(pagination(args.cursor, 4));
  const page = await Promise.all(result.page.map(async (meeting): Promise<ReportSourceRow> => {
    const opportunity = await ctx.db.get("opportunities", meeting.opportunityId);
    const tenantOpportunity = opportunity?.tenantId === args.tenantId ? opportunity : null;
    const leadCandidate = tenantOpportunity ? await ctx.db.get("leads", tenantOpportunity.leadId) : null;
    const lead = leadCandidate?.tenantId === args.tenantId ? leadCandidate : null;
    return { kind: "sales_call", meetingId: meeting._id, opportunityId: meeting.opportunityId, assignedCloserId: meeting.assignedCloserId, scheduledAt: meeting.scheduledAt, status: meeting.status, attendance: meetingStatusConfig[meetingAttendanceDisplay(meeting, Date.now())].label, bookingProgramId: meeting.bookingProgramId ?? null, bookingProgramName: meeting.bookingProgramName ?? tenantOpportunity?.firstBookingProgramName ?? null, soldProgramId: meeting.soldProgramId ?? null, soldProgramName: meeting.soldProgramName ?? tenantOpportunity?.soldProgramName ?? null, leadId: lead?._id ?? tenantOpportunity?.leadId ?? null, leadLabel: lead ? leadDisplayFromShape({ fullName: lead.fullName, email: lead.email, leadId: lead._id }) : meeting.leadName?.trim() || "Unknown lead" };
  }));
  return projectedPage(result, page);
}

async function readSalesPayments(ctx: QueryCtx, args: ReportSourcePageRequest) {
  const result = await ctx.db.query("paymentRecords").withIndex("by_tenantId_and_recordedAt", (q) => q.eq("tenantId", args.tenantId).gte("recordedAt", args.startTimestamp).lt("recordedAt", args.endTimestampExclusive)).paginate(pagination(args.cursor));
  const eligible = result.page.filter((payment) => payment.status !== "disputed" && resolvePaymentType(payment.paymentType) !== "deposit");
  return projectedPage(result, eligible.map((row): ReportSourceRow => ({ kind: "sales_payment", paymentId: row._id, recordedAt: row.recordedAt, opportunityId: row.opportunityId ?? null, amountMinor: row.amountMinor, currency: row.currency, paymentType: resolvePaymentType(row.paymentType), programId: row.programId, programName: row.programName, effectiveCloserId: resolveLegacyCompatibleAttributedCloserId(row) ?? null })));
}

export async function readSourcePage(ctx: QueryCtx, args: ReportSourcePageRequest): Promise<ReportSourcePage> {
  assertSource(args.reportKind, args.sourceKey);
  const registry = await readRegistry(ctx, args);
  if (registry) return registry;
  switch (args.sourceKey) {
    case "tenant": {
      const tenant = await ctx.db.get("tenants", args.tenantId);
      const goalDayCount = tenant ? await qualifiedGoalDays(ctx, args) : null;
      if (tenant && goalDayCount === null) throw new Error("Qualifier schedules exceed the report's read budget.");
      return syntheticPage(tenant ? [{ kind: "tenant", slackQualificationDailyTeamQuota: tenant.slackQualificationDailyTeamQuota ?? null, goalDayCount }] : [], args.cursor);
    }
    case "lead_gen_daily": return await readLeadGenDaily(ctx, args);
    case "lead_gen_origins": return await readLeadGenOrigins(ctx, args, false);
    case "lead_gen_team_origins": return await readLeadGenOrigins(ctx, args, true);
    case "lead_gen_submissions": return await readLeadGenSubmissions(ctx, args);
    case "lead_gen_filtered_origin_submissions": return await readLeadGenSubmissions(ctx, args);
    case "qualification_events": return await readQualificationEvents(ctx, args);
    case "booked_meetings": return await readBookedMeetings(ctx, args);
    case "sales_meeting_stats": return await readSalesMeetingStats(ctx, args);
    case "sales_close_rate_cohort": return await readSalesCloseRateCohort(ctx, args);
    case "sales_calls": return await readSalesCalls(ctx, args);
    case "sales_payments": return await readSalesPayments(ctx, args);
    default: throw new Error(`Unknown report source: ${args.sourceKey}`);
  }
}

export const readReportSourcePage = internalQuery({
  args: {
    tenantId: v.id("tenants"), reportKind: reportKindValidator, sourceKey: v.string(),
    startTimestamp: v.number(), endTimestampExclusive: v.number(), startDayKey: v.string(), endDayKeyExclusive: v.string(),
    sourceFilter: reportSourceFilterValidator,
    teamId: v.optional(v.union(v.id("attributionTeams"), v.null())),
    workerId: v.optional(v.union(v.id("leadGenWorkers"), v.null())),
    cursor: v.union(v.string(), v.null()),
  },
  returns: pageResultValidator,
  handler: async (ctx, args) => await readSourcePage(ctx, { ...args, teamId: args.teamId ?? null, workerId: args.workerId ?? null }),
});
