import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { query, mutation, internalMutation, type MutationCtx } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { expectedError, isExpectedError } from "../lib/observability/errors";
import { isActiveLogin, mergeTeamMembers } from "../lib/teamMembers";
import { normalizeDmCloserInput, getLinkedUserForWrite } from "../attribution/dmClosers";
import { previousTeamsValidator, reviewItemValidator, type PreviousTeams, type ReviewItem } from "./contracts";
import { readTeamRecords, RECORD_LIMIT } from "./data";

/** Exact whole-name comparison, with accents, letter case and repeated spaces ignored. */
export function normalizedName(name: string) {
  return name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

export const listReviewItems = query({
  args: {}, returns: v.object({ items: v.array(reviewItemValidator), count: v.number() }),
  handler: async ctx => {
    const { tenantId } = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);
    const [data, decisions] = await Promise.all([
      readTeamRecords(ctx, tenantId),
      ctx.db.query("teamReviewDecisions").withIndex("by_tenantId_and_key", q => q.eq("tenantId", tenantId)).take(2001),
    ]);
    if (data.capped || decisions.length > 2000) throw expectedError("team.rejected", "This team is too large to review at once.");
    const dismissed = new Set(decisions.map(row => row.key));
    const groups = data.members.map(member => {
      const users = data.users.filter(row => row.teamMemberId === member._id);
      const leadGen = data.leadGen.filter(row => row.teamMemberId === member._id);
      const slack = data.slack.filter(row => row.teamMemberId === member._id);
      const dmClosers = data.dmClosers.filter(row => row.teamMemberId === member._id);
      return {
        member, users, leadGen, slack, dmClosers, activeLogin: users.some(isActiveLogin),
        records: users.length + leadGen.length + slack.length + dmClosers.length,
        emails: new Set([...users, ...leadGen].map(row => row.email.trim().toLowerCase()).filter(Boolean)),
        names: new Set([member.displayName, ...users.map(row => row.fullName ?? ""), ...leadGen.map(row => row.displayName ?? ""),
          ...dmClosers.map(row => row.displayName), ...slack.flatMap(row => [row.realName ?? "", row.displayName ?? ""])].map(normalizedName).filter(Boolean)),
        teams: new Set([...leadGen.flatMap(row => row.teamId ? [row.teamId] : []), ...dmClosers.map(row => row.teamId)]),
      };
    }).filter(group => group.records > 0).sort((a, b) => a.member._id.localeCompare(b.member._id));
    const items: ReviewItem[] = [];
    for (let i = 0; i < groups.length; i++) {
      const a = groups[i];
      for (const b of groups.slice(i + 1)) {
        const sameEmail = [...a.emails].some(email => b.emails.has(email));
        const sameName = [...a.names].some(name => b.names.has(name));
        if (!sameEmail && !sameName) continue;
        const reasons: Array<"same_email" | "same_name" | "same_team"> = [];
        if (sameEmail) reasons.push("same_email");
        if (sameName) reasons.push("same_name");
        if ([...a.teams].some(team => b.teams.has(team))) reasons.push("same_team");
        // Keep the active login; then the member with more than Slack (a Slack
        // user is the easiest record to move); then more records.
        const beyondSlack = (group: typeof a) => group.records - group.slack.length;
        const into = a.activeLogin !== b.activeLogin ? (a.activeLogin ? a : b)
          : beyondSlack(a) !== beyondSlack(b) ? (beyondSlack(a) > beyondSlack(b) ? a : b)
          : (a.records >= b.records ? a : b);
        const blocked = a.activeLogin && b.activeLogin;
        items.push({ kind: "same_human", key: `same_human:${a.member._id}:${b.member._id}`, members: [a.member._id, b.member._id], reasons,
          into: into.member._id, canJoin: !blocked, blockedReason: blocked ? "Both members have an active login. Remove one login before joining them." : null });
      }
      if (!a.users.length && !a.leadGen.length && !a.dmClosers.length) {
        for (const slack of a.slack) if (!slack.isBot && !slack.isDeleted) items.push({ kind: "slack_unlinked", key: `slack_only:${slack.slackUserId}`, slackUserId: slack.slackUserId, teamMemberId: a.member._id });
      }
      const leadGenTeamIds = [...new Set(a.leadGen.map(row => row.teamId ?? null))];
      const dmCloserTeamIds = [...new Set(a.dmClosers.map(row => row.teamId))];
      const all = [...new Set([...leadGenTeamIds, ...dmCloserTeamIds].map(id => id ?? "none"))].sort();
      if (leadGenTeamIds.length && dmCloserTeamIds.length && all.length > 1) items.push({
        kind: "teams_disagree", key: `teams:${a.member._id}:${all.join(":")}`, teamMemberId: a.member._id, leadGenTeamIds, dmCloserTeamIds,
      });
    }
    const visible = items.filter(item => !dismissed.has(item.key));
    if (visible.length > 2000) throw expectedError("team.rejected", "Too many matches to review at once.");
    return { items: visible, count: visible.length };
  },
});

