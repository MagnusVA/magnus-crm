import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query } from "../_generated/server";
import type { QueryCtx } from "../_generated/server";
import { buildDmCloserEfficiencyRows } from "../dashboard/overviewLeaderboardBuilders";
import { isRangeCapErrorMessage } from "../dashboard/overviewRange";
import {
  deriveOverviewRange,
  overviewRangeValidator,
} from "../dashboard/overviewRange";
import {
  attributionsForDeal,
  bookingCreditForMeeting,
  bookingCreditsByMeeting,
  type BookingCredit,
} from "../lib/attribution/dealAttributions";
import { leadDisplayFromShape } from "../lib/leadDisplay";
import {
  LIVE_QUERY_BYTE_BUDGET,
  readLiveDocuments,
  readLiveQueryRows,
} from "../lib/liveQueryBounds";
import {
  dmCloserMemberIdentity,
  memberAvatarIdentityValidator,
  unknownMemberIdentity,
} from "../lib/memberIdentity";
import {
  dealPositionValidator,
  systemLossReasonValidator,
} from "../opportunities/dealLabelValidators";
import { dealLabelOf } from "../opportunities/stageLabels";
import { requireTenantUser } from "../requireTenantUser";

// Registry bounds match attribution/teams.ts and attribution/dmClosers.ts.
const TEAM_REGISTRY_LIMIT = 200;
const DM_CLOSER_REGISTRY_LIMIT = 300;
// Search fan-out bounds for searchBookedCallsDetails.
const SEARCH_OPPORTUNITY_LIMIT = 30;
const MEETINGS_PER_OPPORTUNITY_LIMIT = 25;
const SEARCH_RESULT_LIMIT = 50;
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
  // The deal's position and the loss the system wrote on it, from the deal
  // (docs/plans/phase-5-deal-status.md §6.6); null when it didn't load.
  dealPosition: v.union(dealPositionValidator, v.null()),
  dealSystemLoss: v.union(systemLossReasonValidator, v.null()),
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

type BookedCall = {
  meeting: Doc<"meetings">;
  credit: BookingCredit & { dmCloserId: Id<"dmClosers"> };
};

// The details list is the DM closer table's bookings, the population of the
// Overview's DM closer machinery (buildDmCloserEfficiencyRows): first
// bookings (anything but a follow_up) whose createdAt falls in the window and
// whose booking rows name a DM closer. Team-only bookings count toward their
// team's goal but are not listed here.
function isFirstBooking(meeting: Doc<"meetings">) {
  return meeting.callClassification !== "follow_up";
}

function bookedCall(
  meeting: Doc<"meetings">,
  credit: BookingCredit | undefined,
  dmCloserId: Id<"dmClosers"> | undefined,
): BookedCall | null {
  if (!credit?.dmCloserId) return null;
  if (dmCloserId !== undefined && credit.dmCloserId !== dmCloserId) return null;
  return { meeting, credit: { ...credit, dmCloserId: credit.dmCloserId } };
}

/** Each deal's DM team and DM closer rows, keyed by booking. */
async function bookingCreditsForDeals(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  opportunityIds: Id<"opportunities">[],
) {
  const rows = await Promise.all(
    opportunityIds.flatMap((opportunityId) =>
      (["dm_team", "dm_closer"] as const).map((role) =>
        attributionsForDeal(ctx, tenantId, opportunityId, role),
      ),
    ),
  );
  return bookingCreditsByMeeting(rows.flat());
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
  return { start, end };
}

function compareLabels(left: string, right: string) {
  return left.localeCompare(right, undefined, { sensitivity: "base" });
}

