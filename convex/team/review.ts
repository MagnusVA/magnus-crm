import { buildTeamReview } from "./reviewCore";
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { query, mutation, internalMutation, type MutationCtx } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { expectedError, isExpectedError } from "../lib/observability/errors";
import { mergeTeamMembers } from "../lib/teamMembers";
import { normalizeDmCloserInput, getLinkedUserForWrite } from "../attribution/dmClosers";
import { previousTeamsValidator, reviewItemValidator, type PreviousTeams } from "./contracts";
import { RECORD_LIMIT } from "./data";

/** Exact whole-name comparison, with accents, letter case and repeated spaces ignored. */
export function normalizedName(name: string) {
  return name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

export const listReviewItems = query({
  args: {}, returns: v.object({ items: v.array(reviewItemValidator), count: v.number() }),
  handler: async ctx => {
    const { tenantId } = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);
    return await buildTeamReview(ctx, tenantId);
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
