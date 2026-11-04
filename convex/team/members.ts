import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, type MutationCtx } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { expectedError } from "../lib/observability/errors";
import { insertTeamMember, linkSlackUserTeamMember, memberLogins, moveRecordAttributions, preferredLogin, slackUserTeamMemberName } from "../lib/teamMembers";
import { slackPreviousValidator, type SlackPrevious } from "./contracts";
import { RECORD_LIMIT } from "./data";
import { assertNoPendingJoin } from "./review";

async function slackForWrite(ctx: MutationCtx, tenantId: Id<"tenants">, slackUserId: string) {
  const row = await ctx.db.query("slackUsers").withIndex("by_tenantId_and_slackUserId", q => q.eq("tenantId", tenantId).eq("slackUserId", slackUserId)).unique();
  if (!row || row.isBot) throw expectedError("team.rejected", "Slack user not found.");
  return row;
}
async function snapshot(ctx: MutationCtx, rows: Doc<"slackUsers">[]): Promise<SlackPrevious> {
  return { links: await Promise.all(rows.map(async row => ({
    slackUserId: row.slackUserId, teamMemberId: row.teamMemberId ?? null, crmUserId: row.crmUserId ?? null,
    memberName: (row.teamMemberId ? await ctx.db.get("teamMembers", row.teamMemberId) : null)?.displayName ?? slackUserTeamMemberName(row),
  }))) };
}
async function moveSlack(ctx: MutationCtx, row: Doc<"slackUsers">, teamMemberId: Id<"teamMembers">, crmUserId?: Id<"users">) {
  await ctx.db.patch("slackUsers", row._id, { teamMemberId, crmUserId });
  await moveRecordAttributions(ctx, { tenantId: row.tenantId, role: "setter", recordKey: row.slackUserId, fromTeamMemberId: row.teamMemberId, intoTeamMemberId: teamMemberId });
}
/** Whether the Slack user's member holds any other record. */
async function sharesMember(ctx: MutationCtx, tenantId: Id<"tenants">, row: Doc<"slackUsers">) {
  const from = row.teamMemberId!;
  const [users, workers, closers, slack] = await Promise.all([
    ctx.db.query("users").withIndex("by_tenantId_and_teamMemberId", q => q.eq("tenantId", tenantId).eq("teamMemberId", from)).first(),
    ctx.db.query("leadGenWorkers").withIndex("by_tenantId_and_teamMemberId", q => q.eq("tenantId", tenantId).eq("teamMemberId", from)).first(),
    ctx.db.query("dmClosers").withIndex("by_tenantId_and_teamMemberId", q => q.eq("tenantId", tenantId).eq("teamMemberId", from)).first(),
    ctx.db.query("slackUsers").withIndex("by_tenantId_and_teamMemberId", q => q.eq("tenantId", tenantId).eq("teamMemberId", from)).take(2),
  ]);
  return Boolean(users || workers || closers || slack.length > 1 || row.crmUserId);
}
export const linkSlackUser = mutation({
  args: { slackUserId: v.string(), teamMemberId: v.id("teamMembers") }, returns: v.object({ previous: slackPreviousValidator }),
  handler: async (ctx, { slackUserId, teamMemberId }) => {
    const { tenantId } = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);
    const row = await slackForWrite(ctx, tenantId, slackUserId);
    const target = await ctx.db.get("teamMembers", teamMemberId);
    if (!target || target.tenantId !== tenantId) throw expectedError("team.rejected", "Team member not found.");
    await assertNoPendingJoin(ctx, tenantId, [row.teamMemberId, teamMemberId]);
    const login = preferredLogin(await memberLogins(ctx, tenantId, teamMemberId));
    if (login) {
      const previous = await snapshot(ctx, [row]);
      await ctx.db.patch("slackUsers", row._id, { crmUserId: login._id });
      await linkSlackUserTeamMember(ctx, row._id);
      return { previous };
    }
    if (!row.teamMemberId || row.teamMemberId === teamMemberId) {
      const previous = await snapshot(ctx, [row]);
      await moveSlack(ctx, row, teamMemberId);
      return { previous };
    }
    const from = row.teamMemberId;
    const [users, workers, closers, slack] = await Promise.all([
      ctx.db.query("users").withIndex("by_tenantId_and_teamMemberId", q => q.eq("tenantId", tenantId).eq("teamMemberId", from)).take(1),
      ctx.db.query("leadGenWorkers").withIndex("by_tenantId_and_teamMemberId", q => q.eq("tenantId", tenantId).eq("teamMemberId", from)).take(1),
      ctx.db.query("dmClosers").withIndex("by_tenantId_and_teamMemberId", q => q.eq("tenantId", tenantId).eq("teamMemberId", from)).take(1),
      ctx.db.query("slackUsers").withIndex("by_tenantId_and_teamMemberId", q => q.eq("tenantId", tenantId).eq("teamMemberId", from)).take(RECORD_LIMIT + 1),
    ]);
    if (users.length || workers.length || closers.length) throw expectedError("team.rejected", "This Slack user already belongs to a member with other records. Unlink it first.");
    if (slack.length > RECORD_LIMIT) throw expectedError("team.rejected", "Too many Slack users to join at once.");
    const previous = await snapshot(ctx, slack);
    // Join the Slack-only member by moving its role records together. Scoped
    // repoint jobs follow each record's current owner, including a quick Undo.
    // The emptied member is deleted once its credit has moved and nothing
    // points at it (deleteTeamMemberIfUnused, at the end of the repoint jobs).
    for (const source of slack) await moveSlack(ctx, source, teamMemberId);
    return { previous };
  },
});
export const unlinkSlackUser = mutation({
  args: { slackUserId: v.string() }, returns: v.object({ previous: slackPreviousValidator, teamMemberId: v.id("teamMembers") }),
  handler: async (ctx, { slackUserId }) => {
    const { tenantId } = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);
    const row = await slackForWrite(ctx, tenantId, slackUserId);
    await assertNoPendingJoin(ctx, tenantId, [row.teamMemberId]);
    if (row.teamMemberId && !(await sharesMember(ctx, tenantId, row))) {
      throw expectedError("team.rejected", "This Slack user isn't linked to anyone.");
    }
    const previous = await snapshot(ctx, [row]);
    const teamMemberId = await insertTeamMember(ctx, tenantId, slackUserTeamMemberName(row));
    await moveSlack(ctx, row, teamMemberId);
    return { previous, teamMemberId };
  },
});
/** Undo a Slack link or unlink. A joined-away Slack-only member is recreated. */
export const restoreSlackUserLink = mutation({
  args: { previous: slackPreviousValidator }, returns: v.null(),
  handler: async (ctx, { previous }) => {
    const { tenantId } = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);
    if (previous.links.length > RECORD_LIMIT) throw expectedError("team.rejected", "Too many Slack users to restore at once.");
    const recreated = new Map<string, Id<"teamMembers">>();
    for (const link of previous.links) {
      const row = await slackForWrite(ctx, tenantId, link.slackUserId);
      await assertNoPendingJoin(ctx, tenantId, [row.teamMemberId, link.teamMemberId]);
      const member = link.teamMemberId ? await ctx.db.get("teamMembers", link.teamMemberId) : null;
      if (member && member.tenantId !== tenantId) throw expectedError("team.rejected", "Team member not found.");
      let destination = member?._id ?? recreated.get(link.teamMemberId ?? link.slackUserId);
      if (link.crmUserId) {
        const login = await ctx.db.get("users", link.crmUserId);
        if (!login || login.tenantId !== tenantId) throw expectedError("team.rejected", "Login not found.");
        // A later join may have changed this login's member since the snapshot.
        destination = login.teamMemberId ?? destination;
      }
      if (!destination) {
        destination = await insertTeamMember(ctx, tenantId, link.memberName);
        recreated.set(link.teamMemberId ?? link.slackUserId, destination);
      }
      await moveSlack(ctx, row, destination, link.crmUserId ?? undefined);
    }
    return null;
  },
});
