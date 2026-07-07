import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query } from "../_generated/server";
import type { QueryCtx } from "../_generated/server";
import { buildDmCloserEfficiencyRows } from "../dashboard/overviewLeaderboardBuilders";
import {
  deriveOverviewRange,
  overviewRangeValidator,
} from "../dashboard/overviewRange";
import { leadDisplayFromShape } from "../lib/leadDisplay";
import {
  dmCloserMemberIdentity,
  memberAvatarIdentityValidator,
  unknownMemberIdentity,
} from "../lib/memberIdentity";
import { opportunityStatusValidator } from "../opportunities/validators";
import { requireTenantUser } from "../requireTenantUser";

// Registry bounds match attribution/teams.ts and attribution/dmClosers.ts.
const TEAM_REGISTRY_LIMIT = 200;
const DM_CLOSER_REGISTRY_LIMIT = 300;
// Search fan-out bounds for searchBookedCallsDetails.
const SEARCH_OPPORTUNITY_LIMIT = 30;
const MEETINGS_PER_OPPORTUNITY_LIMIT = 25;
const SEARCH_RESULT_LIMIT = 50;
// Details window upper bound: the dashboard window is capped at
// MAX_OVERVIEW_CUSTOM_DAYS (120) business days, which is always under a year
// of wall-clock time. Rejecting anything larger keeps client-supplied epoch-ms
// bounds from turning into an unbounded index range.
const MAX_DETAILS_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;

const dmCloserRowValidator = v.object({
  key: v.string(),
  label: v.string(),
  teamLabel: v.union(v.string(), v.null()),
  booked: v.number(),
  bookedPerHour: v.union(v.number(), v.null()),
  scheduledHours: v.union(v.number(), v.null()),
  hourlyRateMinor: v.union(v.number(), v.null()),
  avatar: memberAvatarIdentityValidator,
});

const goalTeamValidator = v.object({
  teamId: v.id("attributionTeams"),
  label: v.string(),
  dailyQuota: v.union(v.number(), v.null()),
  target: v.union(v.number(), v.null()),
  progress: v.number(),
});

const initialSourceValidator = v.union(
  v.literal("cta"),
  v.literal("inbound"),
  v.literal("wechat"),
);

const bookedCallRowValidator = v.object({
  meetingId: v.id("meetings"),
  bookedAt: v.number(),
  scheduledAt: v.number(),
  meetingStatus: v.union(
    v.literal("scheduled"),
    v.literal("completed"),
    v.literal("canceled"),
    v.literal("no_show"),
  ),
  programName: v.union(v.string(), v.null()),
  opportunityId: v.id("opportunities"),
  opportunityStatus: v.union(opportunityStatusValidator, v.null()),
  leadId: v.union(v.id("leads"), v.null()),
  leadLabel: v.string(),
  leadHandle: v.union(v.string(), v.null()),
  initialSource: v.union(initialSourceValidator, v.null()),
  selfReportedIncome: v.union(v.number(), v.null()),
  attributionTeamId: v.union(v.id("attributionTeams"), v.null()),
  attributionTeamLabel: v.union(v.string(), v.null()),
  dmCloserId: v.id("dmClosers"),
  dmCloserLabel: v.union(v.string(), v.null()),
});

type BookedCallMeeting = Doc<"meetings"> & { dmCloserId: Id<"dmClosers"> };

// Booked-call population: the exact semantics of the Overview's DM-closer
// machinery (buildDmCloserEfficiencyRows) — meetings whose createdAt falls in
// the range's business-day UTC window, excluding follow_up classifications,
// with a resolved dmCloserId.
function isBookedCallMeeting(
  meeting: Doc<"meetings">,
): meeting is BookedCallMeeting {
  return (
    meeting.dmCloserId !== undefined &&
    meeting.callClassification !== "follow_up"
  );
}

function isNonNull<T>(value: T | null): value is T {
  return value !== null;
}

function uniqueIds<T extends string>(ids: Array<T | undefined>): T[] {
  return [
    ...new Set(ids.filter((id): id is T => id !== undefined)),
  ];
}

function validateWindow(start: number, end: number) {
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end < 0
  ) {
    throw new Error("Invalid booked-calls window bounds.");
  }
  if (end <= start) {
    throw new Error("Booked-calls window end must be after its start.");
  }
  if (end - start > MAX_DETAILS_WINDOW_MS) {
    throw new Error("Booked-calls window is too large. Narrow the date range.");
  }
  return { start, end };
}

function compareLabels(left: string, right: string) {
  return left.localeCompare(right, undefined, { sensitivity: "base" });
}

