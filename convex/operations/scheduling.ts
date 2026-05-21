import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query } from "../_generated/server";
import type { QueryCtx } from "../_generated/server";
import { leadDisplayFromShape } from "../lib/leadDisplay";
import { requireTenantUser } from "../requireTenantUser";

type SchedulingFilterArgs = {
  tenantId: Id<"tenants">;
  bookingProgramId?: Id<"tenantPrograms">;
  soldProgramId?: Id<"tenantPrograms">;
  slackUserId?: string;
  assignedCloserId?: Id<"users">;
  attributionTeamId?: Id<"attributionTeams">;
  dmCloserId?: Id<"dmClosers">;
  scheduledFrom?: number;
  scheduledTo?: number;
};

function assertSingleSchedulingPrimaryFilter(args: SchedulingFilterArgs) {
  const primaryFilterCount = [
    args.bookingProgramId,
    args.soldProgramId,
    args.slackUserId,
    args.assignedCloserId,
    args.attributionTeamId,
    args.dmCloserId,
  ].filter(Boolean).length;

  if (primaryFilterCount > 1) {
    throw new Error("Select only one primary scheduling filter at a time.");
  }
}

function schedulingRowsQuery(ctx: QueryCtx, args: SchedulingFilterArgs) {
  assertSingleSchedulingPrimaryFilter(args);
  const from = args.scheduledFrom ?? 0;

  if (args.bookingProgramId) {
    const bookingProgramId = args.bookingProgramId;
    return ctx.db
      .query("operationsQualificationRows")
      .withIndex("by_tenantId_and_bookingProgramId_and_firstMeetingAt", (q) => {
        const ranged = q
          .eq("tenantId", args.tenantId)
          .eq("bookingProgramId", bookingProgramId)
          .gte("firstMeetingAt", from);
        return args.scheduledTo === undefined
          ? ranged
          : ranged.lt("firstMeetingAt", args.scheduledTo);
      });
  }

  if (args.soldProgramId) {
    const soldProgramId = args.soldProgramId;
    return ctx.db
      .query("operationsQualificationRows")
      .withIndex("by_tenantId_and_soldProgramId_and_firstMeetingAt", (q) => {
        const ranged = q
          .eq("tenantId", args.tenantId)
          .eq("soldProgramId", soldProgramId)
          .gte("firstMeetingAt", from);
        return args.scheduledTo === undefined
          ? ranged
          : ranged.lt("firstMeetingAt", args.scheduledTo);
      });
  }

  if (args.slackUserId) {
    const slackUserId = args.slackUserId;
    return ctx.db
      .query("operationsQualificationRows")
      .withIndex("by_tenantId_and_slackUserId_and_firstMeetingAt", (q) => {
        const ranged = q
          .eq("tenantId", args.tenantId)
          .eq("slackUserId", slackUserId)
          .gte("firstMeetingAt", from);
        return args.scheduledTo === undefined
          ? ranged
          : ranged.lt("firstMeetingAt", args.scheduledTo);
      });
  }

  if (args.assignedCloserId) {
    const assignedCloserId = args.assignedCloserId;
    return ctx.db
      .query("operationsQualificationRows")
      .withIndex("by_tenantId_and_assignedCloserId_and_firstMeetingAt", (q) => {
        const ranged = q
          .eq("tenantId", args.tenantId)
          .eq("assignedCloserId", assignedCloserId)
          .gte("firstMeetingAt", from);
        return args.scheduledTo === undefined
          ? ranged
          : ranged.lt("firstMeetingAt", args.scheduledTo);
      });
  }

  if (args.attributionTeamId) {
    const attributionTeamId = args.attributionTeamId;
    return ctx.db
      .query("operationsQualificationRows")
      .withIndex("by_tenantId_and_attributionTeamId_and_firstMeetingAt", (q) => {
        const ranged = q
          .eq("tenantId", args.tenantId)
          .eq("attributionTeamId", attributionTeamId)
          .gte("firstMeetingAt", from);
        return args.scheduledTo === undefined
          ? ranged
          : ranged.lt("firstMeetingAt", args.scheduledTo);
      });
  }

  if (args.dmCloserId) {
    const dmCloserId = args.dmCloserId;
    return ctx.db
      .query("operationsQualificationRows")
      .withIndex("by_tenantId_and_dmCloserId_and_firstMeetingAt", (q) => {
        const ranged = q
          .eq("tenantId", args.tenantId)
          .eq("dmCloserId", dmCloserId)
          .gte("firstMeetingAt", from);
        return args.scheduledTo === undefined
          ? ranged
          : ranged.lt("firstMeetingAt", args.scheduledTo);
      });
  }

  return ctx.db
    .query("operationsQualificationRows")
    .withIndex("by_tenantId_and_firstMeetingAt", (q) => {
      const ranged = q.eq("tenantId", args.tenantId).gte("firstMeetingAt", from);
      return args.scheduledTo === undefined
        ? ranged
        : ranged.lt("firstMeetingAt", args.scheduledTo);
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

async function enrichSchedulingRows(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  rows: Doc<"operationsQualificationRows">[],
) {
  const leadIds = [
    ...new Set(rows.map((row) => row.leadId).filter((id): id is Id<"leads"> => Boolean(id))),
  ];
  const teamIds = [
    ...new Set(rows.map((row) => row.attributionTeamId).filter((id): id is Id<"attributionTeams"> => Boolean(id))),
  ];
  const dmCloserIds = [
    ...new Set(rows.map((row) => row.dmCloserId).filter((id): id is Id<"dmClosers"> => Boolean(id))),
  ];
  const userIds = [
    ...new Set(rows.map((row) => row.assignedCloserId).filter((id): id is Id<"users"> => Boolean(id))),
  ];
  const slackUserIds = [...new Set(rows.map((row) => row.slackUserId))];

  const [leads, teams, dmClosers, users, slackUsers] = await Promise.all([
    Promise.all(leadIds.map((id) => ctx.db.get(id))),
    Promise.all(teamIds.map((id) => ctx.db.get(id))),
    Promise.all(dmCloserIds.map((id) => ctx.db.get(id))),
    Promise.all(userIds.map((id) => ctx.db.get(id))),
    Promise.all(
      slackUserIds.map((slackUserId) =>
        ctx.db
          .query("slackUsers")
          .withIndex("by_tenantId_and_slackUserId", (q) =>
            q.eq("tenantId", tenantId).eq("slackUserId", slackUserId),
          )
          .unique(),
      ),
    ),
  ]);

  const leadById = new Map(leads.filter(isNonNull).map((lead) => [lead._id, lead]));
  const teamById = new Map(teams.filter(isNonNull).map((team) => [team._id, team]));
  const dmCloserById = new Map(dmClosers.filter(isNonNull).map((closer) => [closer._id, closer]));
  const userById = new Map(users.filter(isNonNull).map((user) => [user._id, user]));
  const slackUserBySlackId = new Map(slackUsers.filter(isNonNull).map((user) => [user.slackUserId, user]));

  return rows.map((row) => {
    const lead = row.leadId ? leadById.get(row.leadId) : undefined;
    const team = row.attributionTeamId ? teamById.get(row.attributionTeamId) : undefined;
    const dmCloser = row.dmCloserId ? dmCloserById.get(row.dmCloserId) : undefined;
    const assignedCloser = row.assignedCloserId ? userById.get(row.assignedCloserId) : undefined;

    return {
      ...row,
      leadLabel: lead
        ? leadDisplayFromShape({
            fullName: lead.fullName,
            email: lead.email,
            leadId: lead._id,
          })
        : "Unknown lead",
      slackUserLabel: slackUserLabel(slackUserBySlackId.get(row.slackUserId)),
      attributionTeamName: team?.displayName,
      dmCloserName: dmCloser?.displayName,
      assignedCloserName: assignedCloser?.fullName ?? assignedCloser?.email,
    };
  });
}

export const listSchedulingQueue = query({
  args: {
    paginationOpts: paginationOptsValidator,
    scheduledFrom: v.optional(v.number()),
    scheduledTo: v.optional(v.number()),
    bookingProgramId: v.optional(v.id("tenantPrograms")),
    soldProgramId: v.optional(v.id("tenantPrograms")),
    slackUserId: v.optional(v.string()),
    assignedCloserId: v.optional(v.id("users")),
    attributionTeamId: v.optional(v.id("attributionTeams")),
    dmCloserId: v.optional(v.id("dmClosers")),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const result = await schedulingRowsQuery(ctx, {
      tenantId,
      bookingProgramId: args.bookingProgramId,
      soldProgramId: args.soldProgramId,
      slackUserId: args.slackUserId,
      assignedCloserId: args.assignedCloserId,
      attributionTeamId: args.attributionTeamId,
      dmCloserId: args.dmCloserId,
      scheduledFrom: args.scheduledFrom,
      scheduledTo: args.scheduledTo,
    })
      .order("desc")
      .paginate(args.paginationOpts);

    return {
      ...result,
      page: await enrichSchedulingRows(ctx, tenantId, result.page),
    };
  },
});
