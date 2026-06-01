import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { slackQualificationsByUser } from "../reporting/aggregates";
import {
  listQualificationEventsForRange,
  loadOpportunityMapForQualificationEvents,
  summarizeQualificationEvents,
} from "../reporting/lib/slackQualificationLedger";
import { buildWorkerPerformanceRows } from "../leadGen/reportBuilders";
import { TOP_DM_CLOSER_BOOKING_LIMIT } from "../leadGen/reportLimits";
import {
  loadLeadGenTeamsForRows,
  readLeadGenDailyRowsForDashboard,
} from "../leadGen/reportReaders";
import { loadCurrentScheduledHoursByWorkerDay } from "../leadGen/schedules";
import {
  loadDmCloserScheduledHoursForRange,
  loadLeadGenScheduledHoursForRange,
  loadSlackQualifierScheduledHoursForRange,
} from "../workSchedules/rangeHours";
import { compareNullableEfficiency } from "./efficiencySort";
import type { DerivedOverviewRange } from "./overviewRange";
import type {
  ExpandedOverviewLeaderboard,
  LeadGenOverview,
  LeaderboardFilters,
  OverviewLeaderboardKind,
  TopDmCloserRow,
  TopQualifierRow,
} from "./overviewTypes";

const SLACK_USER_REGISTRY_LIMIT = 300;
const DM_CLOSER_REGISTRY_LIMIT = 300;
const LEAD_GEN_WORKER_REGISTRY_LIMIT = 250;

async function countSlackQualifiedForUser(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    slackUserId: string;
    start: number;
    end: number;
  },
) {
  return await slackQualificationsByUser.count(ctx, {
    namespace: args.tenantId,
    bounds: {
      lower: { key: [args.slackUserId, args.start], inclusive: true },
      upper: { key: [args.slackUserId, args.end], inclusive: false },
    },
  });
}

async function loadLeadGenWorkerSchedulesForTenant(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
) {
  const workers = await ctx.db
    .query("leadGenWorkers")
    .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
    .take(LEAD_GEN_WORKER_REGISTRY_LIMIT);

  const schedules: Doc<"leadGenWorkerSchedules">[] = [];
  for (const worker of workers) {
    const rows = await ctx.db
      .query("leadGenWorkerSchedules")
      .withIndex("by_tenantId_and_workerId", (q) =>
        q.eq("tenantId", tenantId).eq("workerId", worker._id),
      )
      .take(7);
    schedules.push(...rows);
  }

  return { workers, schedules };
}

function countBookedSlackOpportunities(
  userEvents: Array<{ opportunityId?: Id<"opportunities"> }>,
  opportunityById: ReadonlyMap<
    Id<"opportunities">,
    Pick<Doc<"opportunities">, "_id" | "source" | "latestMeetingId">
  >,
) {
  const opportunityIds = [
    ...new Set(
      userEvents
        .map((event) => event.opportunityId)
        .filter((id): id is Id<"opportunities"> => id !== undefined),
    ),
  ];

  return opportunityIds.filter((opportunityId) => {
    const opportunity = opportunityById.get(opportunityId);
    return (
      opportunity &&
      opportunity.source === "slack_qualified" &&
      opportunity.latestMeetingId !== undefined
    );
  }).length;
}

function countBookedMeetingsByDmCloser(
  meetings: Doc<"meetings">[],
) {
  const byDmCloser = new Map<Id<"dmClosers">, number>();
  for (const meeting of meetings) {
    if (!meeting.dmCloserId) continue;
    if (meeting.callClassification === "follow_up") continue;
    byDmCloser.set(
      meeting.dmCloserId,
      (byDmCloser.get(meeting.dmCloserId) ?? 0) + 1,
    );
  }
  return byDmCloser;
}