async function enrichBookedCallRows(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  meetings: BookedCallMeeting[],
) {
  const opportunityIds = uniqueIds(meetings.map((m) => m.opportunityId));
  const opportunities = await Promise.all(
    opportunityIds.map((id) => ctx.db.get(id)),
  );
  const opportunityById = new Map(
    opportunities
      .filter(isNonNull)
      .filter((opportunity) => opportunity.tenantId === tenantId)
      .map((opportunity) => [opportunity._id, opportunity]),
  );

  const leadIds = uniqueIds(
    [...opportunityById.values()].map((opportunity) => opportunity.leadId),
  );
  const teamIds = uniqueIds(meetings.map((m) => m.attributionTeamId));
  const dmCloserIds = uniqueIds(meetings.map((m) => m.dmCloserId));

  const [leads, teams, dmClosers] = await Promise.all([
    Promise.all(leadIds.map((id) => ctx.db.get(id))),
    Promise.all(teamIds.map((id) => ctx.db.get(id))),
    Promise.all(dmCloserIds.map((id) => ctx.db.get(id))),
  ]);

  const leadById = new Map(
    leads
      .filter(isNonNull)
      .filter((lead) => lead.tenantId === tenantId)
      .map((lead) => [lead._id, lead]),
  );
  const teamById = new Map(
    teams
      .filter(isNonNull)
      .filter((team) => team.tenantId === tenantId)
      .map((team) => [team._id, team]),
  );
  const dmCloserById = new Map(
    dmClosers
      .filter(isNonNull)
      .filter((closer) => closer.tenantId === tenantId)
      .map((closer) => [closer._id, closer]),
  );

  return meetings.map((meeting) => {
    const opportunity = opportunityById.get(meeting.opportunityId) ?? null;
    const lead = opportunity ? (leadById.get(opportunity.leadId) ?? null) : null;
    const team = meeting.attributionTeamId
      ? (teamById.get(meeting.attributionTeamId) ?? null)
      : null;
    const dmCloser = dmCloserById.get(meeting.dmCloserId) ?? null;
    const fallbackLeadName = meeting.leadName?.trim();

    return {
      meetingId: meeting._id,
      bookedAt: meeting.createdAt,
      scheduledAt: meeting.scheduledAt,
      meetingStatus: meeting.status,
      programName:
        meeting.bookingProgramName ??
        opportunity?.firstBookingProgramName ??
        null,
      opportunityId: meeting.opportunityId,
      opportunityStatus:
        opportunity?.status ?? meeting.opportunityStatus ?? null,
      leadId: lead?._id ?? opportunity?.leadId ?? null,
      leadLabel: lead
        ? leadDisplayFromShape({
            fullName: lead.fullName,
            email: lead.email,
            leadId: lead._id,
          })
        : fallbackLeadName && fallbackLeadName.length > 0
          ? fallbackLeadName
          : "Unknown lead",
      leadHandle:
        lead?.socialHandles?.[0]?.handle ??
        lead?.email ??
        lead?.phone ??
        null,
      initialSource: lead?.initialSource ?? null,
      selfReportedIncome: lead?.selfReportedIncome ?? null,
      attributionTeamId: meeting.attributionTeamId ?? null,
      attributionTeamLabel: team?.displayName ?? null,
      dmCloserId: meeting.dmCloserId,
      dmCloserLabel: dmCloser?.displayName ?? null,
    };
  });
}

/**
 * Consolidated data source for the admin Booked Calls page (NIM-19):
 * per-DM-closer bar chart + contributions table, per-team booking-goal
 * progress ring, all in one round trip. The collapsible bookings list stays
 * on the separate paginated/search queries below; pass `window` into their
 * start/end args so both surfaces share one time window.
 */
