import type { ReaderArgs } from "../analytics/assistantTypes";
import { getTenantBusinessDay } from "../lib/tenantBusinessDay";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { log } from "../lib/observability/log";
import {
  assertCoreRole,
  provenanceMetadata,
  WEB,
  type CoreActor,
  type Provenance,
} from "../lib/outcomeCores";
import {
  slackQualificationsByTime,
  slackQualificationsByUser,
} from "./aggregates";
import type { BusinessDaySetting } from "../../lib/businessDay";
import {
  addBusinessDays,
  buildBusinessPeriods,
  businessDateToUtcStart,
  countBusinessDays,
  reportGranularityValidator,
  type BusinessPeriod,
  type ReportGranularity,
} from "./lib/hondurasBusinessTime";
import {
  listQualificationEventsForRange,
  loadOpportunityMapForQualificationEvents,
  summarizeQualificationEvents,
  type QualificationEventSummary,
} from "./lib/slackQualificationLedger";
import {
  slackMemberIdentity,
  type MemberAvatarIdentity,
} from "../lib/memberIdentity";
import {
  loadQualifiedGoalGroup,
  qualifiedGoalDayCount,
} from "../workSchedules/goalDays";

const MAX_SLACK_SETTERS = 500;
const MAX_DAILY_TEAM_GOAL = 5000;

type SlackSetter = Doc<"slackUsers">;

type PeriodReportRow = BusinessPeriod & {
  qualifiedCount: number;
  qualificationEventCount: number;
  uniqueSlackOpportunityCount: number;
  expectedTeamCount: number | null;
  teamGoalAttainment: number | null;
};

type SetterContributionRow = {
  slackUserId: string;
  slackTeamId: string;
  displayName: string;
  avatarUrl: string | null;
  setter: MemberAvatarIdentity;
  isDeleted: boolean;
  totalQualified: number;
  qualificationEventCount: number;
  uniqueSlackOpportunityCount: number;
  createdOpportunityEvents: number;
  duplicatePendingEvents: number;
  alreadyBookedEvents: number;
  unlinkedEvents: number;
  contributionShare: number | null;
  lastQualifiedAt: number | null;
};

export type QualificationReportArgs = {
  startBusinessDate: string;
  endBusinessDateExclusive: string;
  granularity: ReportGranularity;
  slackUserId?: string;
};

export type SetterQualificationSummary = QualificationEventSummary & {
  lastQualifiedAt: number;
};

/**
 * The range's qualification events, summarized for the report: in total, by
 * period (keyed by the period's start), and by setter.
 */
export type QualificationReportCounts = {
  summary: QualificationEventSummary;
  byPeriodStart: Map<number, QualificationEventSummary>;
  bySlackUserId: Map<string, SetterQualificationSummary>;
  eventsTruncated: boolean;
  legacyOpportunityAggregateCount: number;
};

function qualificationReportRange(args: QualificationReportArgs, setting: BusinessDaySetting) {
  return {
    periods: buildBusinessPeriods({
      startBusinessDate: args.startBusinessDate,
      endBusinessDateExclusive: args.endBusinessDateExclusive,
      granularity: args.granularity,
      setting,
    }),
    rangeStart: businessDateToUtcStart(args.startBusinessDate, setting),
    rangeEnd: businessDateToUtcStart(args.endBusinessDateExclusive, setting),
  };
}

/** The report's periods, for the ClickHouse report to group by. */
export function qualificationReportPeriods(args: QualificationReportArgs, setting: BusinessDaySetting) {
  return qualificationReportRange(args, setting).periods;
}