export async function buildLeadGenEfficiencyRows(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    range: DerivedOverviewRange;
    includeAllCandidates: boolean;
  },
): Promise<LeadGenOverview["topWorkers"]> {
  const rows = await readLeadGenDailyRowsForDashboard(ctx, {
    tenantId: args.tenantId,
    startDayKey: args.range.startBusinessDate,
    endDayKey: args.range.endBusinessDateInclusive,
  });
  const currentScheduledHoursByWorkerDay =
    await loadCurrentScheduledHoursByWorkerDay(ctx, {
      tenantId: args.tenantId,
      rows,
    });
  const { workers: tenantWorkers, schedules: leadGenSchedules } =
    await loadLeadGenWorkerSchedulesForTenant(ctx, args.tenantId);

  const candidateWorkerIds = new Set<Id<"leadGenWorkers">>();
  for (const row of rows) candidateWorkerIds.add(row.workerId);
  for (const schedule of leadGenSchedules) {
    candidateWorkerIds.add(schedule.workerId);
  }
  if (args.includeAllCandidates) {
    for (const worker of tenantWorkers) candidateWorkerIds.add(worker._id);
  }

  const workerDocs = new Map<Id<"leadGenWorkers">, Doc<"leadGenWorkers">>();
  for (const worker of tenantWorkers) {
    workerDocs.set(worker._id, worker);
  }
  for (const workerId of candidateWorkerIds) {
    if (workerDocs.has(workerId)) continue;
    const worker = await ctx.db.get(workerId);
    if (worker && worker.tenantId === args.tenantId) {
      workerDocs.set(worker._id, worker);
    }
  }

  const workers = workerDocs;
  const teams = await loadLeadGenTeamsForRows(ctx, args.tenantId, rows);
  const performanceByWorker = new Map(
    buildWorkerPerformanceRows({
      rows,
      currentScheduledHoursByWorkerDay,
      workers,
      teams,
    }).map((worker) => [worker.workerId, worker]),
  );

  const scheduledHoursByWorker = await loadLeadGenScheduledHoursForRange(ctx, {
    tenantId: args.tenantId,
    workerIds: [...candidateWorkerIds],
    startBusinessDate: args.range.startBusinessDate,
    endBusinessDateInclusive: args.range.endBusinessDateInclusive,
  });

  const result: LeadGenOverview["topWorkers"] = [];
  for (const workerId of candidateWorkerIds) {
    const performance = performanceByWorker.get(workerId);
    const worker = workers.get(workerId);
    const scheduledHours = scheduledHoursByWorker.get(workerId) ?? 0;
    const submissions = performance?.submissions ?? 0;

    result.push({
      workerId,
      displayName:
        performance?.displayName ??
        worker?.displayName ??
        worker?.email ??
        "Unknown worker",
      submissions,
      scheduledHours,
      leadsPerHour:
        scheduledHours > 0 ? submissions / scheduledHours : null,
    });
  }

  return result.sort((left, right) =>
    compareNullableEfficiency({
      leftRate: left.leadsPerHour,
      rightRate: right.leadsPerHour,
      leftCount: left.submissions,
      rightCount: right.submissions,
      leftName: left.displayName,
      rightName: right.displayName,
    }),
  );
}