export const getBookedCallsDashboard = query({
  args: {
    range: overviewRangeValidator,
  },
  returns: v.object({
    totalBooked: v.number(),
    dmClosers: v.array(dmCloserRowValidator),
    goal: v.object({
      totalTarget: v.union(v.number(), v.null()),
      progress: v.number(),
      businessDayCount: v.number(),
      teams: v.array(goalTeamValidator),
    }),
    window: v.object({
      start: v.number(),
      end: v.number(),
    }),
    capped: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    try {
      const range = deriveOverviewRange(args.range, Date.now());

      // Same machinery as the Overview's Top DM Closers section: one bounded
      // meetings read (by_tenantId_and_createdAt over the business-day UTC
      // window), booked = new-classification meetings with a dmCloserId,
      // scheduled hours via loadDmCloserScheduledHoursForRange inside.
      //
      // buildDmCloserEfficiencyRows THROWS when the meetings read exceeds its
      // cap; mirror the Overview leaderboard's handling (overview
      // LeaderboardBuilders "dm_closers" case) and turn that specific error
      // into an empty-but-valid capped payload instead of failing the query.
      let builderResult: Awaited<
        ReturnType<typeof buildDmCloserEfficiencyRows>
      >;
      try {
        builderResult = await buildDmCloserEfficiencyRows(ctx, {
          tenantId,
          range,
          includeAllCandidates: false,
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown dashboard error";
        if (/too large|cannot exceed|narrow/i.test(message)) {
          console.warn(
            "[Operations:BookedCalls] getBookedCallsDashboard capped",
            { tenantId, range: args.range, message },
          );
          return {
            totalBooked: 0,
            dmClosers: [],
            goal: {
              totalTarget: null,
              progress: 0,
              businessDayCount: range.dayCount,
              teams: [],
            },
            window: {
              start: range.slackWindowStart,
              end: range.slackWindowEnd,
            },
            capped: true,
          };
        }
        throw error;
      }
      const { rows, truncated, bookedByTeam } = builderResult;
      const totalBooked = rows.reduce((sum, row) => sum + row.booked, 0);

      const [registryClosers, teams] = await Promise.all([
        ctx.db
          .query("dmClosers")
          .withIndex("by_tenantId_and_teamId", (q) => q.eq("tenantId", tenantId))
          .take(DM_CLOSER_REGISTRY_LIMIT),
        ctx.db
          .query("attributionTeams")
          .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
          .take(TEAM_REGISTRY_LIMIT),
      ]);

      const closerById = new Map(
        registryClosers.map((closer) => [closer._id, closer]),
      );
      // Rows can reference closers beyond the registry cap; fetch the misses
      // individually (bounded by rows.length).
      for (const row of rows) {
        if (closerById.has(row.dmCloserId)) continue;
        const closer = await ctx.db.get(row.dmCloserId);
        if (closer && closer.tenantId === tenantId) {
          closerById.set(closer._id, closer);
        }
      }

      const linkedUserIds = uniqueIds(
        rows.map((row) => closerById.get(row.dmCloserId)?.userId),
      );
      const linkedUsers = await Promise.all(
        linkedUserIds.map((id) => ctx.db.get(id)),
      );
      const linkedUserById = new Map(
        linkedUsers
          .filter(isNonNull)
          .filter((user) => user.tenantId === tenantId)
          .map((user) => [user._id, user]),
      );

      const dmCloserRows = await Promise.all(
        rows.map(async (row) => {
          const closer = closerById.get(row.dmCloserId) ?? null;
          const linkedUser = closer?.userId
            ? (linkedUserById.get(closer.userId) ?? null)
            : null;

          return {
            key: row.dmCloserId as string,
            label: row.displayName,
            teamLabel: row.teamName,
            booked: row.booked,
            bookedPerHour: row.bookedPerHour,
            scheduledHours: row.scheduledHours > 0 ? row.scheduledHours : null,
            hourlyRateMinor: closer?.hourlyRateMinor ?? null,
            avatar: closer
              ? await dmCloserMemberIdentity(ctx, closer, linkedUser)
              : unknownMemberIdentity("Removed DM closer", "unknown"),
          };
        }),
      );
      dmCloserRows.sort(
        (left, right) =>
          right.booked - left.booked || compareLabels(left.label, right.label),
      );

      // Per-team goal: dailyQuota x business days in range. Progress groups
      // the same booked population by the meeting's attributionTeamId.
      const goalTeams = teams
        .filter(
          (team) => team.isActive || (bookedByTeam.get(team._id) ?? 0) > 0,
        )
        .map((team) => {
          const dailyQuota = team.bookingDailyQuota ?? null;
          return {
            teamId: team._id,
            label: team.displayName,
            dailyQuota,
            target: dailyQuota === null ? null : dailyQuota * range.dayCount,
            progress: bookedByTeam.get(team._id) ?? 0,
          };
        })
        .sort((left, right) => compareLabels(left.label, right.label));

      const targets = goalTeams
        .map((team) => team.target)
        .filter((target): target is number => target !== null);
      const totalTarget =
        targets.length > 0
          ? targets.reduce((sum, target) => sum + target, 0)
          : null;

      return {
        totalBooked,
        dmClosers: dmCloserRows,
        goal: {
          totalTarget,
          progress: totalBooked,
          businessDayCount: range.dayCount,
          teams: goalTeams,
        },
        window: {
          start: range.slackWindowStart,
          end: range.slackWindowEnd,
        },
        capped:
          truncated ||
          registryClosers.length >= DM_CLOSER_REGISTRY_LIMIT ||
          teams.length >= TEAM_REGISTRY_LIMIT,
      };
    } catch (error) {
      console.error("[Operations:BookedCalls] getBookedCallsDashboard failed", {
        tenantId,
        range: args.range,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },
});

/**
 * Paginated bookings for the collapsible details list. Same population as
 * getBookedCallsDashboard (new-classification, DM-closer-attributed meetings
 * by createdAt window), newest booking first. Pass the dashboard's `window`
 * as start/end so both surfaces agree.
 */
export const listBookedCallsDetails = query({
  args: {
    paginationOpts: paginationOptsValidator,
    start: v.number(),
    end: v.number(),
    dmCloserId: v.optional(v.id("dmClosers")),
  },
  returns: v.object({
    page: v.array(bookedCallRowValidator),
    isDone: v.boolean(),
    continueCursor: v.string(),
    splitCursor: v.optional(v.union(v.string(), v.null())),
    pageStatus: v.optional(
      v.union(
        v.literal("SplitRecommended"),
        v.literal("SplitRequired"),
        v.null(),
      ),
    ),
  }),
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    try {
      const { start, end } = validateWindow(args.start, args.end);

      const result = await ctx.db
        .query("meetings")
        .withIndex("by_tenantId_and_createdAt", (q) =>
          q.eq("tenantId", tenantId).gte("createdAt", start).lt("createdAt", end),
        )
        .order("desc")
        .paginate(args.paginationOpts);

      // Follow-up and non-DM-attributed meetings are excluded post-read within
      // the page (there is no createdAt index carrying those dimensions), so
      // pages can come back shorter than numItems; the cursor stays correct.
      const bookedCalls = result.page
        .filter(isBookedCallMeeting)
        .filter(
          (meeting) =>
            args.dmCloserId === undefined ||
            meeting.dmCloserId === args.dmCloserId,
        );

      return {
        page: await enrichBookedCallRows(ctx, tenantId, bookedCalls),
        isDone: result.isDone,
        continueCursor: result.continueCursor,
        splitCursor: result.splitCursor,
        pageStatus: result.pageStatus,
      };
    } catch (error) {
      console.error("[Operations:BookedCalls] listBookedCallsDetails failed", {
        tenantId,
        start: args.start,
        end: args.end,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },
});

/**
 * Search bookings by lead/prospect name for the collapsible details list.
 * Uses the opportunitySearch projection (searchText embeds the lead's search
 * text), then follows by_opportunityId_and_scheduledAt to the meetings and
 * post-filters to the booked-call window. Bounded fan-out, ~50 rows max.
 */
export const searchBookedCallsDetails = query({
  args: {
    searchTerm: v.string(),
    start: v.number(),
    end: v.number(),
    dmCloserId: v.optional(v.id("dmClosers")),
  },
  returns: v.array(bookedCallRowValidator),
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    try {
      const { start, end } = validateWindow(args.start, args.end);

      const term = args.searchTerm.trim();
      if (term.length < 2) {
        return [];
      }

      const searchRows = await ctx.db
        .query("opportunitySearch")
        .withSearchIndex("search_opportunities", (q) =>
          q.search("searchText", term).eq("tenantId", tenantId),
        )
        .take(SEARCH_OPPORTUNITY_LIMIT);

      const opportunityIds = uniqueIds(
        searchRows.map((row) => row.opportunityId),
      );

      const meetingsPerOpportunity = await Promise.all(
        opportunityIds.map((opportunityId) =>
          ctx.db
            .query("meetings")
            .withIndex("by_opportunityId_and_scheduledAt", (q) =>
              q.eq("opportunityId", opportunityId),
            )
            .order("desc")
            .take(MEETINGS_PER_OPPORTUNITY_LIMIT),
        ),
      );

      const bookedCalls = meetingsPerOpportunity
        .flat()
        .filter((meeting) => meeting.tenantId === tenantId)
        .filter((meeting) => meeting.createdAt >= start && meeting.createdAt < end)
        .filter(isBookedCallMeeting)
        .filter(
          (meeting) =>
            args.dmCloserId === undefined ||
            meeting.dmCloserId === args.dmCloserId,
        )
        .sort((left, right) => right.createdAt - left.createdAt)
        .slice(0, SEARCH_RESULT_LIMIT);

      return await enrichBookedCallRows(ctx, tenantId, bookedCalls);
    } catch (error) {
      console.error("[Operations:BookedCalls] searchBookedCallsDetails failed", {
        tenantId,
        start: args.start,
        end: args.end,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },
});