export const getQualificationReport = query({
  args: {
    startBusinessDate: v.string(),
    endBusinessDateExclusive: v.string(),
    granularity: reportGranularityValidator,
    slackUserId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const selectedSlackUserId = args.slackUserId?.trim() || undefined;
    const setting = await getTenantBusinessDay(ctx, tenantId);
    const { periods, rangeStart, rangeEnd } = qualificationReportRange(args, setting);

    const eventResult = await listQualificationEventsForRange(ctx, {
      tenantId,
      start: rangeStart,
      end: rangeEnd,
      slackUserId: selectedSlackUserId,
    });
    const opportunityById = await loadOpportunityMapForQualificationEvents(
      ctx,
      eventResult.rows,
    );
    const legacyOpportunityAggregateCount =
      await countLegacyOpportunityAggregate(ctx, {
        tenantId,
        start: rangeStart,
        end: rangeEnd,
        slackUserId: selectedSlackUserId,
      });

    return await buildQualificationReport(ctx, tenantId, args, setting, {
      summary: summarizeQualificationEvents(eventResult.rows, opportunityById),
      byPeriodStart: new Map(
        periods.map((period) => [
          period.start,
          summarizeQualificationEvents(
            eventResult.rows.filter(
              (event) =>
                event.submittedAt >= period.start && event.submittedAt < period.end,
            ),
            opportunityById,
          ),
        ]),
      ),
      bySlackUserId: summarizeBySetter(eventResult.rows, opportunityById),
      eventsTruncated: eventResult.truncated,
      legacyOpportunityAggregateCount,
    });
  },
});

function summarizeBySetter(
  qualificationEvents: Doc<"slackQualificationEvents">[],
  opportunityById: Map<Id<"opportunities">, Doc<"opportunities">>,
): Map<string, SetterQualificationSummary> {
  const eventsBySlackUserId = new Map<string, Doc<"slackQualificationEvents">[]>();
  for (const event of qualificationEvents) {
    const existing = eventsBySlackUserId.get(event.slackUserId) ?? [];
    existing.push(event);
    eventsBySlackUserId.set(event.slackUserId, existing);
  }
  return new Map(
    [...eventsBySlackUserId].map(([slackUserId, events]) => [
      slackUserId,
      {
        ...summarizeQualificationEvents(events, opportunityById),
        lastQualifiedAt: Math.max(...events.map((event) => event.submittedAt)),
      },
    ]),
  );
}

/**
 * The Slack Qualifications report from the range's summarized events. Shared
 * by the Convex reader and the ClickHouse report
 * (convex/analytics/definitions/slackQualifications.ts).
 */
/**
 * `setting` is the business day the counts were grouped by, so the periods'
 * keys match them even if the tenant changed its setting since.
 */
export async function buildQualificationReport(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  args: QualificationReportArgs,
  setting: BusinessDaySetting,
  counts: QualificationReportCounts,
) {
  const tenant = await ctx.db.get("tenants", tenantId);
  if (!tenant) {
    throw new Error("Tenant not found.");
  }

  const selectedSlackUserId = args.slackUserId?.trim() || undefined;
  const { periods } = qualificationReportRange(args, setting);
  const businessDayCount = countBusinessDays(
    args.startBusinessDate,
    args.endBusinessDateExclusive,
  );
  const teamDailyGoal = tenant.slackQualificationDailyTeamQuota ?? null;

  const setterResult = await listTenantSlackSetters(ctx, tenantId);
  const selectedSetter = selectedSlackUserId
    ? setterResult.setters.find(
        (setter) => setter.slackUserId === selectedSlackUserId,
      )
    : null;

  if (selectedSlackUserId && !selectedSetter) {
    throw new Error("Slack setter not found.");
  }

  const visibleSetters = selectedSlackUserId
    ? selectedSetter
      ? [selectedSetter]
      : []
    : setterResult.setters;
  const isTeamView = selectedSlackUserId === undefined;

  // A period's goalDays are the days in it some qualifier works.
  const goalPeriods = await withGoalDays(ctx, tenantId, args, setting, periods);
  const periodCounts = countPeriods({
    periods: goalPeriods,
    teamDailyGoal,
    byPeriodStart: counts.byPeriodStart,
  });
  const userCounts = countUsersForRange({
    setters: visibleSetters,
    bySlackUserId: counts.bySlackUserId,
    visibleTotal: counts.summary.qualificationEventCount,
    includeContributionShare: isTeamView,
  });

  return {
    timezone: setting.timeZone,
    businessDayStartsAtHour: setting.dayStartHour,
    startBusinessDate: args.startBusinessDate,
    endBusinessDateExclusive: args.endBusinessDateExclusive,
    granularity: args.granularity,
    setting,
    selectedSlackUserId: selectedSlackUserId ?? null,
    teamGoal: {
      dailyTeamQualificationGoal: teamDailyGoal,
    },
    setters: setterResult.setters.map(toSetterOption),
    settersTruncated: setterResult.truncated,
    periods: periodCounts,
    users: userCounts,
    totals: summarizeReport({
      periodCounts,
      userCounts,
      businessDayCount,
      teamDailyGoal,
      isTeamView,
      eventSummary: counts.summary,
      eventsTruncated: counts.eventsTruncated,
      legacyOpportunityAggregateCount: counts.legacyOpportunityAggregateCount,
    }),
  };
}