export async function buildQualifierEfficiencyRows(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    range: DerivedOverviewRange;
    includeAllCandidates: boolean;
  },
): Promise<{ rows: TopQualifierRow[]; truncated: boolean }> {
  const [slackUsers, qualifierSchedules, events] = await Promise.all([
    ctx.db
      .query("slackUsers")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", args.tenantId))
      .take(SLACK_USER_REGISTRY_LIMIT),
    ctx.db
      .query("slackQualifierSchedules")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", args.tenantId))
      .take(2_100),
    listQualificationEventsForRange(ctx, {
      tenantId: args.tenantId,
      start: args.range.slackWindowStart,
      end: args.range.slackWindowEnd,
    }),
  ]);

  const candidateSlackUserIds = new Set<string>();
  const scheduledSlackUserIds = new Set<string>();
  for (const schedule of qualifierSchedules) {
    candidateSlackUserIds.add(schedule.slackUserId);
    scheduledSlackUserIds.add(schedule.slackUserId);
  }
  for (const event of events.rows) {
    candidateSlackUserIds.add(event.slackUserId);
  }
  if (args.includeAllCandidates || events.truncated) {
    for (const user of slackUsers) {
      candidateSlackUserIds.add(user.slackUserId);
    }
  }

  const slackUserById = new Map(
    slackUsers.map((user) => [user.slackUserId, user]),
  );
  const opportunityById = await loadOpportunityMapForQualificationEvents(
    ctx,
    events.rows,
  );
  const eventsBySlackUserId = new Map<string, typeof events.rows>();
  for (const event of events.rows) {
    const current = eventsBySlackUserId.get(event.slackUserId) ?? [];
    current.push(event);
    eventsBySlackUserId.set(event.slackUserId, current);
  }

  const scheduledHoursBySlackUserId =
    await loadSlackQualifierScheduledHoursForRange(ctx, {
      tenantId: args.tenantId,
      slackUserIds: [...candidateSlackUserIds],
      startBusinessDate: args.range.startBusinessDate,
      endBusinessDateInclusive: args.range.endBusinessDateInclusive,
    });

  const rows: TopQualifierRow[] = [];
  for (const slackUserId of candidateSlackUserIds) {
    const user = slackUserById.get(slackUserId);
    const userEvents = eventsBySlackUserId.get(slackUserId) ?? [];
    const summary = summarizeQualificationEvents(userEvents, opportunityById);
    const uniqueOpportunityCount = await countSlackQualifiedForUser(ctx, {
      tenantId: args.tenantId,
      slackUserId,
      start: args.range.slackWindowStart,
      end: args.range.slackWindowEnd,
    });
    const scheduledHours = scheduledHoursBySlackUserId.get(slackUserId) ?? 0;
    const booked = countBookedSlackOpportunities(userEvents, opportunityById);

    if (
      !args.includeAllCandidates &&
      !scheduledSlackUserIds.has(slackUserId) &&
      userEvents.length === 0 &&
      uniqueOpportunityCount === 0
    ) {
      continue;
    }

    rows.push({
      slackUserId,
      displayName:
        user?.displayName ?? user?.realName ?? user?.username ?? null,
      avatarUrl: user?.avatarUrl ?? null,
      isDeleted: user?.isDeleted ?? false,
      total: summary.qualificationEventCount,
      uniqueOpportunityCount,
      booked,
      ratio:
        uniqueOpportunityCount > 0 ? booked / uniqueOpportunityCount : null,
      scheduledHours,
      qualifiedPerHour:
        scheduledHours > 0 ? uniqueOpportunityCount / scheduledHours : null,
    });
  }

  rows.sort((left, right) =>
    compareNullableEfficiency({
      leftRate: left.qualifiedPerHour,
      rightRate: right.qualifiedPerHour,
      leftCount: left.uniqueOpportunityCount,
      rightCount: right.uniqueOpportunityCount,
      leftName: left.displayName ?? left.slackUserId,
      rightName: right.displayName ?? right.slackUserId,
    }),
  );

  return { rows, truncated: events.truncated };
}

export async function buildDmCloserEfficiencyRows(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    range: DerivedOverviewRange;
    includeAllCandidates: boolean;
  },
): Promise<{ rows: TopDmCloserRow[]; truncated: boolean }> {
  const meetings = await ctx.db
    .query("meetings")
    .withIndex("by_tenantId_and_createdAt", (q) =>
      q
        .eq("tenantId", args.tenantId)
        .gte("createdAt", args.range.slackWindowStart)
        .lt("createdAt", args.range.slackWindowEnd),
    )
    .take(TOP_DM_CLOSER_BOOKING_LIMIT + 1);

  const truncated = meetings.length > TOP_DM_CLOSER_BOOKING_LIMIT;
  if (truncated) {
    throw new Error(
      "DM closer booking range is too large. Narrow the date range.",
    );
  }

  const byDmCloser = countBookedMeetingsByDmCloser(meetings);

  const [dmClosers, dmCloserSchedules] = await Promise.all([
    ctx.db
      .query("dmClosers")
      .withIndex("by_tenantId_and_teamId", (q) =>
        q.eq("tenantId", args.tenantId),
      )
      .take(DM_CLOSER_REGISTRY_LIMIT),
    ctx.db
      .query("dmCloserSchedules")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", args.tenantId))
      .take(2_100),
  ]);

  const candidateDmCloserIds = new Set<Id<"dmClosers">>();
  for (const dmCloserId of byDmCloser.keys()) {
    candidateDmCloserIds.add(dmCloserId);
  }
  for (const schedule of dmCloserSchedules) {
    candidateDmCloserIds.add(schedule.dmCloserId);
  }
  if (args.includeAllCandidates) {
    for (const closer of dmClosers) candidateDmCloserIds.add(closer._id);
  }

  const dmCloserById = new Map(dmClosers.map((closer) => [closer._id, closer]));
  const scheduledHoursByDmCloser = await loadDmCloserScheduledHoursForRange(
    ctx,
    {
      tenantId: args.tenantId,
      dmCloserIds: [...candidateDmCloserIds],
      startBusinessDate: args.range.startBusinessDate,
      endBusinessDateInclusive: args.range.endBusinessDateInclusive,
    },
  );

  const rows: TopDmCloserRow[] = [];
  for (const dmCloserId of candidateDmCloserIds) {
    const closer =
      dmCloserById.get(dmCloserId) ?? (await ctx.db.get(dmCloserId));
    if (!closer || closer.tenantId !== args.tenantId) continue;

    const team = await ctx.db.get(closer.teamId);
    const booked = byDmCloser.get(dmCloserId) ?? 0;
    const scheduledHours = scheduledHoursByDmCloser.get(dmCloserId) ?? 0;

    rows.push({
      dmCloserId,
      displayName: closer.displayName,
      teamName: team && team.tenantId === args.tenantId ? team.displayName : null,
      booked,
      scheduledHours,
      bookedPerHour: scheduledHours > 0 ? booked / scheduledHours : null,
    });
  }

  rows.sort((left, right) =>
    compareNullableEfficiency({
      leftRate: left.bookedPerHour,
      rightRate: right.bookedPerHour,
      leftCount: left.booked,
      rightCount: right.booked,
      leftName: left.displayName,
      rightName: right.displayName,
    }),
  );

  return { rows, truncated: false };
}

