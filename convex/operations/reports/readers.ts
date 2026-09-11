import type { PaginationOptions, PaginationResult } from "convex/server";
import { v } from "convex/values";
import { internalQuery, type QueryCtx } from "../../_generated/server";
import { leadDisplayFromShape } from "../../lib/leadDisplay";
import {
  resolveLegacyCompatibleAttributedCloserId,
  resolveLegacyCompatiblePaymentCommissionable,
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

const pageResultValidator = v.object({
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
  const hoursByWorkerDay = new Map<string, number>();
  for (const workerId of [...new Set(filtered.map((row) => row.workerId))]) {
    const schedules = await ctx.db
      .query("leadGenWorkerSchedules")
      .withIndex("by_tenantId_and_workerId", (q) =>
        q.eq("tenantId", args.tenantId).eq("workerId", workerId),
      )
      .take(7);
    for (const schedule of schedules) {
      hoursByWorkerDay.set(`${workerId}:${schedule.weekday}`, schedule.scheduledHours);
    }
  }
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
      hoursByWorkerDay.get(`${row.workerId}:${weekday(row.dayKey)}`) ?? row.scheduledHours,
  }));
  return projectedPage(result, page);
}

function weekday(dayKey: string) {
  const names = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
  return names[new Date(`${dayKey}T12:00:00.000Z`).getUTCDay()];
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
  const opts = pagination(args.cursor, needsHydration ? 2 : REPORT_PAGE_SIZE);
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
    const [prospect, worker, team] = await Promise.all([
      ctx.db.get(row.prospectId),
      ctx.db.get(row.workerId),
      row.teamId ? ctx.db.get(row.teamId) : Promise.resolve(null),
    ]);
    const tenantProspect = prospect?.tenantId === args.tenantId ? prospect : null;
    const tenantWorker = worker?.tenantId === args.tenantId ? worker : null;
    const tenantTeam = team?.tenantId === args.tenantId ? team : null;
    return {
      kind: "lead_gen_submission", submissionId: row._id, prospectId: row.prospectId,
      workerId: row.workerId, workerDisplayName: tenantWorker?.displayName ?? tenantWorker?.email ?? "Unknown worker", workerEmail: tenantWorker?.email ?? "",
      userId: row.userId, teamId: row.teamId ?? null, teamName: tenantTeam?.displayName ?? null,
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
    const result = await ctx.db.query("leadGenWorkers").withIndex("by_tenantId", (q) => q.eq("tenantId", args.tenantId)).paginate(opts);
    return projectedPage(result, result.page.map((row): ReportSourceRow => ({ kind: "lead_gen_worker", workerId: row._id, userId: row.userId, teamId: row.teamId ?? null, label: row.displayName ?? row.email, email: row.email, isActive: row.isActive })));
  }
  if (args.sourceKey === "lead_gen_sources") {
    const sources = (["instagram", "meta_business"] as const)
      .filter((source) => args.sourceFilter === "all" || source === args.sourceFilter)
      .map((source): ReportSourceRow => ({ kind: "lead_gen_source_dimension", source }));
    return syntheticPage(sources, args.cursor);
  }
  if (args.sourceKey === "teams") {
    const result = await ctx.db.query("attributionTeams").withIndex("by_tenantId", (q) => q.eq("tenantId", args.tenantId)).paginate(opts);
    return projectedPage(result, result.page.map((row): ReportSourceRow => ({ kind: "team", teamId: row._id, label: row.displayName, isActive: row.isActive, bookingDailyQuota: row.bookingDailyQuota ?? null })));
  }
  if (args.sourceKey === "lead_gen_worker_schedules") {
    const result = await ctx.db.query("leadGenWorkerSchedules").withIndex("by_tenantId_and_workerId", (q) => q.eq("tenantId", args.tenantId)).paginate(opts);
    return projectedPage(result, result.page.map((row): ReportSourceRow => ({ kind: "lead_gen_schedule", workerId: row.workerId, weekday: row.weekday, scheduledHours: row.scheduledHours })));
  }
  if (args.sourceKey === "slack_users") {
    const result = await ctx.db.query("slackUsers").withIndex("by_tenantId", (q) => q.eq("tenantId", args.tenantId)).paginate(opts);
    return projectedPage(result, result.page.map((row): ReportSourceRow => ({ kind: "slack_user", slackUserId: row.slackUserId, label: row.displayName?.trim() || row.realName?.trim() || row.username?.trim() || row.slackUserId })));
  }
  if (args.sourceKey === "qualifier_schedules") {
    const result = await ctx.db.query("slackQualifierSchedules").withIndex("by_tenantId", (q) => q.eq("tenantId", args.tenantId)).paginate(opts);
    return projectedPage(result, result.page.map((row): ReportSourceRow => ({ kind: "qualifier_schedule", slackUserId: row.slackUserId, weekday: row.weekday, scheduledHours: row.scheduledHours })));
  }
  if (args.sourceKey === "dm_closers") {
    const result = await ctx.db.query("dmClosers").withIndex("by_tenantId_and_teamId", (q) => q.eq("tenantId", args.tenantId)).paginate(opts);
    return projectedPage(result, result.page.map((row): ReportSourceRow => ({ kind: "dm_closer", dmCloserId: row._id, userId: row.userId ?? null, teamId: row.teamId, label: row.displayName, isActive: row.isActive, hourlyRateMinor: row.hourlyRateMinor ?? null })));
  }
  if (args.sourceKey === "dm_closer_schedules") {
    const result = await ctx.db.query("dmCloserSchedules").withIndex("by_tenantId", (q) => q.eq("tenantId", args.tenantId)).paginate(opts);
    return projectedPage(result, result.page.map((row): ReportSourceRow => ({ kind: "dm_closer_schedule", dmCloserId: row.dmCloserId, weekday: row.weekday, scheduledHours: row.scheduledHours })));
  }
  if (args.sourceKey === "users") {
    const result = await ctx.db.query("users").withIndex("by_tenantId", (q) => q.eq("tenantId", args.tenantId)).paginate(opts);
    return projectedPage(result, result.page.map((row): ReportSourceRow => ({ kind: "user", userId: row._id, label: row.fullName ?? row.email, role: row.role, isActive: row.isActive })));
  }
  if (args.sourceKey === "programs") {
    const result = await ctx.db.query("tenantPrograms").withIndex("by_tenantId", (q) => q.eq("tenantId", args.tenantId)).paginate(opts);
    return projectedPage(result, result.page.map((row): ReportSourceRow => ({ kind: "program", programId: row._id, label: row.name })));
  }
  return null;
}

