import { v, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query, type QueryCtx } from "../_generated/server";
import { isActiveLogin, preferredLogin, userTeamMemberName } from "../lib/teamMembers";
import { requireTenantUser } from "../requireTenantUser";
import { readTeamRecords } from "../team/data";
import {
  MEMBER_REPORT_ROLES,
  REPORT_ADMIN_ROLES,
  isReportAdmin,
  resolveMemberFilter,
  viewerTeamMemberId,
} from "./lib/access";

// Who a member report is about (docs/reviews/reports-overhaul.html §10): the
// team member's name and the roles they work, read from the role records that
// point at them through `teamMemberId`. A member works a role when a record of
// that kind is linked, active or not, so a former setter still opens their
// setter figures for the ranges they worked.

/** How many role records of one kind a member can hold before we stop reading. */
const RECORDS_PER_KIND = 50;

export const memberRoleValidator = v.union(
  v.literal("closer"),
  v.literal("setter"),
  v.literal("dm_closer"),
  v.literal("lead_gen"),
);
export type MemberRole = Infer<typeof memberRoleValidator>;

/** The order roles are listed in: chips, tabs and the member report's sections. */
export const MEMBER_ROLE_ORDER: readonly MemberRole[] = ["closer", "setter", "dm_closer", "lead_gen"];

export const memberProfileValidator = v.object({
  teamMemberId: v.id("teamMembers"),
  name: v.string(),
  roles: v.array(memberRoleValidator),
  /** The member's login, for the work log's actor filter, or null with none. */
  userId: v.union(v.id("users"), v.null()),
  /** True when any linked login or role record is still active. */
  isActive: v.boolean(),
});
export type MemberProfile = Infer<typeof memberProfileValidator>;

type MemberRecords = {
  users: Doc<"users">[];
  slackUsers: Doc<"slackUsers">[];
  dmClosers: Doc<"dmClosers">[];
  workers: Doc<"leadGenWorkers">[];
};

/** Roles and activity from a member's linked records. Bots never count as setters. */
export function profileFromRecords(member: Doc<"teamMembers">, records: MemberRecords): MemberProfile {
  const slackUsers = records.slackUsers.filter((row) => !row.isBot);
  const roles = new Set<MemberRole>();
  if (records.users.some((user) => user.role === "closer")) roles.add("closer");
  if (records.users.some((user) => user.role === "lead_generator") || records.workers.length > 0) roles.add("lead_gen");
  if (slackUsers.length > 0) roles.add("setter");
  if (records.dmClosers.length > 0) roles.add("dm_closer");
  const login = preferredLogin(records.users);
  const isActive =
    records.users.some(isActiveLogin) ||
    slackUsers.some((row) => !row.isDeleted) ||
    records.dmClosers.some((row) => row.isActive) ||
    records.workers.some((row) => row.isActive);
  return {
    teamMemberId: member._id,
    name: member.displayName.trim() || (login ? userTeamMemberName(login) : "Unnamed member"),
    roles: MEMBER_ROLE_ORDER.filter((role) => roles.has(role)),
    userId: login?._id ?? null,
    isActive,
  };
}

export async function readMemberProfile(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  memberId: Id<"teamMembers">,
): Promise<MemberProfile | null> {
  const member = await ctx.db.get("teamMembers", memberId);
  if (!member || member.tenantId !== tenantId) return null;
  const [users, slackUsers, dmClosers, workers] = await Promise.all([
    ctx.db
      .query("users")
      .withIndex("by_tenantId_and_teamMemberId", (q) => q.eq("tenantId", tenantId).eq("teamMemberId", memberId))
      .take(RECORDS_PER_KIND),
    ctx.db
      .query("slackUsers")
      .withIndex("by_tenantId_and_teamMemberId", (q) => q.eq("tenantId", tenantId).eq("teamMemberId", memberId))
      .take(RECORDS_PER_KIND),
    ctx.db
      .query("dmClosers")
      .withIndex("by_tenantId_and_teamMemberId", (q) => q.eq("tenantId", tenantId).eq("teamMemberId", memberId))
      .take(RECORDS_PER_KIND),
    ctx.db
      .query("leadGenWorkers")
      .withIndex("by_tenantId_and_teamMemberId", (q) => q.eq("tenantId", tenantId).eq("teamMemberId", memberId))
      .take(RECORDS_PER_KIND),
  ]);
  return profileFromRecords(member, { users, slackUsers, dmClosers, workers });
}

/**
 * The member a report is about. Admins may pass any member of their tenant
 * and, passing none, get their own (null when their login has no member).
 * Closers and lead generators always get their own: passing someone else's
 * id is refused, as on the role reports, so a page can redirect them home.
 */
export const getMemberProfile = query({
  args: { memberId: v.optional(v.id("teamMembers")) },
  returns: v.union(memberProfileValidator, v.null()),
  handler: async (ctx, args): Promise<MemberProfile | null> => {
    const viewer = await requireTenantUser(ctx, [...MEMBER_REPORT_ROLES]);
    const memberId = isReportAdmin(viewer.role)
      ? ((await resolveMemberFilter(ctx, args.memberId, viewer)) ?? (await viewerTeamMemberId(ctx, viewer)))
      : await resolveMemberFilter(ctx, args.memberId, viewer);
    if (!memberId) return null;
    return await readMemberProfile(ctx, viewer.tenantId, memberId);
  },
});

export const reportMembersValidator = v.object({
  members: v.array(memberProfileValidator),
  /** True when the tenant has more role records than one read returns. */
  capped: v.boolean(),
});
export type ReportMembers = Infer<typeof reportMembersValidator>;

/**
 * Every team member with their roles and whether they're active, for the
 * People roster's inactive markers and the Everyone tab. Admins only, like
 * the roster itself.
 */
export const listReportMembers = query({
  args: {},
  returns: reportMembersValidator,
  handler: async (ctx): Promise<ReportMembers> => {
    const { tenantId } = await requireTenantUser(ctx, [...REPORT_ADMIN_ROLES]);
    return readReportMembers(ctx, tenantId);
  },
});

/** Shared load/build path. Trusted callers must authorize the tenant first. */
export async function readReportMembers(ctx: QueryCtx, tenantId: Id<"tenants">): Promise<ReportMembers> {
  const data = await readTeamRecords(ctx, tenantId);
  const group = <T extends { teamMemberId?: Id<"teamMembers"> }>(rows: readonly T[]) => {
    const byMember = new Map<Id<"teamMembers">, T[]>();
    for (const row of rows) {
      if (!row.teamMemberId) continue;
      byMember.set(row.teamMemberId, [...(byMember.get(row.teamMemberId) ?? []), row]);
    }
    return byMember;
  };
  const users = group(data.users);
  const slackUsers = group(data.slack);
  const dmClosers = group(data.dmClosers);
  const workers = group(data.leadGen);
  return {
    members: data.members
      .map((member) =>
        profileFromRecords(member, {
          users: users.get(member._id) ?? [],
          slackUsers: slackUsers.get(member._id) ?? [],
          dmClosers: dmClosers.get(member._id) ?? [],
          workers: workers.get(member._id) ?? [],
        }),
      )
      .sort((a, b) => a.name.localeCompare(b.name) || a.teamMemberId.localeCompare(b.teamMemberId)),
    capped: data.capped,
  };
}