function normalizeSearchQuery(search: string) {
  return search.trim().toLowerCase();
}

function applyScheduleFilter<T extends { scheduledHours: number }>(
  rows: T[],
  schedule: LeaderboardFilters["schedule"] | undefined,
) {
  if (!schedule || schedule === "all") return rows;
  if (schedule === "scheduled") {
    return rows.filter((row) => row.scheduledHours > 0);
  }
  return rows.filter((row) => row.scheduledHours === 0);
}

function applyActivityFilterForLeadGen(
  rows: LeadGenOverview["topWorkers"],
  activity: LeaderboardFilters["activity"] | undefined,
) {
  if (!activity || activity === "all") return rows;
  if (activity === "with_activity") {
    return rows.filter((row) => row.submissions > 0);
  }
  return rows.filter((row) => row.submissions === 0);
}

function applyActivityFilterForQualifiers(
  rows: TopQualifierRow[],
  activity: LeaderboardFilters["activity"] | undefined,
) {
  if (!activity || activity === "all") return rows;
  if (activity === "with_activity") {
    return rows.filter((row) => row.uniqueOpportunityCount > 0);
  }
  return rows.filter((row) => row.uniqueOpportunityCount === 0);
}

function applyActivityFilterForDmClosers(
  rows: TopDmCloserRow[],
  activity: LeaderboardFilters["activity"] | undefined,
) {
  if (!activity || activity === "all") return rows;
  if (activity === "with_activity") {
    return rows.filter((row) => row.booked > 0);
  }
  return rows.filter((row) => row.booked === 0);
}

function matchesSearchHaystack(haystack: string, needle: string) {
  return haystack.toLowerCase().includes(needle);
}

async function applySearchFilterForLeadGen(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  rows: LeadGenOverview["topWorkers"],
  search: string,
) {
  const needle = normalizeSearchQuery(search);
  if (!needle) return rows;

  const emailByWorkerId = new Map<Id<"leadGenWorkers">, string | null>();
  for (const row of rows) {
    if (emailByWorkerId.has(row.workerId)) continue;
    const worker = await ctx.db.get(row.workerId);
    emailByWorkerId.set(
      row.workerId,
      worker && worker.tenantId === tenantId ? (worker.email ?? null) : null,
    );
  }

  return rows.filter((row) => {
    const email = emailByWorkerId.get(row.workerId);
    const haystack = [row.displayName, email, row.workerId]
      .filter((value): value is string => Boolean(value))
      .join(" ");
    return matchesSearchHaystack(haystack, needle);
  });
}

function applySearchFilterForQualifiers(rows: TopQualifierRow[], search: string) {
  const needle = normalizeSearchQuery(search);
  if (!needle) return rows;

  return rows.filter((row) => {
    const haystack = [row.displayName, row.slackUserId]
      .filter((value): value is string => Boolean(value))
      .join(" ");
    return matchesSearchHaystack(haystack, needle);
  });
}