async function readQualificationEvents(ctx: QueryCtx, args: ReportSourcePageRequest) {
  const result = await ctx.db.query("slackQualificationEvents").withIndex("by_tenantId_and_submittedAt", (q) => q.eq("tenantId", args.tenantId).gte("submittedAt", args.startTimestamp).lt("submittedAt", args.endTimestampExclusive)).paginate(pagination(args.cursor));
  return projectedPage(result, result.page.map((row): ReportSourceRow => ({ kind: "qualification_event", eventId: row._id, submittedAt: row.submittedAt, slackUserId: row.slackUserId, slackTeamId: row.slackTeamId, fullNameSnapshot: row.fullNameSnapshot, platform: row.platform, handleSnapshot: row.handleSnapshot, leadId: row.leadId ?? null, opportunityId: row.opportunityId ?? null, resultKind: row.resultKind })));
}

async function readBookedMeetings(ctx: QueryCtx, args: ReportSourcePageRequest) {
  const result = await ctx.db.query("meetings").withIndex("by_tenantId_and_createdAt", (q) => q.eq("tenantId", args.tenantId).gte("createdAt", args.startTimestamp).lt("createdAt", args.endTimestampExclusive)).paginate(pagination(args.cursor, 2));
  const meetings = result.page.filter((row) => row.dmCloserId !== undefined && row.callClassification !== "follow_up");
  const page = await Promise.all(meetings.map(async (meeting): Promise<ReportSourceRow> => {
    const [opportunity, team, dmCloser] = await Promise.all([ctx.db.get(meeting.opportunityId), meeting.attributionTeamId ? ctx.db.get(meeting.attributionTeamId) : Promise.resolve(null), ctx.db.get(meeting.dmCloserId!)]);
    const tenantOpportunity = opportunity?.tenantId === args.tenantId ? opportunity : null;
    const tenantTeam = team?.tenantId === args.tenantId ? team : null;
    const tenantDmCloser = dmCloser?.tenantId === args.tenantId ? dmCloser : null;
    const leadCandidate = tenantOpportunity ? await ctx.db.get(tenantOpportunity.leadId) : null;
    const lead = leadCandidate?.tenantId === args.tenantId ? leadCandidate : null;
    return {
      kind: "booked_meeting", meetingId: meeting._id, opportunityId: meeting.opportunityId,
      leadId: lead?._id ?? tenantOpportunity?.leadId ?? null, bookedAt: meeting.createdAt, scheduledAt: meeting.scheduledAt,
      meetingStatus: meeting.status, opportunityStatus: tenantOpportunity?.status ?? meeting.opportunityStatus ?? null,
      bookingProgramId: meeting.bookingProgramId ?? null, bookingProgramName: meeting.bookingProgramName ?? tenantOpportunity?.firstBookingProgramName ?? null,
      leadLabel: lead ? leadDisplayFromShape({ fullName: lead.fullName, email: lead.email, leadId: lead._id }) : meeting.leadName?.trim() || "Unknown lead",
      leadHandle: lead?.socialHandles?.[0]?.handle ?? lead?.email ?? lead?.phone ?? null,
      initialSource: lead?.initialSource ?? null, selfReportedIncome: lead?.selfReportedIncome ?? null,
      attributionTeamId: meeting.attributionTeamId ?? null, attributionTeamLabel: tenantTeam?.displayName ?? null,
      dmCloserId: meeting.dmCloserId!, dmCloserLabel: tenantDmCloser?.displayName ?? null,
    };
  }));
  return projectedPage(result, page);
}

