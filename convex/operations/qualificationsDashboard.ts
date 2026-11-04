import { getTenantBusinessDay } from "../lib/tenantBusinessDay";
import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { query, type QueryCtx } from "../_generated/server";
import {
  deriveOverviewRange,
  overviewRangeValidator,
  type DerivedOverviewRange,
} from "../dashboard/overviewRange";
import {
  memberAvatarIdentityValidator,
  slackMemberIdentity,
  type MemberAvatarIdentity,
} from "../lib/memberIdentity";
import {
  createLiveReadState,
  readLiveQueryRows,
} from "../lib/liveQueryBounds";
import { listQualificationEventsForRange } from "../reporting/lib/slackQualificationLedger";
import { requireTenantUser } from "../requireTenantUser";
import { hoursOverDays } from "../lib/workSchedule";
import { qualifiedGoalDayCount } from "../workSchedules/goalDays";
import {
  businessDatesInInclusiveRange,
  loadScheduleRowsByOwner,
} from "../workSchedules/rangeHours";

const SLACK_USER_REGISTRY_LIMIT = 300;
const LIVE_QUALIFIER_CANDIDATE_LIMIT = 300;

const openerRowValidator = v.object({
  key: v.string(),
  label: v.string(),
  qualified: v.number(),
  qualifiedPerHour: v.union(v.number(), v.null()),
  scheduledHours: v.union(v.number(), v.null()),
  lastEventAt: v.union(v.number(), v.null()),
  avatar: memberAvatarIdentityValidator,
});

type OpenerRow = {
  key: string;
  label: string;
  qualified: number;
  qualifiedPerHour: number | null;
  scheduledHours: number | null;
  lastEventAt: number | null;
  avatar: MemberAvatarIdentity;
};

/** One opener's qualification events in the range. */
export type QualifiedBySlackUser = {
  slackUserId: string;
  qualified: number;
  lastEventAt: number;
};

/** Openers in the order of their first event in the range. */
export type QualifiedEvents = {
  bySlackUser: QualifiedBySlackUser[];
  truncated: boolean;
};

function qualifiedBySlackUser(events: Doc<"slackQualificationEvents">[]) {
  const bySlackUserId = new Map<string, QualifiedBySlackUser>();
  for (const event of events) {
    const current = bySlackUserId.get(event.slackUserId) ?? {
      slackUserId: event.slackUserId,
      qualified: 0,
      lastEventAt: event.submittedAt,
    };
    current.qualified += 1;
    current.lastEventAt = Math.max(current.lastEventAt, event.submittedAt);
    bySlackUserId.set(event.slackUserId, current);
  }
  return [...bySlackUserId.values()];
}

function slackUserLabel(user: Doc<"slackUsers"> | undefined, slackUserId: string) {
  const label =
    user?.displayName?.trim() ||
    user?.realName?.trim() ||
    user?.username?.trim();
  return label && label.length > 0 ? label : slackUserId;
}

/**
 * Consolidated data source for the admin Qualifications page (NIM-18):
 * per-opener bar chart, team goal progress ring, and setter contributions
 * table in a single round trip. The collapsible submissions list stays on
 * the separate paginated queries in `operations/qualifications.ts`.
 */
export const getQualificationsDashboard = query({
  args: {
    range: overviewRangeValidator,
  },
  returns: v.object({
    totalQualified: v.number(),
    openers: v.array(openerRowValidator),
    goal: v.object({
      dailyQuota: v.union(v.number(), v.null()),
      target: v.union(v.number(), v.null()),
      progress: v.number(),
      businessDayCount: v.number(),
      // Days in the range some qualifier works; target = dailyQuota x this.
      // Optional: answers cached before goals counted work days lack it.
      goalDayCount: v.optional(v.number()),
    }),
    capped: v.boolean(),
    // Epoch-ms window matching the derived range; pass straight into the
    // qualifiedAfter/qualifiedBefore args of the submissions-list queries in
    // operations/qualifications.ts so both surfaces share one time window.
    window: v.object({
      qualifiedAfter: v.number(),
      qualifiedBefore: v.number(),
    }),
  }),
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const range = deriveOverviewRange(args.range, Date.now(), await getTenantBusinessDay(ctx, tenantId));

    const tenant = await ctx.db.get("tenants", tenantId);
    if (!tenant) {
      throw new Error("Tenant not found.");
    }

    const events = await listQualificationEventsForRange(ctx, {
      tenantId,
      start: range.slackWindowStart,
      end: range.slackWindowEnd,
    });
    return await buildQualificationsDashboard(ctx, tenant, range, {
      bySlackUser: qualifiedBySlackUser(events.rows),
      truncated: events.truncated,
    });
  },
});

/**
 * The Qualifications dashboard from each opener's qualification events in
 * the range: how many, and the latest. The Convex reader counts the events;
 * the ClickHouse report (convex/analytics/definitions/operations.ts) counts
 * them in SQL.
 */
