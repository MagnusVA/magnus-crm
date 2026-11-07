import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { expectedError } from "./observability/errors";
import { repointDealAttributionTeamMember } from "./attribution/dealAttributions";

// One team member per human (CONTEXT.md, "Team member"). The role records
// point at it through `teamMemberId`. Only explicit links join two records:
// a lead gen worker's user, a DM closer's user, a Slack user's CRM user.
// Names never do (docs/plans/phase-1-foundations.md §6.1, D5).

export async function insertTeamMember(
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

/**
 * A role record moved to another team member: its attribution rows follow,
 * since they credit the same human (docs/plans/phase-3-attribution.md §4.8).
 */
export async function moveRecordAttributions(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    role: "lead_gen" | "setter" | "dm_closer";
    recordKey: string;
    fromTeamMemberId: Id<"teamMembers"> | undefined;
    intoTeamMemberId: Id<"teamMembers">;
  },
): Promise<void> {
  if (!args.fromTeamMemberId || args.fromTeamMemberId === args.intoTeamMemberId) {
    return;
  }
  await ctx.scheduler.runAfter(0, internal.attribution.teamMemberRepoint.repointRoleRecordRows, {
    tenantId: args.tenantId,
    role: args.role,
    recordKey: args.recordKey,
    followCurrentOwner: true,
    fromTeamMemberId: args.fromTeamMemberId,
    intoTeamMemberId: args.intoTeamMemberId,
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

/** A removed or disabled login never wins over a current login. */
export function isActiveLogin(user: Doc<"users">): boolean {
  return user.isActive && user.deletedAt === undefined;
}

export function preferredLogin(users: readonly Doc<"users">[]): Doc<"users"> | null {
  return users.find(isActiveLogin) ?? users[0] ?? null;
}

/** Read the full bounded set, including logins beyond a merge's role page. */
export async function memberLogins(ctx: MutationCtx | QueryCtx, tenantId: Id<"tenants">, teamMemberId: Id<"teamMembers">) {
  const users = await ctx.db.query("users")
    .withIndex("by_tenantId_and_teamMemberId", q => q.eq("tenantId", tenantId).eq("teamMemberId", teamMemberId))
    .take(1001);
  if (users.length > 1000) throw expectedError("team.rejected", "Too many logins to safely join this member.");
  return users;
}

const ATTRIBUTION_ROLES = ["setter", "lead_gen", "dm_closer"] as const;

/**
 * Deletes a team member nothing points at any more: no role record, deal
 * credit or event. A record moving to another member (an unlink, its Undo, a
 * link to a login) runs this on the member it left once its credit has moved,
 * so no empty member is left behind for Members or Review.
 */
export async function deleteTeamMemberIfUnused(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  teamMemberId: Id<"teamMembers">,
): Promise<boolean> {
  const member = await ctx.db.get("teamMembers", teamMemberId);
  if (!member || member.tenantId !== tenantId) return false;
  for (const table of ROLE_TABLES) {
    const record = await ctx.db
      .query(table)
      .withIndex("by_tenantId_and_teamMemberId", (q) => q.eq("tenantId", tenantId).eq("teamMemberId", teamMemberId))
      .first();
    if (record) return false;
  }
  for (const role of ATTRIBUTION_ROLES) {
    const credit = await ctx.db
      .query("dealAttributions")
      .withIndex("by_tenantId_and_role_and_teamMemberId_and_meetingScheduledAt", (q) =>
        q.eq("tenantId", tenantId).eq("role", role).eq("teamMemberId", teamMemberId),
      )
      .first();
    if (credit) return false;
  }
  const event = await ctx.db
    .query("domainEvents")
    .withIndex("by_tenantId_and_teamMemberId_and_occurredAt", (q) => q.eq("tenantId", tenantId).eq("teamMemberId", teamMemberId))
    .first();
  if (event) return false;
  await ctx.db.delete("teamMembers", teamMemberId);
  return true;
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
    await moveRecordAttributions(ctx, {
      tenantId: worker.tenantId,
      role: "lead_gen",
      recordKey: workerId,
      fromTeamMemberId: worker.teamMemberId,
      intoTeamMemberId: teamMemberId,
    });
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
    await moveRecordAttributions(ctx, {
      tenantId: slackUser.tenantId,
      role: "setter",
      recordKey: slackUser.slackUserId,
      fromTeamMemberId: slackUser.teamMemberId,
      intoTeamMemberId: teamMemberId,
    });
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
  const records = await teamMemberRoleRecords(ctx, slackUser.tenantId, slackUser.teamMemberId);
  if (records.users.length || records.leadGenWorkers.length || records.dmClosers.length || records.slackUsers.length !== 1) {
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
    await moveRecordAttributions(ctx, {
      tenantId: dmCloser.tenantId,
      role: "dm_closer",
      recordKey: dmCloserId,
      fromTeamMemberId: dmCloser.teamMemberId,
      intoTeamMemberId: teamMemberId,
    });
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
const ROLE_RECORD_PAGE = 50;
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
        .take(ROLE_RECORD_PAGE),
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
 * Moves every record, event and attribution row of `fromTeamMemberId` to
 * `intoTeamMemberId`, then deletes it. A human can hold only one active login. Removed logins
 * may coexist with that login. Returns false while events or rows are left to
 * repoint; call again.
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
    throw expectedError("team.rejected", "Team member not found in this tenant.");
  }
  if (!from) {
    return true;
  }
  if (from.tenantId !== tenantId || fromTeamMemberId === intoTeamMemberId) {
    throw expectedError("team.rejected", "Choose two different members in this tenant.");
  }
  const moving = await teamMemberRoleRecords(ctx, tenantId, fromTeamMemberId);
  const [fromLogins, intoLogins] = await Promise.all([
    memberLogins(ctx, tenantId, fromTeamMemberId), memberLogins(ctx, tenantId, intoTeamMemberId),
  ]);
  if (fromLogins.some(isActiveLogin) && intoLogins.some(isActiveLogin)) {
    throw expectedError("team.rejected", "Both members have an active login. Remove one login before joining them.");
  }
  for (const table of ROLE_TABLES) {
    for (const record of moving[table]) {
      await ctx.db.patch(table, record._id, { teamMemberId: intoTeamMemberId });
    }
  }
  // A full page may have more behind it; keep the team member until it's empty.
  if (ROLE_TABLES.some((table) => moving[table].length === ROLE_RECORD_PAGE)) {
    return false;
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
  const rowsMoved = await repointDealAttributionTeamMember(ctx, {
    tenantId,
    fromTeamMemberId,
    intoTeamMemberId,
    limit: EVENT_REPOINT_BATCH,
  });
  if (rowsMoved === EVENT_REPOINT_BATCH) {
    return false;
  }
  await ctx.db.delete("teamMembers", fromTeamMemberId);
  await ctx.db.patch("teamMembers", intoTeamMemberId, { updatedAt: Date.now() });
  return true;
}
