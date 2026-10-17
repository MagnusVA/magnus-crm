import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

// One team member per human (CONTEXT.md, "Team member"). The role records
// point at it through `teamMemberId`. Only explicit links join two records:
// a lead gen worker's user, a DM closer's user, a Slack user's CRM user.
// Names never do (docs/plans/phase-1-foundations.md §6.1, D5).

async function insertTeamMember(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  displayName: string,
): Promise<Id<"teamMembers">> {
  const now = Date.now();
  return await ctx.db.insert("teamMembers", {
    tenantId,
    displayName,
    createdAt: now,
    updatedAt: now,
  });
}

export function userTeamMemberName(user: Doc<"users">): string {
  return user.fullName?.trim() || user.email;
}

export function slackUserTeamMemberName(slackUser: Doc<"slackUsers">): string {
  return (
    slackUser.realName?.trim() ||
    slackUser.displayName?.trim() ||
    slackUser.username?.trim() ||
    slackUser.slackUserId
  );
}

/** The user's team member, created the first time anything needs it. */
export async function ensureUserTeamMember(
  ctx: MutationCtx,
  userId: Id<"users">,
): Promise<Id<"teamMembers"> | undefined> {
  const user = await ctx.db.get("users", userId);
  if (!user) {
    return undefined;
  }
  if (user.teamMemberId) {
    return user.teamMemberId;
  }
  const teamMemberId = await insertTeamMember(ctx, user.tenantId, userTeamMemberName(user));
  await ctx.db.patch("users", userId, { teamMemberId });
  return teamMemberId;
}

/**
 * A lead gen worker is always its user's team member. A worker whose user is
 * gone keeps a team member of its own.
 */
export async function linkLeadGenWorkerTeamMember(
  ctx: MutationCtx,
  workerId: Id<"leadGenWorkers">,
): Promise<void> {
  const worker = await ctx.db.get("leadGenWorkers", workerId);
  if (!worker) {
    return;
  }
  const teamMemberId =
    (await ensureUserTeamMember(ctx, worker.userId)) ??
    worker.teamMemberId ??
    (await insertTeamMember(ctx, worker.tenantId, worker.displayName?.trim() || worker.email));
  if (worker.teamMemberId !== teamMemberId) {
    await ctx.db.patch("leadGenWorkers", workerId, { teamMemberId });
  }
}

/** The linked CRM user's team member, or the Slack user's own. */
export async function linkSlackUserTeamMember(
  ctx: MutationCtx,
  slackUserRowId: Id<"slackUsers">,
): Promise<void> {
  const slackUser = await ctx.db.get("slackUsers", slackUserRowId);
  if (!slackUser) {
    return;
  }
  const teamMemberId = slackUser.crmUserId
    ? await ensureUserTeamMember(ctx, slackUser.crmUserId)
    : (slackUser.teamMemberId ??
      (await insertTeamMember(ctx, slackUser.tenantId, slackUserTeamMemberName(slackUser))));
  if (teamMemberId && slackUser.teamMemberId !== teamMemberId) {
    await ctx.db.patch("slackUsers", slackUserRowId, { teamMemberId });
  }
}

/** A Slack user's profile arrived; a team member only it holds takes the name. */
export async function refreshSlackUserTeamMemberName(
  ctx: MutationCtx,
  slackUserRowId: Id<"slackUsers">,
): Promise<void> {
  const slackUser = await ctx.db.get("slackUsers", slackUserRowId);
  if (!slackUser?.teamMemberId || slackUser.crmUserId) {
    return;
  }
  const teamMember = await ctx.db.get("teamMembers", slackUser.teamMemberId);
  const displayName = slackUserTeamMemberName(slackUser);
  if (teamMember && teamMember.displayName !== displayName) {
    await ctx.db.patch("teamMembers", teamMember._id, { displayName, updatedAt: Date.now() });
  }
}

/**
 * A DM closer linked to a user is that user's team member. Unlinked, it keeps
 * a team member of its own, or gets a new one if its old one was the user's.
 */