function checkKey(key: string) {
  if (!/^(same_human:|slack_only:|teams:)/.test(key) || key.length > 1000) throw expectedError("team.rejected", "Invalid review item.");
}
export const decide = mutation({
  args: { key: v.string() }, returns: v.null(),
  handler: async (ctx, { key }) => {
    const { tenantId, userId } = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);
    checkKey(key);
    const existing = await ctx.db.query("teamReviewDecisions").withIndex("by_tenantId_and_key", q => q.eq("tenantId", tenantId).eq("key", key)).unique();
    if (!existing) await ctx.db.insert("teamReviewDecisions", { tenantId, key, decidedByUserId: userId, decidedAt: Date.now() });
    return null;
  },
});
export const reopen = mutation({
  args: { key: v.string() }, returns: v.null(),
  handler: async (ctx, { key }) => {
    const { tenantId } = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);
    checkKey(key);
    const row = await ctx.db.query("teamReviewDecisions").withIndex("by_tenantId_and_key", q => q.eq("tenantId", tenantId).eq("key", key)).unique();
    if (row) await ctx.db.delete("teamReviewDecisions", row._id);
    return null;
  },
});
const joinArgs = { fromTeamMemberId: v.id("teamMembers"), intoTeamMemberId: v.id("teamMembers") };
const JOINING = "joining:";

/**
 * While a join continues in the background, its two members are locked: a link,
 * unlink or team change meanwhile could send credit the join hasn't moved yet
 * to the wrong member. The lock is a teamReviewDecisions row keyed
 * `joining:<from>:<into>` (never a review item key), removed when the join ends.
 */
export async function assertNoPendingJoin(ctx: MutationCtx, tenantId: Id<"tenants">, memberIds: ReadonlyArray<Id<"teamMembers"> | null | undefined>) {
  const ids = memberIds.filter((id): id is Id<"teamMembers"> => Boolean(id));
  if (!ids.length) return;
  const pending = await ctx.db.query("teamReviewDecisions")
    .withIndex("by_tenantId_and_key", q => q.eq("tenantId", tenantId).gte("key", JOINING).lt("key", "joining;"))
    .take(100);
  if (pending.some(row => ids.some(id => row.key.includes(id)))) {
    throw expectedError("team.rejected", "A join for this member is still finishing. Try again in a minute.");
  }
}

function joinLockKey(args: { fromTeamMemberId: Id<"teamMembers">; intoTeamMemberId: Id<"teamMembers"> }) {
  return `${JOINING}${args.fromTeamMemberId}:${args.intoTeamMemberId}`;
}

export async function joinAndContinue(ctx: MutationCtx, args: { tenantId: Id<"tenants">; fromTeamMemberId: Id<"teamMembers">; intoTeamMemberId: Id<"teamMembers"> }) {
  const done = await mergeTeamMembers(ctx, args);
  if (!done) {
    await ctx.scheduler.runAfter(0, internal.team.review.continueJoin, args);
  } else {
    const lock = await ctx.db.query("teamReviewDecisions")
      .withIndex("by_tenantId_and_key", q => q.eq("tenantId", args.tenantId).eq("key", joinLockKey(args))).unique();
    if (lock) await ctx.db.delete("teamReviewDecisions", lock._id);
  }
  return { done };
}
export const joinTeamMembers = mutation({
  args: joinArgs, returns: v.object({ done: v.boolean() }),
  handler: async (ctx, args) => {
    const { tenantId, userId } = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);
    await assertNoPendingJoin(ctx, tenantId, [args.fromTeamMemberId, args.intoTeamMemberId]);
    const result = await joinAndContinue(ctx, { tenantId, ...args });
    if (!result.done) {
      await ctx.db.insert("teamReviewDecisions", { tenantId, key: joinLockKey(args), decidedByUserId: userId, decidedAt: Date.now() });
    }
    return result;
  },
});
export const continueJoin = internalMutation({
  args: { tenantId: v.id("tenants"), ...joinArgs }, returns: v.object({ done: v.boolean() }),
  handler: joinAndContinue,
});