async function readSalesMeetingStats(ctx: QueryCtx, args: ReportSourcePageRequest) {
  const result = await ctx.db.query("operationsMeetingDailyStats").withIndex("by_tenantId_and_dayKey", (q) => q.eq("tenantId", args.tenantId).gte("dayKey", args.startDayKey).lt("dayKey", args.endDayKeyExclusive)).paginate(pagination(args.cursor));
  return projectedPage(result, result.page.map((row): ReportSourceRow => ({ kind: "sales_meeting_stat", assignedCloserId: row.assignedCloserId, bookingProgramId: row.bookingProgramId ?? null, meetingStatus: row.meetingStatus, count: row.count })));
}

async function readSalesCalls(ctx: QueryCtx, args: ReportSourcePageRequest) {
  const result = await ctx.db.query("meetings").withIndex("by_tenantId_and_scheduledAt", (q) => q.eq("tenantId", args.tenantId).gte("scheduledAt", args.startTimestamp).lt("scheduledAt", args.endTimestampExclusive)).paginate(pagination(args.cursor, 4));
  const page = await Promise.all(result.page.map(async (meeting): Promise<ReportSourceRow> => {
    const opportunity = await ctx.db.get(meeting.opportunityId);
    const tenantOpportunity = opportunity?.tenantId === args.tenantId ? opportunity : null;
    const leadCandidate = tenantOpportunity ? await ctx.db.get(tenantOpportunity.leadId) : null;
    const lead = leadCandidate?.tenantId === args.tenantId ? leadCandidate : null;
    return { kind: "sales_call", meetingId: meeting._id, opportunityId: meeting.opportunityId, assignedCloserId: meeting.assignedCloserId, scheduledAt: meeting.scheduledAt, status: meeting.status, bookingProgramId: meeting.bookingProgramId ?? null, bookingProgramName: meeting.bookingProgramName ?? tenantOpportunity?.firstBookingProgramName ?? null, soldProgramId: meeting.soldProgramId ?? null, soldProgramName: meeting.soldProgramName ?? tenantOpportunity?.soldProgramName ?? null, leadId: lead?._id ?? tenantOpportunity?.leadId ?? null, leadLabel: lead ? leadDisplayFromShape({ fullName: lead.fullName, email: lead.email, leadId: lead._id }) : meeting.leadName?.trim() || "Unknown lead" };
  }));
  return projectedPage(result, page);
}

async function readSalesPayments(ctx: QueryCtx, args: ReportSourcePageRequest) {
  const result = await ctx.db.query("paymentRecords").withIndex("by_tenantId_and_recordedAt", (q) => q.eq("tenantId", args.tenantId).gte("recordedAt", args.startTimestamp).lt("recordedAt", args.endTimestampExclusive)).paginate(pagination(args.cursor));
  const eligible = result.page.filter((payment) => payment.status !== "disputed" && resolveLegacyCompatiblePaymentCommissionable(payment) && resolvePaymentType(payment.paymentType) !== "deposit");
  return projectedPage(result, eligible.map((row): ReportSourceRow => ({ kind: "sales_payment", paymentId: row._id, recordedAt: row.recordedAt, opportunityId: row.opportunityId ?? row.originatingOpportunityId ?? null, amountMinor: row.amountMinor, currency: row.currency, paymentType: resolvePaymentType(row.paymentType), programId: row.programId, programName: row.programName, effectiveCloserId: resolveLegacyCompatibleAttributedCloserId(row) ?? null })));
}

export async function readSourcePage(ctx: QueryCtx, args: ReportSourcePageRequest): Promise<ReportSourcePage> {
  assertSource(args.reportKind, args.sourceKey);
  const registry = await readRegistry(ctx, args);
  if (registry) return registry;
  switch (args.sourceKey) {
    case "tenant": {
      const tenant = await ctx.db.get(args.tenantId);
      return syntheticPage(tenant ? [{ kind: "tenant", slackQualificationDailyTeamQuota: tenant.slackQualificationDailyTeamQuota ?? null }] : [], args.cursor);
    }
    case "lead_gen_daily": return await readLeadGenDaily(ctx, args);
    case "lead_gen_origins": return await readLeadGenOrigins(ctx, args, false);
    case "lead_gen_team_origins": return await readLeadGenOrigins(ctx, args, true);
    case "lead_gen_submissions": return await readLeadGenSubmissions(ctx, args);
    case "lead_gen_filtered_origin_submissions": return await readLeadGenSubmissions(ctx, args);
    case "qualification_events": return await readQualificationEvents(ctx, args);
    case "booked_meetings": return await readBookedMeetings(ctx, args);
    case "sales_meeting_stats": return await readSalesMeetingStats(ctx, args);
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
