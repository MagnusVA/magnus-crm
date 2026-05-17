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

const MAX_SLACK_SETTERS = 500;
const MAX_DAILY_TEAM_GOAL = 5000;

type SlackSetter = Doc<"slackUsers">;

type PeriodReportRow = BusinessPeriod & {
  qualifiedCount: number;
  expectedTeamCount: number | null;
  teamGoalAttainment: number | null;
};

type SetterContributionRow = {
  slackUserId: string;
  slackTeamId: string;
  displayName: string;
  avatarUrl: string | null;
  isDeleted: boolean;
  totalQualified: number;
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

    const [periodCounts, userCounts] = await Promise.all([
      countPeriods(ctx, {
        tenantId,
        periods,
        slackUserId: selectedSlackUserId,
        teamDailyGoal,
      }),
      countUsersForRange(ctx, {
        tenantId,
        setters: visibleSetters,
        start: rangeStart,
        end: rangeEnd,
        includeContributionShare: isTeamView,
      }),
    ]);

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

async function countPeriods(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    periods: BusinessPeriod[];
    slackUserId?: string;
    teamDailyGoal: number | null;
  },
): Promise<PeriodReportRow[]> {
  if (args.periods.length === 0) {
    return [];
  }

  if (args.slackUserId) {
    const counts = await slackQualificationsByUser.countBatch(
      ctx,
      args.periods.map((period) => ({
        namespace: args.tenantId,
        bounds: {
          lower: {
            key: [args.slackUserId!, period.start] as [string, number],
            inclusive: true,
          },
          upper: {
            key: [args.slackUserId!, period.end] as [string, number],
            inclusive: false,
          },
        },
      })),
    );

    return args.periods.map((period, index) => ({
      ...period,
      qualifiedCount: counts[index] ?? 0,
      expectedTeamCount: null,
      teamGoalAttainment: null,
    }));
  }

  const counts = await slackQualificationsByTime.countBatch(
    ctx,
    args.periods.map((period) => ({
      namespace: args.tenantId,
      bounds: {
        lower: { key: period.start, inclusive: true },
        upper: { key: period.end, inclusive: false },
      },
    })),
  );

  return args.periods.map((period, index) => {
    const qualifiedCount = counts[index] ?? 0;
    const expectedTeamCount =
      args.teamDailyGoal === null ? null : args.teamDailyGoal * period.goalDays;
    return {
      ...period,
      qualifiedCount,
      expectedTeamCount,
      teamGoalAttainment:
        expectedTeamCount !== null && expectedTeamCount > 0
          ? qualifiedCount / expectedTeamCount
          : null,
    };
  });
}

async function countUsersForRange(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    setters: SlackSetter[];
    start: number;
    end: number;
    includeContributionShare: boolean;
  },
): Promise<SetterContributionRow[]> {
  if (args.setters.length === 0) {
    return [];
  }

  const countQueries = args.setters.map((setter) => ({
    namespace: args.tenantId,
    bounds: {
      lower: {
        key: [setter.slackUserId, args.start] as [string, number],
        inclusive: true,
      },
      upper: {
        key: [setter.slackUserId, args.end] as [string, number],
        inclusive: false,
      },
    },
  }));
  const counts = await slackQualificationsByUser.countBatch(ctx, countQueries);

  const lastQualifiedQueries: Array<(typeof countQueries)[number] & {
    offset: number;
  }> = [];
  const lastQualifiedIndexes: number[] = [];

  counts.forEach((count, index) => {
    if (count <= 0) {
      return;
    }

    lastQualifiedQueries.push({
      ...countQueries[index],
      offset: -1,
    });
    lastQualifiedIndexes.push(index);
  });

  const lastQualifiedAtByIndex = new Map<number, number>();
  if (lastQualifiedQueries.length > 0) {
    const lastItems = await slackQualificationsByUser.atBatch(
      ctx,
      lastQualifiedQueries,
    );
    lastItems.forEach((item, index) => {
      lastQualifiedAtByIndex.set(lastQualifiedIndexes[index], item.key[1]);
    });
  }

  const visibleTotal = counts.reduce((sum, count) => sum + count, 0);

  return args.setters
    .map((setter, index) => {
      const totalQualified = counts[index] ?? 0;
      return {
        slackUserId: setter.slackUserId,
        slackTeamId: setter.slackTeamId,
        displayName: getSlackDisplayName(setter),
        avatarUrl: setter.avatarUrl ?? null,
        isDeleted: setter.isDeleted,
        totalQualified,
        contributionShare:
          args.includeContributionShare && visibleTotal > 0
            ? totalQualified / visibleTotal
            : null,
        lastQualifiedAt: lastQualifiedAtByIndex.get(index) ?? null,
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