async function enrichBookedCallRows(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  bookedCalls: BookedCall[],
) {
  const meetings = bookedCalls.map((call) => call.meeting);
  const opportunityIds = uniqueIds(meetings.map((m) => m.opportunityId));
  const opportunities = await Promise.all(
    opportunityIds.map((id) => ctx.db.get("opportunities", id)),
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
  const teamIds = uniqueIds(bookedCalls.map((call) => call.credit.teamId));
  const dmCloserIds = uniqueIds(bookedCalls.map((call) => call.credit.dmCloserId));

  const [leads, teams, dmClosers] = await Promise.all([
    Promise.all(leadIds.map((id) => ctx.db.get("leads", id))),
    Promise.all(teamIds.map((id) => ctx.db.get("attributionTeams", id))),
    Promise.all(dmCloserIds.map((id) => ctx.db.get("dmClosers", id))),
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

  return bookedCalls.map(({ meeting, credit }) => {
    const opportunity = opportunityById.get(meeting.opportunityId) ?? null;
    const lead = opportunity ? (leadById.get(opportunity.leadId) ?? null) : null;
    const team = credit.teamId ? (teamById.get(credit.teamId) ?? null) : null;
    const dmCloser = dmCloserById.get(credit.dmCloserId) ?? null;
    const fallbackLeadName = meeting.leadName?.trim();
    const deal = opportunity ? dealLabelOf(opportunity) : null;

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
      dealPosition: deal?.position ?? null,
      dealSystemLoss: deal?.systemLoss ?? null,
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
      attributionTeamId: credit.teamId ?? null,
      attributionTeamLabel: team?.displayName ?? null,
      dmCloserId: credit.dmCloserId,
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

    const range = deriveOverviewRange(args.range, Date.now());

    // Same machinery as the Overview's Top DM Closers section: one bounded
    // meetings read (by_tenantId_and_createdAt over the business-day UTC
    // window) for the first bookings, and the dm_team and dm_closer rows over
    // the same window for their credit. Scheduled hours come from
    // loadDmCloserScheduledHoursForRange inside.
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
      if (isRangeCapErrorMessage(message)) {
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
    const { rows, truncated, bookedByTeam, teamOnlyBooked } = builderResult;
    if (truncated) {
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
    // The DM closer table and its total count DM-closer bookings only.
    const totalBooked = rows.reduce((sum, row) => sum + row.booked, 0);

    const [registryCloserScan, teamScan] = await Promise.all([
      readLiveQueryRows(
        ctx.db
          .query("dmClosers")
          .withIndex("by_tenantId_and_teamId", (q) =>
            q.eq("tenantId", tenantId),
          ),
        DM_CLOSER_REGISTRY_LIMIT,
      ),
      readLiveQueryRows(
        ctx.db
          .query("attributionTeams")
          .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId)),
        TEAM_REGISTRY_LIMIT,
      ),
    ]);
    const registryClosers = registryCloserScan.rows;
    const teams = teamScan.rows;

    const closerById = new Map(
      registryClosers.map((closer) => [closer._id, closer]),
    );
    if (
      registryCloserScan.capped ||
      teamScan.capped
    ) {
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
    // Rows can reference closers beyond the registry cap; fetch the misses
    // individually (bounded by rows.length).
    const missingCloserScan = await readLiveDocuments(
      rows
        .map((row) => row.dmCloserId)
        .filter((id) => !closerById.has(id)),
      async (id) => await ctx.db.get("dmClosers", id),
    );
    if (missingCloserScan.capped) {
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
    for (const closer of missingCloserScan.rows) {
      if (closer && closer.tenantId === tenantId) {
        closerById.set(closer._id, closer);
      }
    }

    const linkedUserIds = uniqueIds(
      rows.map((row) => closerById.get(row.dmCloserId)?.userId),
    );
    const linkedUserScan = await readLiveDocuments(
      linkedUserIds,
      async (id) => await ctx.db.get("users", id),
    );
    if (linkedUserScan.capped) {
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
    const linkedUserById = new Map(
      linkedUserScan.rows
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

    // Per-team goal: dailyQuota x business days in range. A team's progress
    // is the first bookings its dm_team row names, with or without a DM
    // closer (D9).
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
        // The DM-closer bookings plus the team-only ones, which count toward
        // their team's goal but no DM closer (D9).
        progress: totalBooked + teamOnlyBooked,
        businessDayCount: range.dayCount,
        teams: goalTeams,
      },
      window: {
        start: range.slackWindowStart,
        end: range.slackWindowEnd,
      },
      capped: false,
    };
  },
});

/**
 * Paginated bookings for the collapsible details list: the DM closer table's
 * population (first bookings by createdAt window whose rows name a DM
 * closer), newest booking first. Pass the dashboard's `window` as start/end
 * so both surfaces agree.
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

    const { start, end } = validateWindow(args.start, args.end);

    const result = await ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_createdAt", (q) =>
        q.eq("tenantId", tenantId).gte("createdAt", start).lt("createdAt", end),
      )
      .order("desc")
      .paginate({
        cursor: args.paginationOpts.cursor,
        numItems: Math.min(args.paginationOpts.numItems, 2),
        maximumRowsRead: 2,
        maximumBytesRead: LIVE_QUERY_BYTE_BUDGET,
      });

    // Follow-ups and bookings no DM closer row names are excluded post-read
    // within the page (there is no createdAt index carrying those
    // dimensions), so pages can come back shorter than numItems; the cursor
    // stays correct. A page holds at most two meetings, so their rows are
    // read by meeting.
    const firstBookings = result.page.filter(isFirstBooking);
    const credits = await Promise.all(
      firstBookings.map((meeting) =>
        bookingCreditForMeeting(ctx, tenantId, meeting._id),
      ),
    );
    const bookedCalls = firstBookings
      .map((meeting, index) =>
        bookedCall(meeting, credits[index], args.dmCloserId),
      )
      .filter(isNonNull);

    return {
      page: await enrichBookedCallRows(ctx, tenantId, bookedCalls),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
      splitCursor: result.splitCursor,
      pageStatus: result.pageStatus,
    };
  },
});

/**
 * Search bookings by lead/prospect name for the collapsible details list.
 * Uses the opportunitySearch projection (searchText embeds the lead's search
 * text), then follows by_opportunityId_and_scheduledAt to the meetings and
 * post-filters to the booked-call window. Credit comes from each deal's
 * dm_team and dm_closer rows, two reads per deal rather than one per meeting.
 * Bounded fan-out, ~50 rows max.
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

    const firstBookings = meetingsPerOpportunity
      .flat()
      .filter((meeting) => meeting.tenantId === tenantId)
      .filter((meeting) => meeting.createdAt >= start && meeting.createdAt < end)
      .filter(isFirstBooking);
    const credits = await bookingCreditsForDeals(
      ctx,
      tenantId,
      uniqueIds(firstBookings.map((meeting) => meeting.opportunityId)),
    );
    const bookedCalls = firstBookings
      .map((meeting) =>
        bookedCall(meeting, credits.get(meeting._id), args.dmCloserId),
      )
      .filter(isNonNull)
      .sort((left, right) => right.meeting.createdAt - left.meeting.createdAt)
      .slice(0, SEARCH_RESULT_LIMIT);

    return await enrichBookedCallRows(ctx, tenantId, bookedCalls);
  },
});