export type SetTeamDailyGoalArgs = { dailyTeamQualificationGoal: number | null };

/**
 * Sets or clears the team's daily qualified-leads goal: the core of
 * `setTeamDailyGoal`. No event covers a goal; the change is logged with its
 * provenance.
 */
export async function setTeamDailyGoalCore(
  ctx: MutationCtx,
  actor: CoreActor,
  args: SetTeamDailyGoalArgs,
  provenance: Provenance,
): Promise<{ dailyTeamQualificationGoal: number | null }> {
  assertCoreRole(actor, ["tenant_master", "tenant_admin"]);
  const { tenantId } = actor;

  if (
    args.dailyTeamQualificationGoal !== null &&
    (!Number.isInteger(args.dailyTeamQualificationGoal) ||
      args.dailyTeamQualificationGoal < 0 ||
      args.dailyTeamQualificationGoal > MAX_DAILY_TEAM_GOAL)
  ) {
    throw new Error(
      `Daily team goal must be an integer between 0 and ${MAX_DAILY_TEAM_GOAL}.`,
    );
  }

  await ctx.db.patch("tenants", tenantId, {
    slackQualificationDailyTeamQuota:
      args.dailyTeamQualificationGoal ?? undefined,
  });
  log.info("reporting.team_daily_goal.set", {
    tenantId,
    actorUserId: actor.userId,
    dailyTeamQualificationGoal: args.dailyTeamQualificationGoal,
    via: provenance.via,
    ...provenanceMetadata(provenance),
  });

  return {
    dailyTeamQualificationGoal: args.dailyTeamQualificationGoal,
  };
}

export const setTeamDailyGoal = mutation({
  args: {
    dailyTeamQualificationGoal: v.union(v.number(), v.null()),
  },
  handler: async (ctx, args) => {
    const actor = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    return await setTeamDailyGoalCore(ctx, actor, args, WEB);
  },
});

/**
 * The periods with `goalDays` counted as the qualified-leads goal counts them:
 * the days some Slack qualifier works (qualifiedGoalDayCount). Every day
 * counts when the group is too large to read.
 */
async function withGoalDays(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  args: QualificationReportArgs,
  setting: BusinessDaySetting,
  periods: BusinessPeriod[],
): Promise<BusinessPeriod[]> {
  const group = await loadQualifiedGoalGroup(ctx, tenantId);
  if (!group) return periods;
  const daysByPeriodStart = new Map<number, string[]>();
  for (let day = args.startBusinessDate; day < args.endBusinessDateExclusive; day = addBusinessDays(day, 1)) {
    const start = businessDateToUtcStart(day, setting);
    const period = periods.find((candidate) => start >= candidate.start && start < candidate.end);
    if (!period) continue;
    const days = daysByPeriodStart.get(period.start) ?? [];
    days.push(day);
    daysByPeriodStart.set(period.start, days);
  }
  return periods.map((period) => ({
    ...period,
    goalDays: qualifiedGoalDayCount(
      group.slackUsers,
      group.scheduleRowsBySlackUserId,
      daysByPeriodStart.get(period.start) ?? [],
    ),
  }));
}

const EMPTY_SUMMARY: QualificationEventSummary = {
  qualificationEventCount: 0,
  uniqueLinkedOpportunityCount: 0,
  uniqueSlackOpportunityCount: 0,
  createdOpportunityEvents: 0,
  duplicatePendingEvents: 0,
  alreadyBookedEvents: 0,
  unlinkedEvents: 0,
};

