import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query } from "../_generated/server";
import type { QueryCtx } from "../_generated/server";
import { leadDisplayFromShape } from "../lib/leadDisplay";
import { opportunityStatusValidator } from "../opportunities/validators";
import { requireTenantUser } from "../requireTenantUser";
import { meetingDayKey } from "./meetingStats";

const meetingStatusValidator = v.union(
  v.literal("scheduled"),
  v.literal("in_progress"),
  v.literal("completed"),
  v.literal("canceled"),
  v.literal("no_show"),
  v.literal("meeting_overran"),
);

const PHONE_SALES_COUNTED_STATUSES = [
  "scheduled",
  "in_progress",
  "completed",
  "no_show",
  "meeting_overran",
] as const;

type MeetingStatus = Doc<"meetings">["status"];

type PhoneSalesFilterArgs = {
  tenantId: Id<"tenants">;
  assignedCloserId?: Id<"users">;
  bookingProgramId?: Id<"tenantPrograms">;
  soldProgramId?: Id<"tenantPrograms">;
  meetingStatus?: MeetingStatus;
  opportunityStatus?: Doc<"opportunities">["status"];
  attributionTeamId?: Id<"attributionTeams">;
  dmCloserId?: Id<"dmClosers">;
  scheduledFrom?: number;
  scheduledTo?: number;
};

function assertSinglePhoneSalesPrimaryFilter(args: PhoneSalesFilterArgs) {
  const primaryFilterCount = [
    args.assignedCloserId,
    args.bookingProgramId,
    args.soldProgramId,
    args.meetingStatus,
    args.opportunityStatus,
    args.attributionTeamId,
    args.dmCloserId,
  ].filter(Boolean).length;

  if (primaryFilterCount > 1) {
    throw new Error("Select only one primary phone-sales filter at a time.");
  }
}

function phoneSalesMeetingsQuery(ctx: QueryCtx, args: PhoneSalesFilterArgs) {
  assertSinglePhoneSalesPrimaryFilter(args);
  const from = args.scheduledFrom ?? 0;

  if (args.assignedCloserId) {
    const assignedCloserId = args.assignedCloserId;
    return ctx.db.query("meetings").withIndex(
      "by_tenantId_and_assignedCloserId_and_scheduledAt",
      (q) => {
        const ranged = q
          .eq("tenantId", args.tenantId)
          .eq("assignedCloserId", assignedCloserId)
          .gte("scheduledAt", from);
        return args.scheduledTo === undefined
          ? ranged
          : ranged.lt("scheduledAt", args.scheduledTo);
      },
    );
  }

  if (args.bookingProgramId) {
    const bookingProgramId = args.bookingProgramId;
    return ctx.db.query("meetings").withIndex(
      "by_tenantId_and_bookingProgramId_and_scheduledAt",
      (q) => {
        const ranged = q
          .eq("tenantId", args.tenantId)
          .eq("bookingProgramId", bookingProgramId)
          .gte("scheduledAt", from);
        return args.scheduledTo === undefined
          ? ranged
          : ranged.lt("scheduledAt", args.scheduledTo);
      },
    );
  }

  if (args.soldProgramId) {
    const soldProgramId = args.soldProgramId;
    return ctx.db.query("meetings").withIndex(
      "by_tenantId_and_soldProgramId_and_scheduledAt",
      (q) => {
        const ranged = q
          .eq("tenantId", args.tenantId)
          .eq("soldProgramId", soldProgramId)
          .gte("scheduledAt", from);
        return args.scheduledTo === undefined
          ? ranged
          : ranged.lt("scheduledAt", args.scheduledTo);
      },
    );
  }

  if (args.meetingStatus) {
    const meetingStatus = args.meetingStatus;
    return ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_status_and_scheduledAt", (q) => {
        const ranged = q
          .eq("tenantId", args.tenantId)
          .eq("status", meetingStatus)
          .gte("scheduledAt", from);
        return args.scheduledTo === undefined
          ? ranged
          : ranged.lt("scheduledAt", args.scheduledTo);
      });
  }

  if (args.opportunityStatus) {
    const opportunityStatus = args.opportunityStatus;
    return ctx.db.query("meetings").withIndex(
      "by_tenantId_and_opportunityStatus_and_scheduledAt",
      (q) => {
        const ranged = q
          .eq("tenantId", args.tenantId)
          .eq("opportunityStatus", opportunityStatus)
          .gte("scheduledAt", from);
        return args.scheduledTo === undefined
          ? ranged
          : ranged.lt("scheduledAt", args.scheduledTo);
      },
    );
  }

  if (args.attributionTeamId) {
    const attributionTeamId = args.attributionTeamId;
    return ctx.db.query("meetings").withIndex(
      "by_tenantId_and_attributionTeamId_and_scheduledAt",
      (q) => {
        const ranged = q
          .eq("tenantId", args.tenantId)
          .eq("attributionTeamId", attributionTeamId)
          .gte("scheduledAt", from);
        return args.scheduledTo === undefined
          ? ranged
          : ranged.lt("scheduledAt", args.scheduledTo);
      },
    );
  }

  if (args.dmCloserId) {
    const dmCloserId = args.dmCloserId;
    return ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_dmCloserId_and_scheduledAt", (q) => {
        const ranged = q
          .eq("tenantId", args.tenantId)
          .eq("dmCloserId", dmCloserId)
          .gte("scheduledAt", from);
        return args.scheduledTo === undefined
          ? ranged
          : ranged.lt("scheduledAt", args.scheduledTo);
      });
  }

  return ctx.db
    .query("meetings")
    .withIndex("by_tenantId_and_scheduledAt", (q) => {
      const ranged = q.eq("tenantId", args.tenantId).gte("scheduledAt", from);
      return args.scheduledTo === undefined
        ? ranged
        : ranged.lt("scheduledAt", args.scheduledTo);
    });
}

