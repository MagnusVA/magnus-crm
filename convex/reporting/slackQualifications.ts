import { getTenantBusinessDay } from "../lib/tenantBusinessDay";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, query, type QueryCtx } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import {
  slackQualificationsByTime,
  slackQualificationsByUser,
} from "./aggregates";
import type { BusinessDaySetting } from "../../lib/businessDay";
import {
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
    const { periods, rangeStart, rangeEnd } = qualificationReportRange(
      args,
      await getTenantBusinessDay(ctx, tenantId),
    );

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

    return await buildQualificationReport(ctx, tenantId, args, {
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
export async function buildQualificationReport(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  args: QualificationReportArgs,
  counts: QualificationReportCounts,
) {
  const tenant = await ctx.db.get("tenants", tenantId);
  if (!tenant) {
    throw new Error("Tenant not found.");
  }

  const setting = await getTenantBusinessDay(ctx, tenantId);
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

  const periodCounts = countPeriods({
    periods,
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

export const setTeamDailyGoal = mutation({
  args: {
    dailyTeamQualificationGoal: v.union(v.number(), v.null()),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

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

    return {
      dailyTeamQualificationGoal: args.dailyTeamQualificationGoal,
    };
  },
});

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
  const expectedTeamQualified =
    args.isTeamView && args.teamDailyGoal !== null
      ? args.teamDailyGoal * args.businessDayCount
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