async function validateTeam(ctx: MutationCtx, tenantId: Id<"tenants">, teamId: Id<"attributionTeams"> | null, requireActive: boolean) {
  if (teamId === null) return;
  const team = await ctx.db.get("attributionTeams", teamId);
  if (!team || team.tenantId !== tenantId || (requireActive && !team.isActive)) throw expectedError("team.rejected", "Choose an active DM team for lead gen workers.");
}
async function writeTeams(ctx: MutationCtx, tenantId: Id<"tenants">, previous: PreviousTeams, restoring = false) {
  if (previous.leadGen.length + previous.dmClosers.length > RECORD_LIMIT * 2) throw expectedError("team.rejected", "Too many records to update at once.");
  for (const change of previous.leadGen) {
    const worker = await ctx.db.get("leadGenWorkers", change.workerId);
    if (!worker || worker.tenantId !== tenantId) throw expectedError("team.rejected", "Lead gen worker not found.");
    await validateTeam(ctx, tenantId, change.teamId, !restoring);
    await ctx.db.patch("leadGenWorkers", worker._id, { teamId: change.teamId ?? undefined, updatedAt: Date.now() });
  }
  for (const change of previous.dmClosers) {
    const closer = await ctx.db.get("dmClosers", change.dmCloserId);
    if (!closer || closer.tenantId !== tenantId) throw expectedError("team.rejected", "DM closer not found.");
    await validateTeam(ctx, tenantId, change.teamId, false);
    let medium: string;
    try {
      medium = normalizeDmCloserInput(closer).normalizedUtmMedium;
      await getLinkedUserForWrite(ctx, tenantId, closer.userId);
    } catch (error) {
      if (isExpectedError(error)) throw expectedError("team.rejected", error.data.message);
      throw error;
    }
    const sameMedium = await ctx.db.query("dmClosers").withIndex("by_tenantId_and_normalizedUtmMedium", q => q.eq("tenantId", tenantId).eq("normalizedUtmMedium", medium)).take(RECORD_LIMIT + 1);
    if (sameMedium.length > RECORD_LIMIT || sameMedium.some(row => row._id !== closer._id && row.isActive)) throw expectedError("team.rejected", "An active DM closer already uses this UTM medium.");
    await ctx.db.patch("dmClosers", closer._id, { teamId: change.teamId, updatedAt: Date.now() });
  }
}
export const setTeamEverywhere = mutation({
  args: { teamMemberId: v.id("teamMembers"), teamId: v.union(v.id("attributionTeams"), v.null()) },
  returns: v.object({ previous: previousTeamsValidator, dmClosersKeptTeam: v.boolean() }),
  handler: async (ctx, { teamMemberId, teamId }) => {
    const { tenantId } = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);
    const member = await ctx.db.get("teamMembers", teamMemberId);
    if (!member || member.tenantId !== tenantId) throw expectedError("team.rejected", "Team member not found.");
    await assertNoPendingJoin(ctx, tenantId, [teamMemberId]);
    const [workers, closers] = await Promise.all([
      ctx.db.query("leadGenWorkers").withIndex("by_tenantId_and_teamMemberId", q => q.eq("tenantId", tenantId).eq("teamMemberId", teamMemberId)).take(RECORD_LIMIT + 1),
      ctx.db.query("dmClosers").withIndex("by_tenantId_and_teamMemberId", q => q.eq("tenantId", tenantId).eq("teamMemberId", teamMemberId)).take(RECORD_LIMIT + 1),
    ]);
    if (workers.length > RECORD_LIMIT || closers.length > RECORD_LIMIT) throw expectedError("team.rejected", "Too many records to update at once.");
    const previous: PreviousTeams = { leadGen: workers.map(row => ({ workerId: row._id, teamId: row.teamId ?? null })), dmClosers: closers.map(row => ({ dmCloserId: row._id, teamId: row.teamId })) };
    await writeTeams(ctx, tenantId, {
      leadGen: workers.map(row => ({ workerId: row._id, teamId })),
      dmClosers: teamId === null ? [] : closers.map(row => ({ dmCloserId: row._id, teamId })),
    });
    return { previous, dmClosersKeptTeam: teamId === null && closers.length > 0 };
  },
});
export const restoreTeams = mutation({
  args: { previous: previousTeamsValidator }, returns: v.null(),
  handler: async (ctx, { previous }) => {
    const { tenantId } = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);
    await writeTeams(ctx, tenantId, previous, true);
    return null;
  },
});