function applySearchFilterForDmClosers(rows: TopDmCloserRow[], search: string) {
  const needle = normalizeSearchQuery(search);
  if (!needle) return rows;

  return rows.filter((row) => {
    const haystack = [row.displayName, row.teamName, row.dmCloserId]
      .filter((value): value is string => Boolean(value))
      .join(" ");
    return matchesSearchHaystack(haystack, needle);
  });
}

async function applyLeaderboardFilters(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  kind: OverviewLeaderboardKind,
  rows: LeadGenOverview["topWorkers"] | TopQualifierRow[] | TopDmCloserRow[],
  filters?: LeaderboardFilters,
) {
  const filtered = rows;

  if (kind === "lead_gen") {
    let leadGenRows = filtered as LeadGenOverview["topWorkers"];
    if (filters?.search) {
      leadGenRows = await applySearchFilterForLeadGen(
        ctx,
        tenantId,
        leadGenRows,
        filters.search,
      );
    }
    leadGenRows = applyScheduleFilter(leadGenRows, filters?.schedule);
    leadGenRows = applyActivityFilterForLeadGen(leadGenRows, filters?.activity);
    return leadGenRows;
  }

  if (kind === "qualifiers") {
    let qualifierRows = filtered as TopQualifierRow[];
    if (filters?.search) {
      qualifierRows = applySearchFilterForQualifiers(
        qualifierRows,
        filters.search,
      );
    }
    qualifierRows = applyScheduleFilter(qualifierRows, filters?.schedule);
    qualifierRows = applyActivityFilterForQualifiers(
      qualifierRows,
      filters?.activity,
    );
    return qualifierRows;
  }

  let dmCloserRows = filtered as TopDmCloserRow[];
  if (filters?.search) {
    dmCloserRows = applySearchFilterForDmClosers(dmCloserRows, filters.search);
  }
  dmCloserRows = applyScheduleFilter(dmCloserRows, filters?.schedule);
  dmCloserRows = applyActivityFilterForDmClosers(dmCloserRows, filters?.activity);
  return dmCloserRows;
}

export async function buildExpandedOverviewLeaderboard(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    kind: OverviewLeaderboardKind;
    range: DerivedOverviewRange;
    filters?: LeaderboardFilters;
  },
): Promise<ExpandedOverviewLeaderboard> {
  switch (args.kind) {
    case "lead_gen": {
      const allRows = await buildLeadGenEfficiencyRows(ctx, {
        tenantId: args.tenantId,
        range: args.range,
        includeAllCandidates: true,
      });
      const rows = (await applyLeaderboardFilters(
        ctx,
        args.tenantId,
        "lead_gen",
        allRows,
        args.filters,
      )) as LeadGenOverview["topWorkers"];
      return {
        kind: "lead_gen",
        rows,
        totalRows: allRows.length,
        filteredRows: rows.length,
        truncated: false,
        cappedMessage: null,
      };
    }
    case "qualifiers": {
      const { rows: allRows, truncated } = await buildQualifierEfficiencyRows(
        ctx,
        {
          tenantId: args.tenantId,
          range: args.range,
          includeAllCandidates: true,
        },
      );
      const rows = (await applyLeaderboardFilters(
        ctx,
        args.tenantId,
        "qualifiers",
        allRows,
        args.filters,
      )) as TopQualifierRow[];
      return {
        kind: "qualifiers",
        rows,
        totalRows: allRows.length,
        filteredRows: rows.length,
        truncated,
        cappedMessage: null,
      };
    }
    case "dm_closers": {
      let allRows: TopDmCloserRow[];
      let truncated: boolean;
      try {
        const result = await buildDmCloserEfficiencyRows(ctx, {
          tenantId: args.tenantId,
          range: args.range,
          includeAllCandidates: true,
        });
        allRows = result.rows;
        truncated = result.truncated;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown leaderboard error";
        if (/too large|cannot exceed|narrow/i.test(message)) {
          return {
            kind: "dm_closers",
            rows: [],
            totalRows: 0,
            filteredRows: 0,
            truncated: true,
            cappedMessage: message,
          };
        }
        throw error;
      }
      const rows = (await applyLeaderboardFilters(
        ctx,
        args.tenantId,
        "dm_closers",
        allRows,
        args.filters,
      )) as TopDmCloserRow[];
      return {
        kind: "dm_closers",
        rows,
        totalRows: allRows.length,
        filteredRows: rows.length,
        truncated,
        cappedMessage: null,
      };
    }
  }
}
