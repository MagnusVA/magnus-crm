import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query } from "../_generated/server";
import type { QueryCtx } from "../_generated/server";
import { bookingCreditForMeeting } from "../lib/attribution/dealAttributions";
import { leadDisplayFromShape } from "../lib/leadDisplay";
import { LIVE_QUERY_BYTE_BUDGET } from "../lib/liveQueryBounds";
import {
  dmCloserMemberIdentity,
  slackMemberIdentity,
  unknownMemberIdentity,
  userMemberIdentity,
} from "../lib/memberIdentity";
import { dealLabelOf } from "../opportunities/stageLabels";
import { requireTenantUser } from "../requireTenantUser";

const meetingStatusValidator = v.union(
  v.literal("scheduled"),
  v.literal("completed"),
  v.literal("canceled"),
  v.literal("no_show"),
);

type MeetingStatus = Doc<"meetings">["status"];

type PhoneSalesFilterArgs = {
  tenantId: Id<"tenants">;
  assignedCloserId?: Id<"users">;
  bookingProgramId?: Id<"tenantPrograms">;
  soldProgramId?: Id<"tenantPrograms">;
  meetingStatus?: MeetingStatus;
  scheduledFrom?: number;
  scheduledTo?: number;
};

function assertSinglePhoneSalesPrimaryFilter(args: PhoneSalesFilterArgs) {
  const primaryFilterCount = [
    args.assignedCloserId,
    args.bookingProgramId,
    args.soldProgramId,
    args.meetingStatus,
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

export async function enrichPhoneSalesRows(
  ctx: QueryCtx,
  meetings: Doc<"meetings">[],
) {
  const opportunityIds = [...new Set(meetings.map((meeting) => meeting.opportunityId))];
  const closerIds = [...new Set(meetings.map((meeting) => meeting.assignedCloserId))];
  // Each meeting is labeled from its own booking's rows, so a follow-up
  // booked through another DM closer shows that one.
  const credits = await Promise.all(
    meetings.map((meeting) => bookingCreditForMeeting(ctx, meeting.tenantId, meeting._id)),
  );
  const teamIds = [
    ...new Set(credits.map((credit) => credit.teamId).filter((id): id is Id<"attributionTeams"> => Boolean(id))),
  ];
  const dmCloserIds = [
    ...new Set(credits.map((credit) => credit.dmCloserId).filter((id): id is Id<"dmClosers"> => Boolean(id))),
  ];

  const [opportunities, closers, teams, dmClosers] = await Promise.all([
    Promise.all(opportunityIds.map((id) => ctx.db.get("opportunities", id))),
    Promise.all(closerIds.map((id) => ctx.db.get("users", id))),
    Promise.all(teamIds.map((id) => ctx.db.get("attributionTeams", id))),
    Promise.all(dmCloserIds.map((id) => ctx.db.get("dmClosers", id))),
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
    Promise.all(leadIds.map((id) => ctx.db.get("leads", id))),
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

  return await Promise.all(meetings.map(async (meeting, index) => {
    const opportunity = opportunityById.get(meeting.opportunityId);
    const lead = opportunity ? leadById.get(opportunity.leadId) : undefined;
    const closer = closerById.get(meeting.assignedCloserId);
    const credit = credits[index];
    const team = credit.teamId ? teamById.get(credit.teamId) : undefined;
    const dmCloser = credit.dmCloserId ? dmCloserById.get(credit.dmCloserId) : undefined;
    const slackUserId = opportunity?.qualifiedBy?.slackUserId;
    const slackUser = slackUserId
      ? slackUserBySlackId.get(slackUserId)
      : undefined;
    const linkedDmCloserUserCandidate =
      dmCloser?.userId
        ? (closerById.get(dmCloser.userId) ?? await ctx.db.get("users", dmCloser.userId))
        : undefined;
    const linkedDmCloserUser =
      linkedDmCloserUserCandidate?.tenantId === tenantId
        ? linkedDmCloserUserCandidate
        : undefined;
    const deal = opportunity ? dealLabelOf(opportunity) : null;
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
      // The deal's position and the loss the system wrote on it, from the
      // deal (docs/plans/phase-5-deal-status.md §6.6).
      dealPosition: deal?.position ?? null,
      dealSystemLoss: deal?.systemLoss ?? null,
      bookingProgramName: meeting.bookingProgramName ?? opportunity?.firstBookingProgramName ?? null,
      bookingProgramMappingStatus:
        meeting.bookingProgramMappingStatus ??
        opportunity?.firstBookingProgramMappingStatus ??
        null,
      soldProgramName: meeting.soldProgramName ?? opportunity?.soldProgramName ?? null,
      assignedCloserName: closer?.fullName ?? closer?.email ?? "Unknown closer",
      assignedCloser: closer
        ? await userMemberIdentity(ctx, closer)
        : unknownMemberIdentity("Unknown closer", "unknown"),
      attributionResolution: meeting.attributionResolution ?? "none",
      attributionTeamName: team?.displayName ?? null,
      dmCloserName: dmCloser?.displayName ?? null,
      dmCloser: dmCloser
        ? await dmCloserMemberIdentity(ctx, dmCloser, linkedDmCloserUser)
        : null,
      slackUserId: slackUserId ?? null,
      slackUserLabel: slackUserId
        ? slackUserLabel(slackUser) ?? slackUserId
        : null,
      slackUser: slackUserId
        ? slackMemberIdentity(slackUser, `slack:${slackUserId}`)
        : null,
    };
  }));
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
      scheduledFrom: args.scheduledFrom,
      scheduledTo: args.scheduledTo,
    })
      .order("desc")
      .paginate({
        cursor: args.paginationOpts.cursor,
        numItems: Math.min(args.paginationOpts.numItems, 1),
        maximumRowsRead: 1,
        maximumBytesRead: LIVE_QUERY_BYTE_BUDGET,
      });

    return {
      ...result,
      page: await enrichPhoneSalesRows(ctx, result.page),
    };
  },
});
