import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, query, type QueryCtx } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import {
  slackQualificationsByTime,
  slackQualificationsByUser,
} from "./aggregates";
import {
  buildBusinessPeriods,
  businessDateToUtcStart,
  countBusinessDays,
  HONDURAS_TIME_ZONE,
  reportGranularityValidator,
  type BusinessPeriod,
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

    const tenant = await ctx.db.get(tenantId);
    if (!tenant) {
      throw new Error("Tenant not found.");
    }

    const selectedSlackUserId = args.slackUserId?.trim() || undefined;
    const periods = buildBusinessPeriods({
      startBusinessDate: args.startBusinessDate,
      endBusinessDateExclusive: args.endBusinessDateExclusive,
      granularity: args.granularity,
    });
    const rangeStart = businessDateToUtcStart(args.startBusinessDate);
    const rangeEnd = businessDateToUtcStart(args.endBusinessDateExclusive);
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
    const eventSummary = summarizeQualificationEvents(
      eventResult.rows,
      opportunityById,
    );
    const periodCounts = countPeriods({
      periods,
      teamDailyGoal,
      qualificationEvents: eventResult.rows,
      opportunityById,
    });
    const userCounts = countUsersForRange({
      setters: visibleSetters,
      qualificationEvents: eventResult.rows,
      opportunityById,
      includeContributionShare: isTeamView,
    });
    const legacyOpportunityAggregateCount =
      await countLegacyOpportunityAggregate(ctx, {
        tenantId,
        start: rangeStart,
        end: rangeEnd,
        slackUserId: selectedSlackUserId,
      });

    return {
      timezone: HONDURAS_TIME_ZONE,
      businessDayStartsAtHour: 1,
      startBusinessDate: args.startBusinessDate,
      endBusinessDateExclusive: args.endBusinessDateExclusive,
      granularity: args.granularity,
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
        eventSummary,
        eventsTruncated: eventResult.truncated,
        legacyOpportunityAggregateCount,
      }),
    };
  },
});

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

    await ctx.db.patch(tenantId, {
      slackQualificationDailyTeamQuota:
        args.dailyTeamQualificationGoal ?? undefined,
    });

    return {
      dailyTeamQualificationGoal: args.dailyTeamQualificationGoal,
    };
  },
});

function countPeriods(args: {
  periods: BusinessPeriod[];
  teamDailyGoal: number | null;
  qualificationEvents: Doc<"slackQualificationEvents">[];
  opportunityById: Map<Id<"opportunities">, Doc<"opportunities">>;
}): PeriodReportRow[] {
  if (args.periods.length === 0) {
    return [];
  }

  return args.periods.map((period) => {
    const periodEvents = args.qualificationEvents.filter(
      (event) =>
        event.submittedAt >= period.start && event.submittedAt < period.end,
    );
    const summary = summarizeQualificationEvents(periodEvents, args.opportunityById);
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
  qualificationEvents: Doc<"slackQualificationEvents">[];
  opportunityById: Map<Id<"opportunities">, Doc<"opportunities">>;
  includeContributionShare: boolean;
}): SetterContributionRow[] {
  if (args.setters.length === 0) {
    return [];
  }

  const eventsBySlackUserId = new Map<string, Doc<"slackQualificationEvents">[]>();
  for (const event of args.qualificationEvents) {
    const existing = eventsBySlackUserId.get(event.slackUserId) ?? [];
    existing.push(event);
    eventsBySlackUserId.set(event.slackUserId, existing);
  }
  const visibleTotal = args.qualificationEvents.length;

  return args.setters
    .map((setter) => {
      const events = eventsBySlackUserId.get(setter.slackUserId) ?? [];
      const summary = summarizeQualificationEvents(events, args.opportunityById);
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
        lastQualifiedAt:
          events.length > 0
            ? Math.max(...events.map((event) => event.submittedAt))
            : null,
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