function isNonNull<T>(value: T | null): value is T {
  return value !== null;
}

function slackUserLabel(user: Doc<"slackUsers"> | null | undefined) {
  return (
    user?.displayName?.trim() ||
    user?.realName?.trim() ||
    user?.username?.trim() ||
    user?.slackUserId
  );
}

async function enrichPhoneSalesRows(ctx: QueryCtx, meetings: Doc<"meetings">[]) {
  const opportunityIds = [...new Set(meetings.map((meeting) => meeting.opportunityId))];
  const closerIds = [...new Set(meetings.map((meeting) => meeting.assignedCloserId))];
  const teamIds = [
    ...new Set(meetings.map((meeting) => meeting.attributionTeamId).filter((id): id is Id<"attributionTeams"> => Boolean(id))),
  ];
  const dmCloserIds = [
    ...new Set(meetings.map((meeting) => meeting.dmCloserId).filter((id): id is Id<"dmClosers"> => Boolean(id))),
  ];

  const [opportunities, closers, teams, dmClosers] = await Promise.all([
    Promise.all(opportunityIds.map((id) => ctx.db.get(id))),
    Promise.all(closerIds.map((id) => ctx.db.get(id))),
    Promise.all(teamIds.map((id) => ctx.db.get(id))),
    Promise.all(dmCloserIds.map((id) => ctx.db.get(id))),
  ]);

  const opportunityById = new Map(
    opportunities.filter(isNonNull).map((opportunity) => [opportunity._id, opportunity]),
  );
  const leadIds = [
    ...new Set(opportunities.filter(isNonNull).map((opportunity) => opportunity.leadId)),
  ];
  const slackUserIds = [
    ...new Set(
      opportunities
        .filter(isNonNull)
        .map((opportunity) => opportunity.qualifiedBy?.slackUserId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const tenantId = meetings[0]?.tenantId;

  const [leads, slackUsers] = await Promise.all([
    Promise.all(leadIds.map((id) => ctx.db.get(id))),
    tenantId
      ? Promise.all(
          slackUserIds.map((slackUserId) =>
            ctx.db
              .query("slackUsers")
              .withIndex("by_tenantId_and_slackUserId", (q) =>
                q.eq("tenantId", tenantId).eq("slackUserId", slackUserId),
              )
              .unique(),
          ),
        )
      : Promise.resolve([]),
  ]);

  const closerById = new Map(closers.filter(isNonNull).map((closer) => [closer._id, closer]));
  const leadById = new Map(leads.filter(isNonNull).map((lead) => [lead._id, lead]));
  const teamById = new Map(teams.filter(isNonNull).map((team) => [team._id, team]));
  const dmCloserById = new Map(dmClosers.filter(isNonNull).map((closer) => [closer._id, closer]));
  const slackUserBySlackId = new Map(slackUsers.filter(isNonNull).map((user) => [user.slackUserId, user]));

  return meetings.map((meeting) => {
    const opportunity = opportunityById.get(meeting.opportunityId);
    const lead = opportunity ? leadById.get(opportunity.leadId) : undefined;
    const closer = closerById.get(meeting.assignedCloserId);
    const team = meeting.attributionTeamId ? teamById.get(meeting.attributionTeamId) : undefined;
    const dmCloser = meeting.dmCloserId ? dmCloserById.get(meeting.dmCloserId) : undefined;
    const slackUserId = opportunity?.qualifiedBy?.slackUserId;
    const leadName = lead
      ? leadDisplayFromShape({
          fullName: lead.fullName,
          email: lead.email,
          leadId: lead._id,
        })
      : meeting.leadName ?? "Unknown lead";

    return {
      meetingId: meeting._id,
      opportunityId: meeting.opportunityId,
      leadId: lead?._id ?? null,
      leadName,
      scheduledAt: meeting.scheduledAt,
      meetingStatus: meeting.status,
      opportunityStatus: meeting.opportunityStatus ?? opportunity?.status ?? null,
      bookingProgramName: meeting.bookingProgramName ?? opportunity?.firstBookingProgramName ?? null,
      bookingProgramMappingStatus:
        meeting.bookingProgramMappingStatus ??
        opportunity?.firstBookingProgramMappingStatus ??
        null,
      soldProgramName: meeting.soldProgramName ?? opportunity?.soldProgramName ?? null,
      assignedCloserName: closer?.fullName ?? closer?.email ?? "Unknown closer",
      attributionResolution: meeting.attributionResolution ?? "none",
      attributionTeamName: team?.displayName ?? null,
      dmCloserName: dmCloser?.displayName ?? null,
      slackUserId: slackUserId ?? null,
      slackUserLabel: slackUserId
        ? slackUserLabel(slackUserBySlackId.get(slackUserId)) ?? slackUserId
        : null,
    };
  });
}

function rowMatchesStatsFilter(
  row: Doc<"operationsMeetingDailyStats">,
  args: PhoneSalesFilterArgs,
) {
  if (args.bookingProgramId && row.bookingProgramId !== args.bookingProgramId) {
    return false;
  }
  if (args.soldProgramId && row.soldProgramId !== args.soldProgramId) {
    return false;
  }
  if (args.meetingStatus && row.meetingStatus !== args.meetingStatus) {
    return false;
  }
  if (args.opportunityStatus && row.opportunityStatus !== args.opportunityStatus) {
    return false;
  }
  if (args.attributionTeamId && row.attributionTeamId !== args.attributionTeamId) {
    return false;
  }
  if (args.dmCloserId && row.dmCloserId !== args.dmCloserId) {
    return false;
  }
  return true;
}

export const listPhoneSalesMeetings = query({
  args: {
    paginationOpts: paginationOptsValidator,
    closerId: v.optional(v.id("users")),
    bookingProgramId: v.optional(v.id("tenantPrograms")),
    soldProgramId: v.optional(v.id("tenantPrograms")),
    scheduledFrom: v.optional(v.number()),
    scheduledTo: v.optional(v.number()),
    meetingStatus: v.optional(meetingStatusValidator),
    opportunityStatus: v.optional(opportunityStatusValidator),
    attributionTeamId: v.optional(v.id("attributionTeams")),
    dmCloserId: v.optional(v.id("dmClosers")),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const result = await phoneSalesMeetingsQuery(ctx, {
      tenantId,
      assignedCloserId: args.closerId,
      bookingProgramId: args.bookingProgramId,
      soldProgramId: args.soldProgramId,
      meetingStatus: args.meetingStatus,
      opportunityStatus: args.opportunityStatus,
      attributionTeamId: args.attributionTeamId,
      dmCloserId: args.dmCloserId,
      scheduledFrom: args.scheduledFrom,
      scheduledTo: args.scheduledTo,
    })
      .order("desc")
      .paginate(args.paginationOpts);

    return {
      ...result,
      page: await enrichPhoneSalesRows(ctx, result.page),
    };
  },
});

export const getPhoneSalesStats = query({
  args: {
    closerId: v.optional(v.id("users")),
    scheduledFrom: v.number(),
    scheduledTo: v.number(),
    bookingProgramId: v.optional(v.id("tenantPrograms")),
    soldProgramId: v.optional(v.id("tenantPrograms")),
    meetingStatus: v.optional(meetingStatusValidator),
    opportunityStatus: v.optional(opportunityStatusValidator),
    attributionTeamId: v.optional(v.id("attributionTeams")),
    dmCloserId: v.optional(v.id("dmClosers")),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    assertSinglePhoneSalesPrimaryFilter({
      tenantId,
      assignedCloserId: args.closerId,
      bookingProgramId: args.bookingProgramId,
      soldProgramId: args.soldProgramId,
      meetingStatus: args.meetingStatus,
      opportunityStatus: args.opportunityStatus,
      attributionTeamId: args.attributionTeamId,
      dmCloserId: args.dmCloserId,
    });

    const startKey = meetingDayKey(args.scheduledFrom);
    const endExclusiveKey = meetingDayKey(args.scheduledTo);
    const rows = args.closerId
      ? await ctx.db
          .query("operationsMeetingDailyStats")
          .withIndex("by_tenantId_and_assignedCloserId_and_dayKey", (q) =>
            q
              .eq("tenantId", tenantId)
              .eq("assignedCloserId", args.closerId!)
              .gte("dayKey", startKey)
              .lt("dayKey", endExclusiveKey),
          )
          .take(1000)
      : await ctx.db
          .query("operationsMeetingDailyStats")
          .withIndex("by_tenantId_and_dayKey", (q) =>
            q
              .eq("tenantId", tenantId)
              .gte("dayKey", startKey)
              .lt("dayKey", endExclusiveKey),
          )
          .take(1000);

    const byStatus = new Map<MeetingStatus, number>();
    let won = 0;
    for (const row of rows) {
      if (!rowMatchesStatsFilter(row, {
        tenantId,
        assignedCloserId: args.closerId,
        bookingProgramId: args.bookingProgramId,
        soldProgramId: args.soldProgramId,
        meetingStatus: args.meetingStatus,
        opportunityStatus: args.opportunityStatus,
        attributionTeamId: args.attributionTeamId,
        dmCloserId: args.dmCloserId,
      })) {
        continue;
      }
      byStatus.set(row.meetingStatus, (byStatus.get(row.meetingStatus) ?? 0) + row.count);
      if (row.opportunityStatus === "payment_received") {
        won += row.count;
      }
    }

    const completed = byStatus.get("completed") ?? 0;
    const noShows = byStatus.get("no_show") ?? 0;

    return {
      scheduled: PHONE_SALES_COUNTED_STATUSES.reduce(
        (sum, status) => sum + (byStatus.get(status) ?? 0),
        0,
      ),
      completed,
      noShows,
      won,
      showRate: completed + noShows > 0 ? completed / (completed + noShows) : null,
      isPartial: rows.length >= 1000,
    };
  },
});
