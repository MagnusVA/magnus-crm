import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { internalMutation } from "../_generated/server";

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
  },
  returns: v.null(),
  handler: async (ctx, args) => {
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
          teamMemberId: args.intoTeamMemberId,
        });
      }
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.attribution.teamMemberRepoint.repointRoleRecordRows, {
        ...args,
        paginationOpts: { numItems: PAGE_SIZE, cursor: page.continueCursor },
      });
    }
    return null;
  },
});
