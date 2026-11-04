import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { deleteTeamMemberIfUnused } from "../lib/teamMembers";

const PAGE_SIZE = 200;

const recordRoleValidator = v.union(
  v.literal("lead_gen"),
  v.literal("setter"),
  v.literal("dm_closer"),
);

/** The role record a row credits: a worker, a Slack user or a DM closer. */
function rowRecordKey(row: Doc<"dealAttributions">): string | undefined {
  switch (row.source.kind) {
    case "capture":
    case "respark":
      return row.source.workerId;
    case "slack_qualification":
      return row.source.slackUserId;
    case "booking_utm":
      return row.source.dmCloserId;
    default:
      return undefined;
  }
}

/**
 * Moves one role record's rows to its new team member, a page at a time
 * (docs/plans/phase-3-attribution.md §4.8). Linking a DM closer, Slack user
 * or lead gen worker to a login changes its team member without a merge, and
 * its earlier credit belongs to the same human. Other records that share the
 * old team member keep their rows.
 */
export const repointRoleRecordRows = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    role: recordRoleValidator,
    recordKey: v.string(),
    fromTeamMemberId: v.id("teamMembers"),
    intoTeamMemberId: v.id("teamMembers"),
    paginationOpts: v.optional(paginationOptsValidator),
    followCurrentOwner: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const intoTeamMemberId = args.followCurrentOwner
      ? await currentRoleOwner(ctx, args)
      : args.intoTeamMemberId;
    if (!intoTeamMemberId) return null;
    const page = await ctx.db
      .query("dealAttributions")
      .withIndex("by_tenantId_and_role_and_teamMemberId_and_meetingScheduledAt", (q) =>
        q
          .eq("tenantId", args.tenantId)
          .eq("role", args.role)
          .eq("teamMemberId", args.fromTeamMemberId),
      )
      .paginate(args.paginationOpts ?? { numItems: PAGE_SIZE, cursor: null });
    for (const row of page.page) {
      if (rowRecordKey(row) === args.recordKey) {
        await ctx.db.patch("dealAttributions", row._id, {
          teamMemberId: intoTeamMemberId,
        });
      }
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.attribution.teamMemberRepoint.repointRoleRecordRows, {
        ...args,
        paginationOpts: { numItems: PAGE_SIZE, cursor: page.continueCursor },
      });
    }
    if (page.isDone && args.role === "setter") {
      await ctx.scheduler.runAfter(0, internal.attribution.teamMemberRepoint.repointSlackEvents, {
        tenantId: args.tenantId, recordKey: args.recordKey,
        fromTeamMemberId: args.fromTeamMemberId, intoTeamMemberId,
        followCurrentOwner: args.followCurrentOwner,
      });
    } else if (page.isDone && intoTeamMemberId !== args.fromTeamMemberId) {
      await deleteTeamMemberIfUnused(ctx, args.tenantId, args.fromTeamMemberId);
    }
    return null;
  },
});


type RepointOwner = { tenantId: Id<"tenants">; role: "setter" | "lead_gen" | "dm_closer"; recordKey: string };
async function currentRoleOwner(ctx: MutationCtx, args: RepointOwner): Promise<Id<"teamMembers"> | null> {
  if (args.role === "setter") {
    const row = await ctx.db.query("slackUsers").withIndex("by_tenantId_and_slackUserId", q => q.eq("tenantId", args.tenantId).eq("slackUserId", args.recordKey)).unique();
    return row?.teamMemberId ?? null;
  }
  if (args.role === "lead_gen") {
    const id = ctx.db.normalizeId("leadGenWorkers", args.recordKey);
    const row = id ? await ctx.db.get("leadGenWorkers", id) : null;
    return row?.tenantId === args.tenantId ? row.teamMemberId ?? null : null;
  }
  const id = ctx.db.normalizeId("dmClosers", args.recordKey);
  const row = id ? await ctx.db.get("dmClosers", id) : null;
  return row?.tenantId === args.tenantId ? row.teamMemberId ?? null : null;
}

/** Resolve the setter from the qualification fact, never from a person's name. */
async function eventSlackUser(ctx: MutationCtx, event: Doc<"domainEvents">): Promise<string | null> {
  if (event.eventType === "lead.slack_qualified" && event.metadata) {
    let metadata: { qualificationEventId?: unknown };
    try { metadata = JSON.parse(event.metadata); } catch { return null; }
    if (!metadata || typeof metadata.qualificationEventId !== "string") return null;
    const id = ctx.db.normalizeId("slackQualificationEvents", metadata.qualificationEventId);
    const qualification = id ? await ctx.db.get("slackQualificationEvents", id) : null;
    return qualification?.tenantId === event.tenantId ? qualification.slackUserId : null;
  }
  if (event.eventType === "opportunity.created" && event.source === "pipeline" && event.entityType === "opportunity") {
    const id = ctx.db.normalizeId("opportunities", event.entityId);
    const deal = id ? await ctx.db.get("opportunities", id) : null;
    return deal?.tenantId === event.tenantId && deal.source === "slack_qualified" ? deal.qualifiedBy?.slackUserId ?? null : null;
  }
  return null;
}

/** Role-scoped event moves leave other roles on a shared member untouched. */
export const repointSlackEvents = internalMutation({
  args: {
    tenantId: v.id("tenants"), recordKey: v.string(), fromTeamMemberId: v.id("teamMembers"), intoTeamMemberId: v.id("teamMembers"),
    paginationOpts: v.optional(paginationOptsValidator), followCurrentOwner: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const intoTeamMemberId = args.followCurrentOwner ? await currentRoleOwner(ctx, { ...args, role: "setter" }) : args.intoTeamMemberId;
    if (!intoTeamMemberId || intoTeamMemberId === args.fromTeamMemberId) return null;
    const page = await ctx.db.query("domainEvents")
      .withIndex("by_tenantId_and_teamMemberId_and_occurredAt", q => q.eq("tenantId", args.tenantId).eq("teamMemberId", args.fromTeamMemberId))
      .paginate(args.paginationOpts ?? { numItems: PAGE_SIZE, cursor: null });
    for (const event of page.page) {
      if (await eventSlackUser(ctx, event) === args.recordKey) await ctx.db.patch("domainEvents", event._id, { teamMemberId: intoTeamMemberId });
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.attribution.teamMemberRepoint.repointSlackEvents, {
      ...args, paginationOpts: { numItems: PAGE_SIZE, cursor: page.continueCursor },
    });
    else await deleteTeamMemberIfUnused(ctx, args.tenantId, args.fromTeamMemberId);
    return null;
  },
});