export async function buildQualificationsDashboard(
  ctx: QueryCtx,
  tenant: Doc<"tenants">,
  range: Pick<
    DerivedOverviewRange,
    "slackWindowStart" | "slackWindowEnd" | "startBusinessDate" | "endBusinessDateInclusive" | "dayCount"
  >,
  events: QualifiedEvents,
) {
  const tenantId = tenant._id;
  const dailyQuota = tenant.slackQualificationDailyTeamQuota ?? null;
  const cappedAnswer = () => ({
    totalQualified: 0,
    openers: [],
    goal: qualifiedGoal(dailyQuota, range.dayCount, 0, range.dayCount),
    capped: true,
    window: {
      qualifiedAfter: range.slackWindowStart,
      qualifiedBefore: range.slackWindowEnd,
    },
  });

  const slackUserScan = await readLiveQueryRows(
    ctx.db
      .query("slackUsers")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId)),
    SLACK_USER_REGISTRY_LIMIT,
  );
  if (events.truncated || slackUserScan.capped) return cappedAnswer();
  const slackUsers = slackUserScan.rows;

  // Each qualifier's schedule rows, every date: a day's hours are the ones in
  // force that day (convex/lib/workSchedule.ts, "Dated schedules").
  const scheduleReadState = createLiveReadState();
  const scheduleRowsBySlackUserId = await loadScheduleRowsByOwner(ctx, {
    tenantId,
    keys: slackUsers.map((user) => user.slackUserId),
    owner: (slackUserId) => ({ table: "slackQualifierSchedules", slackUserId }),
    liveReadState: scheduleReadState,
  });
  if (scheduleReadState.capped) return cappedAnswer();

  const slackUserById = new Map(
    slackUsers.map((user) => [user.slackUserId, user]),
  );

  // Candidates: everyone with a qualifier schedule (so scheduled openers
  // show up at zero) plus everyone who logged an event in range.
  const scheduledSlackUserIds = new Set<string>();
  for (const [slackUserId, rows] of scheduleRowsBySlackUserId) {
    if (rows.length > 0) scheduledSlackUserIds.add(slackUserId);
  }
  const candidateSlackUserIds = new Set<string>(scheduledSlackUserIds);
  const eventsBySlackUserId = new Map<string, QualifiedBySlackUser>();
  for (const opener of events.bySlackUser) {
    candidateSlackUserIds.add(opener.slackUserId);
    eventsBySlackUserId.set(opener.slackUserId, opener);
  }

  if (candidateSlackUserIds.size > LIVE_QUALIFIER_CANDIDATE_LIMIT) return cappedAnswer();

  const rangeDays = businessDatesInInclusiveRange(range);
  const scheduledHoursBySlackUserId = new Map<string, number>();
  for (const slackUserId of scheduledSlackUserIds) {
    scheduledHoursBySlackUserId.set(
      slackUserId,
      hoursOverDays(scheduleRowsBySlackUserId.get(slackUserId) ?? [], rangeDays),
    );
  }
  const goalDays = qualifiedGoalDayCount(slackUsers, scheduleRowsBySlackUserId, rangeDays);

  const openers: OpenerRow[] = [];
  for (const slackUserId of candidateSlackUserIds) {
    const user = slackUserById.get(slackUserId);
    const userEvents = eventsBySlackUserId.get(slackUserId);
    const qualified = userEvents?.qualified ?? 0;
    const scheduledHours = scheduledSlackUserIds.has(slackUserId)
      ? (scheduledHoursBySlackUserId.get(slackUserId) ?? 0)
      : null;

    openers.push({
      key: slackUserId,
      label: slackUserLabel(user, slackUserId),
      qualified,
      qualifiedPerHour:
        scheduledHours !== null && scheduledHours > 0
          ? qualified / scheduledHours
          : null,
      scheduledHours,
      lastEventAt: userEvents?.lastEventAt ?? null,
      avatar: slackMemberIdentity(user, `slack:${slackUserId}`),
    });
  }

  openers.sort((left, right) => {
    const byQualified = right.qualified - left.qualified;
    if (byQualified !== 0) {
      return byQualified;
    }
    return left.label.localeCompare(right.label, undefined, {
      sensitivity: "base",
    });
  });

  // The daily team quota times the days some qualifier works in the range
  // (qualifiedGoalDayCount), as getQualificationReport's period goals do.
  const totalQualified = events.bySlackUser.reduce(
    (sum, opener) => sum + opener.qualified,
    0,
  );

  return {
    totalQualified,
    openers,
    goal: qualifiedGoal(dailyQuota, goalDays, totalQualified, range.dayCount),
    capped: false,
    window: {
      qualifiedAfter: range.slackWindowStart,
      qualifiedBefore: range.slackWindowEnd,
    },
  };
}

function qualifiedGoal(dailyQuota: number | null, goalDays: number, progress: number, businessDayCount: number) {
  return {
    dailyQuota,
    target: dailyQuota === null ? null : dailyQuota * goalDays,
    progress,
    businessDayCount,
    goalDayCount: goalDays,
  };
}
