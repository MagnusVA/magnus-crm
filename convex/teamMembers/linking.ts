import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery } from "../_generated/server";
import { log } from "../lib/observability/log";
import { mergeTeamMembers, slackUserTeamMemberName, userTeamMemberName } from "../lib/teamMembers";

// D5 (docs/plans/phase-1-foundations.md §10): code joins team members only
// through explicit links. These two functions let the tenant admin join the
// rest: one lists name matches by ID, and the other applies the pairs the
// admin approved. Neither returns or logs a name.

function nameKey(name: string | undefined): string {
  return (name ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

type Candidate = {
  fromTeamMemberId: Id<"teamMembers">;
  intoTeamMemberId: Id<"teamMembers">;
  fromRecord: string;
  intoUserId?: Id<"users">;
  match: "full_name" | "first_name";
};

/** Team members without a login whose name matches exactly one user's. */
export const nameLinkCandidates = internalQuery({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    const users = await ctx.db.query("users").withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId)).take(1000);
    const dmClosers = await ctx.db.query("dmClosers").withIndex("by_tenantId_and_teamId", (q) => q.eq("tenantId", tenantId)).take(1000);
    const slackUsers = await ctx.db.query("slackUsers").withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId)).take(1000);
    const usersByName = (key: (user: Doc<"users">) => string) => {
      const map = new Map<string, Doc<"users">[]>();
      for (const user of users) {
        const k = key(user);
        if (k) map.set(k, [...(map.get(k) ?? []), user]);
      }
      return map;
    };
    const byFull = usersByName((user) => nameKey(userTeamMemberName(user)));
    const byFirst = usersByName((user) => nameKey(userTeamMemberName(user)).split(" ")[0] ?? "");
    const candidates: Candidate[] = [];
    const unmatched: string[] = [];
    const consider = (record: string, teamMemberId: Id<"teamMembers"> | undefined, names: string[]) => {
      if (!teamMemberId) return;
      const keys = names.map(nameKey).filter(Boolean);
      const full = [...new Set(keys.flatMap((k) => byFull.get(k) ?? []))];
      const first = [...new Set(keys.flatMap((k) => byFirst.get(k.split(" ")[0]) ?? []))];
      const match = full.length === 1 ? full[0] : full.length === 0 && first.length === 1 ? first[0] : undefined;
      if (!match?.teamMemberId || match.teamMemberId === teamMemberId) {
        unmatched.push(record);
        return;
      }
      candidates.push({
        fromTeamMemberId: teamMemberId,
        intoTeamMemberId: match.teamMemberId,
        fromRecord: record,
        intoUserId: match._id,
        match: full.length === 1 ? "full_name" : "first_name",
      });
    };
    for (const dmCloser of dmClosers) {
      if (!dmCloser.userId) consider(dmCloser._id, dmCloser.teamMemberId, [dmCloser.displayName]);
    }
    for (const slackUser of slackUsers) {
      if (!slackUser.crmUserId) {
        consider(slackUser._id, slackUser.teamMemberId, [slackUserTeamMemberName(slackUser), slackUser.displayName ?? ""]);
      }
    }
    return { candidates, unmatched };
  },
});

/** Joins pairs of team members the tenant admin approved, one pair at a time. */
export const applyApprovedLinks = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    approvedByUserId: v.id("users"),
    links: v.array(
      v.object({
        fromTeamMemberId: v.id("teamMembers"),
        intoTeamMemberId: v.id("teamMembers"),
      }),
    ),
  },
  handler: async (ctx, { tenantId, approvedByUserId, links }) => {
    const approver = await ctx.db.get("users", approvedByUserId);
    if (approver?.tenantId !== tenantId || !["tenant_master", "tenant_admin"].includes(approver.role)) {
      throw new Error("The approver must be an admin of this tenant");
    }
    const unfinished: typeof links = [];
    for (const link of links) {
      const done = await mergeTeamMembers(ctx, { tenantId, ...link });
      if (!done) unfinished.push(link);
    }
    log.info("team_members.links_applied", {
      tenantId,
      approvedByUserId,
      applied: links.length - unfinished.length,
      unfinished: unfinished.length,
    });
    return { applied: links.length - unfinished.length, unfinished };
  },
});