export async function linkDmCloserTeamMember(
  ctx: MutationCtx,
  dmCloserId: Id<"dmClosers">,
): Promise<void> {
  const dmCloser = await ctx.db.get("dmClosers", dmCloserId);
  if (!dmCloser) {
    return;
  }
  let teamMemberId: Id<"teamMembers"> | undefined;
  if (dmCloser.userId) {
    teamMemberId = await ensureUserTeamMember(ctx, dmCloser.userId);
  } else if (dmCloser.teamMemberId && !(await isUsersTeamMember(ctx, dmCloser.tenantId, dmCloser.teamMemberId))) {
    teamMemberId = dmCloser.teamMemberId;
  } else {
    teamMemberId = await insertTeamMember(ctx, dmCloser.tenantId, dmCloser.displayName);
  }
  if (teamMemberId && dmCloser.teamMemberId !== teamMemberId) {
    await ctx.db.patch("dmClosers", dmCloserId, { teamMemberId });
  }
}

async function isUsersTeamMember(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  teamMemberId: Id<"teamMembers">,
): Promise<boolean> {
  const user = await ctx.db
    .query("users")
    .withIndex("by_tenantId_and_teamMemberId", (q) =>
      q.eq("tenantId", tenantId).eq("teamMemberId", teamMemberId),
    )
    .first();
  return user !== null;
}

// --- Joining two team members of one human, after the tenant admin approves
// the pair (D5). Code never decides this from names. ---

const ROLE_TABLES = ["users", "leadGenWorkers", "slackUsers", "dmClosers"] as const;
const EVENT_REPOINT_BATCH = 200;

/** The role records that point at a team member, by table. */
export async function teamMemberRoleRecords(
  ctx: MutationCtx | QueryCtx,
  tenantId: Id<"tenants">,
  teamMemberId: Id<"teamMembers">,
) {
  const [users, leadGenWorkers, slackUsers, dmClosers] = await Promise.all(
    ROLE_TABLES.map((table) =>
      ctx.db
        .query(table)
        .withIndex("by_tenantId_and_teamMemberId", (q) =>
          q.eq("tenantId", tenantId).eq("teamMemberId", teamMemberId),
        )
        .take(50),
    ),
  );
  return {
    users: users as Doc<"users">[],
    leadGenWorkers: leadGenWorkers as Doc<"leadGenWorkers">[],
    slackUsers: slackUsers as Doc<"slackUsers">[],
    dmClosers: dmClosers as Doc<"dmClosers">[],
  };
}

/**
 * Moves every record and event of `fromTeamMemberId` to `intoTeamMemberId`,
 * then deletes it. A human can hold one login, so the two can't both have a
 * user. Returns false while domain events are left to repoint; call again.
 */
export async function mergeTeamMembers(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    fromTeamMemberId: Id<"teamMembers">;
    intoTeamMemberId: Id<"teamMembers">;
  },
): Promise<boolean> {
  const { tenantId, fromTeamMemberId, intoTeamMemberId } = args;
  const [from, into] = await Promise.all([
    ctx.db.get("teamMembers", fromTeamMemberId),
    ctx.db.get("teamMembers", intoTeamMemberId),
  ]);
  if (!into || into.tenantId !== tenantId) {
    throw new Error(`Team member ${intoTeamMemberId} not found in this tenant`);
  }
  if (!from) {
    return true;
  }
  if (from.tenantId !== tenantId || fromTeamMemberId === intoTeamMemberId) {
    throw new Error(`Can't merge team member ${fromTeamMemberId} into ${intoTeamMemberId}`);
  }
  const moving = await teamMemberRoleRecords(ctx, tenantId, fromTeamMemberId);
  const staying = await teamMemberRoleRecords(ctx, tenantId, intoTeamMemberId);
  if (moving.users.length > 0 && staying.users.length > 0) {
    throw new Error("Both team members have a login; a human has one");
  }
  for (const table of ROLE_TABLES) {
    for (const record of moving[table]) {
      await ctx.db.patch(table, record._id, { teamMemberId: intoTeamMemberId });
    }
  }
  const events = await ctx.db
    .query("domainEvents")
    .withIndex("by_tenantId_and_teamMemberId_and_occurredAt", (q) =>
      q.eq("tenantId", tenantId).eq("teamMemberId", fromTeamMemberId),
    )
    .take(EVENT_REPOINT_BATCH);
  for (const event of events) {
    await ctx.db.patch("domainEvents", event._id, { teamMemberId: intoTeamMemberId });
  }
  if (events.length === EVENT_REPOINT_BATCH) {
    return false;
  }
  await ctx.db.delete("teamMembers", fromTeamMemberId);
  await ctx.db.patch("teamMembers", intoTeamMemberId, { updatedAt: Date.now() });
  return true;
}