function countPeriods(args: {
  periods: BusinessPeriod[];
  teamDailyGoal: number | null;
  byPeriodStart: Map<number, QualificationEventSummary>;
}): PeriodReportRow[] {
  if (args.periods.length === 0) {
    return [];
  }

  return args.periods.map((period) => {
    const summary = args.byPeriodStart.get(period.start) ?? EMPTY_SUMMARY;
    const qualifiedCount = summary.qualificationEventCount;
    const expectedTeamCount =
      args.teamDailyGoal === null ? null : args.teamDailyGoal * period.goalDays;
    return {
      ...period,
      qualifiedCount,
      qualificationEventCount: qualifiedCount,
      uniqueSlackOpportunityCount: summary.uniqueSlackOpportunityCount,
      expectedTeamCount,
      teamGoalAttainment:
        expectedTeamCount !== null && expectedTeamCount > 0
          ? qualifiedCount / expectedTeamCount
          : null,
    };
  });
}

function countUsersForRange(args: {
  setters: SlackSetter[];
  bySlackUserId: Map<string, SetterQualificationSummary>;
  visibleTotal: number;
  includeContributionShare: boolean;
}): SetterContributionRow[] {
  if (args.setters.length === 0) {
    return [];
  }

  const visibleTotal = args.visibleTotal;

  return args.setters
    .map((setter) => {
      const setterSummary = args.bySlackUserId.get(setter.slackUserId);
      const summary = setterSummary ?? EMPTY_SUMMARY;
      return {
        slackUserId: setter.slackUserId,
        slackTeamId: setter.slackTeamId,
        displayName: getSlackDisplayName(setter),
        avatarUrl: setter.avatarUrl ?? null,
        setter: slackMemberIdentity(setter, `slack:${setter.slackUserId}`),
        isDeleted: setter.isDeleted,
        totalQualified: summary.qualificationEventCount,
        qualificationEventCount: summary.qualificationEventCount,
        uniqueSlackOpportunityCount: summary.uniqueSlackOpportunityCount,
        createdOpportunityEvents: summary.createdOpportunityEvents,
        duplicatePendingEvents: summary.duplicatePendingEvents,
        alreadyBookedEvents: summary.alreadyBookedEvents,
        unlinkedEvents: summary.unlinkedEvents,
        contributionShare:
          args.includeContributionShare && visibleTotal > 0
            ? summary.qualificationEventCount / visibleTotal
            : null,
        lastQualifiedAt: setterSummary?.lastQualifiedAt ?? null,
      };
    })
    .sort((left, right) => {
      const byTotal = right.totalQualified - left.totalQualified;
      if (byTotal !== 0) {
        return byTotal;
      }
      return left.displayName.localeCompare(right.displayName, undefined, {
        sensitivity: "base",
      });
    });
}

async function countLegacyOpportunityAggregate(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    start: number;
    end: number;
    slackUserId?: string;
  },
): Promise<number> {
  if (args.slackUserId) {
    return await slackQualificationsByUser.count(ctx, {
      namespace: args.tenantId,
      bounds: {
        lower: {
          key: [args.slackUserId, args.start] as [string, number],
          inclusive: true,
        },
        upper: {
          key: [args.slackUserId, args.end] as [string, number],
          inclusive: false,
        },
      },
    });
  }

  return await slackQualificationsByTime.count(ctx, {
    namespace: args.tenantId,
    bounds: {
      lower: { key: args.start, inclusive: true },
      upper: { key: args.end, inclusive: false },
    },
  });
}

async function listTenantSlackSetters(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
): Promise<{ setters: SlackSetter[]; truncated: boolean }> {
  const rows = await ctx.db
    .query("slackUsers")
    .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
    .take(MAX_SLACK_SETTERS + 1);

  const setters = rows
    .slice(0, MAX_SLACK_SETTERS)
    .filter((row) => !row.isBot)
    .sort((left, right) =>
      getSlackDisplayName(left).localeCompare(
        getSlackDisplayName(right),
        undefined,
        { sensitivity: "base" },
      ),
    );

  return {
    setters,
    truncated: rows.length > MAX_SLACK_SETTERS,
  };
}

function toSetterOption(setter: SlackSetter) {
  return {
    slackUserId: setter.slackUserId,
    slackTeamId: setter.slackTeamId,
    displayName: getSlackDisplayName(setter),
    avatarUrl: setter.avatarUrl ?? null,
    isDeleted: setter.isDeleted,
  };
}

