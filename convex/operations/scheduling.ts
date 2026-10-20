import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query } from "../_generated/server";
import type { QueryCtx } from "../_generated/server";
import { leadDisplayFromShape } from "../lib/leadDisplay";
import {
  slackMemberIdentity,
  unknownMemberIdentity,
  userMemberIdentity,
} from "../lib/memberIdentity";
import { requireTenantUser } from "../requireTenantUser";
import { loadQualificationRowCredits } from "./qualificationCredit";

type SchedulingFilterArgs = {
  tenantId: Id<"tenants">;
  bookingProgramId?: Id<"tenantPrograms">;
  soldProgramId?: Id<"tenantPrograms">;
  slackUserId?: string;
  assignedCloserId?: Id<"users">;
  scheduledFrom?: number;
  scheduledTo?: number;
};

function assertSingleSchedulingPrimaryFilter(args: SchedulingFilterArgs) {
  const primaryFilterCount = [
    args.bookingProgramId,
    args.soldProgramId,
    args.slackUserId,
    args.assignedCloserId,
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
  const userIds = [
    ...new Set(rows.map((row) => row.assignedCloserId).filter((id): id is Id<"users"> => Boolean(id))),
  ];
  const slackUserIds = [...new Set(rows.map((row) => row.slackUserId))];

  const [leads, users, slackUsers, creditFor] = await Promise.all([
    Promise.all(leadIds.map((id) => ctx.db.get("leads", id))),
    Promise.all(userIds.map((id) => ctx.db.get("users", id))),
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
    loadQualificationRowCredits(ctx, tenantId, rows),
  ]);

  const leadById = new Map(leads.filter(isNonNull).map((lead) => [lead._id, lead]));
  const userById = new Map(users.filter(isNonNull).map((user) => [user._id, user]));
  const slackUserBySlackId = new Map(slackUsers.filter(isNonNull).map((user) => [user.slackUserId, user]));

  return await Promise.all(rows.map(async (row) => {
    const lead = row.leadId ? leadById.get(row.leadId) : undefined;
    const assignedCloser = row.assignedCloserId ? userById.get(row.assignedCloserId) : undefined;
    const slackUser = slackUserBySlackId.get(row.slackUserId);

    return {
      ...row,
      // The deal's first booking credit, as in the qualifications queue.
      ...creditFor(row),
      leadLabel: lead
        ? leadDisplayFromShape({
            fullName: lead.fullName,
            email: lead.email,
            leadId: lead._id,
          })
        : "Unknown lead",
      slackUserLabel: slackUserLabel(slackUserBySlackId.get(row.slackUserId)),
      slackUser: slackMemberIdentity(slackUser, `slack:${row.slackUserId}`),
      assignedCloserName: assignedCloser?.fullName ?? assignedCloser?.email,
      assignedCloser: assignedCloser
        ? await userMemberIdentity(ctx, assignedCloser)
        : unknownMemberIdentity("Unassigned", "unknown"),
    };
  }));
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
