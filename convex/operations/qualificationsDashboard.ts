import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { query } from "../_generated/server";
import {
  deriveOverviewRange,
  overviewRangeValidator,
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
import { loadSlackQualifierScheduledHoursForRange } from "../workSchedules/rangeHours";

const SLACK_USER_REGISTRY_LIMIT = 300;
const SLACK_QUALIFIER_SCHEDULE_LIMIT = 2_100;
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

    try {
      const range = deriveOverviewRange(args.range, Date.now());

      const tenant = await ctx.db.get(tenantId);
      if (!tenant) {
        throw new Error("Tenant not found.");
      }

      const [slackUserScan, qualifierScheduleScan, events] = await Promise.all([
        readLiveQueryRows(
          ctx.db
            .query("slackUsers")
            .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId)),
          SLACK_USER_REGISTRY_LIMIT,
        ),
        readLiveQueryRows(
          ctx.db
            .query("slackQualifierSchedules")
            .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId)),
          SLACK_QUALIFIER_SCHEDULE_LIMIT,
        ),
        listQualificationEventsForRange(ctx, {
          tenantId,
          start: range.slackWindowStart,
          end: range.slackWindowEnd,
        }),
      ]);
      const slackUsers = slackUserScan.rows;
      const qualifierSchedules = qualifierScheduleScan.rows;

      const capped =
        events.truncated ||
        slackUserScan.capped ||
        qualifierScheduleScan.capped;
      if (capped) {
        const dailyQuota = tenant.slackQualificationDailyTeamQuota ?? null;
        return {
          totalQualified: 0,
          openers: [],
          goal: {
            dailyQuota,
            target: dailyQuota === null ? null : dailyQuota * range.dayCount,
            progress: 0,
            businessDayCount: range.dayCount,
          },
          capped: true,
          window: {
            qualifiedAfter: range.slackWindowStart,
            qualifiedBefore: range.slackWindowEnd,
          },
        };
      }

      const slackUserById = new Map(
        slackUsers.map((user) => [user.slackUserId, user]),
      );

      // Candidates: everyone with a qualifier schedule (so scheduled openers
      // show up at zero) plus everyone who logged an event in range.
      const scheduledSlackUserIds = new Set<string>();
      for (const schedule of qualifierSchedules) {
        scheduledSlackUserIds.add(schedule.slackUserId);
      }
      const candidateSlackUserIds = new Set<string>(scheduledSlackUserIds);
      const eventsBySlackUserId = new Map<
        string,
        Doc<"slackQualificationEvents">[]
      >();
      for (const event of events.rows) {
        candidateSlackUserIds.add(event.slackUserId);
        const current = eventsBySlackUserId.get(event.slackUserId) ?? [];
        current.push(event);
        eventsBySlackUserId.set(event.slackUserId, current);
      }

      if (candidateSlackUserIds.size > LIVE_QUALIFIER_CANDIDATE_LIMIT) {
        const dailyQuota = tenant.slackQualificationDailyTeamQuota ?? null;
        return {
          totalQualified: 0,
          openers: [],
          goal: {
            dailyQuota,
            target: dailyQuota === null ? null : dailyQuota * range.dayCount,
            progress: 0,
            businessDayCount: range.dayCount,
          },
          capped: true,
          window: {
            qualifiedAfter: range.slackWindowStart,
            qualifiedBefore: range.slackWindowEnd,
          },
        };
      }

      const scheduleReadState = createLiveReadState();
      const scheduledHoursBySlackUserId =
        await loadSlackQualifierScheduledHoursForRange(ctx, {
          tenantId,
          slackUserIds: [...candidateSlackUserIds],
          startBusinessDate: range.startBusinessDate,
          endBusinessDateInclusive: range.endBusinessDateInclusive,
          liveReadState: scheduleReadState,
        });
      if (scheduleReadState.capped) {
        const dailyQuota = tenant.slackQualificationDailyTeamQuota ?? null;
        return {
          totalQualified: 0,
          openers: [],
          goal: {
            dailyQuota,
            target: dailyQuota === null ? null : dailyQuota * range.dayCount,
            progress: 0,
            businessDayCount: range.dayCount,
          },
          capped: true,
          window: {
            qualifiedAfter: range.slackWindowStart,
            qualifiedBefore: range.slackWindowEnd,
          },
        };
      }

      const openers: OpenerRow[] = [];
      for (const slackUserId of candidateSlackUserIds) {
        const user = slackUserById.get(slackUserId);
        const userEvents = eventsBySlackUserId.get(slackUserId) ?? [];
        const qualified = userEvents.length;
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
          lastEventAt:
            userEvents.length > 0
              ? Math.max(...userEvents.map((event) => event.submittedAt))
              : null,
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

      // Same semantics as getQualificationReport's expectedTeamQualified:
      // daily team quota x business days in the range (range.dayCount is
      // countBusinessDays(startBusinessDate, endBusinessDateExclusive)).
      const totalQualified = events.rows.length;
      const dailyQuota = tenant.slackQualificationDailyTeamQuota ?? null;

      return {
        totalQualified,
        openers,
        goal: {
          dailyQuota,
          target: dailyQuota === null ? null : dailyQuota * range.dayCount,
          progress: totalQualified,
          businessDayCount: range.dayCount,
        },
        capped: false,
        window: {
          qualifiedAfter: range.slackWindowStart,
          qualifiedBefore: range.slackWindowEnd,
        },
      };
    } catch (error) {
      console.error(
        "[Operations:Qualifications] getQualificationsDashboard failed",
        {
          tenantId,
          range: args.range,
          message: error instanceof Error ? error.message : String(error),
        },
      );
      throw error;
    }
  },
});