function summarizeReport(args: {
  periodCounts: PeriodReportRow[];
  userCounts: SetterContributionRow[];
  businessDayCount: number;
  teamDailyGoal: number | null;
  isTeamView: boolean;
  eventSummary: QualificationEventSummary;
  eventsTruncated: boolean;
  legacyOpportunityAggregateCount: number;
}) {
  const totalQualified = args.periodCounts.reduce(
    (sum, period) => sum + period.qualifiedCount,
    0,
  );
  // The days some qualifier works, summed over the periods.
  const goalDayCount = args.periodCounts.reduce((sum, period) => sum + period.goalDays, 0);
  const expectedTeamQualified =
    args.isTeamView && args.teamDailyGoal !== null
      ? args.teamDailyGoal * goalDayCount
      : null;
  const underGoalPeriods = args.isTeamView
    ? args.periodCounts.filter(
        (period) =>
          period.expectedTeamCount !== null &&
          period.qualifiedCount < period.expectedTeamCount,
      ).length
    : 0;

  return {
    totalQualified,
    businessDayCount: args.businessDayCount,
    goalDayCount,
    averagePerBusinessDay:
      args.businessDayCount > 0 ? totalQualified / args.businessDayCount : null,
    dailyTeamQualificationGoal: args.teamDailyGoal,
    expectedTeamQualified,
    teamGoalDelta:
      expectedTeamQualified !== null ? totalQualified - expectedTeamQualified : null,
    teamGoalAttainment:
      expectedTeamQualified !== null && expectedTeamQualified > 0
        ? totalQualified / expectedTeamQualified
        : null,
    underGoalPeriods,
    setterCount: args.userCounts.length,
    qualificationEventCount: args.eventSummary.qualificationEventCount,
    uniqueLinkedOpportunityCount: args.eventSummary.uniqueLinkedOpportunityCount,
    uniqueSlackOpportunityCount: args.eventSummary.uniqueSlackOpportunityCount,
    createdOpportunityEvents: args.eventSummary.createdOpportunityEvents,
    duplicatePendingEvents: args.eventSummary.duplicatePendingEvents,
    alreadyBookedEvents: args.eventSummary.alreadyBookedEvents,
    unlinkedEvents: args.eventSummary.unlinkedEvents,
    legacyOpportunityAggregateCount: args.legacyOpportunityAggregateCount,
    eventsTruncated: args.eventsTruncated,
  };
}

function getSlackDisplayName(setter: SlackSetter): string {
  const displayName =
    setter.displayName?.trim() ||
    setter.realName?.trim() ||
    setter.username?.trim();

  return displayName && displayName.length > 0
    ? displayName
    : setter.slackUserId;
}

/** Trusted tenant adapter for assistant reports; the web wrapper remains unchanged. */
export async function readMcpGetQualificationReport(ctx: QueryCtx, tenantId: Id<"tenants">, args: ReaderArgs<typeof getQualificationReport>) {
    

    const selectedSlackUserId = args.slackUserId?.trim() || undefined;
    const setting = await getTenantBusinessDay(ctx, tenantId);
    const { periods, rangeStart, rangeEnd } = qualificationReportRange(args, setting);

    const eventResult = await listQualificationEventsForRange(ctx, {
      tenantId,
      start: rangeStart,
      end: rangeEnd,
      slackUserId: selectedSlackUserId,
    });
    const opportunityById = await loadOpportunityMapForQualificationEvents(
      ctx,
      eventResult.rows,
    );
    const legacyOpportunityAggregateCount =
      await countLegacyOpportunityAggregate(ctx, {
        tenantId,
        start: rangeStart,
        end: rangeEnd,
        slackUserId: selectedSlackUserId,
      });

    return await buildQualificationReport(ctx, tenantId, args, setting, {
      summary: summarizeQualificationEvents(eventResult.rows, opportunityById),
      byPeriodStart: new Map(
        periods.map((period) => [
          period.start,
          summarizeQualificationEvents(
            eventResult.rows.filter(
              (event) =>
                event.submittedAt >= period.start && event.submittedAt < period.end,
            ),
            opportunityById,
          ),
        ]),
      ),
      bySlackUserId: summarizeBySetter(eventResult.rows, opportunityById),
      eventsTruncated: eventResult.truncated,
      legacyOpportunityAggregateCount,
    });
}
