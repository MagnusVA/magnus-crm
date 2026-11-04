import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

export const RECORD_LIMIT = 500;
export const SCHEDULE_LIMIT = 2500;

/** Tenant snapshots are deliberately small; never silently use a partial set for writes. */
export async function readTeamRecords(ctx: QueryCtx, tenantId: Id<"tenants">) {
  const [members, users, leadGen, slack, dmClosers, teams] = await Promise.all([
    ctx.db.query("teamMembers").withIndex("by_tenantId", q => q.eq("tenantId", tenantId)).take(RECORD_LIMIT + 1),
    ctx.db.query("users").withIndex("by_tenantId", q => q.eq("tenantId", tenantId)).take(RECORD_LIMIT + 1),
    ctx.db.query("leadGenWorkers").withIndex("by_tenantId_and_teamId", q => q.eq("tenantId", tenantId)).take(RECORD_LIMIT + 1),
    ctx.db.query("slackUsers").withIndex("by_tenantId", q => q.eq("tenantId", tenantId)).take(RECORD_LIMIT + 1),
    ctx.db.query("dmClosers").withIndex("by_tenantId_and_teamId", q => q.eq("tenantId", tenantId)).take(RECORD_LIMIT + 1),
    ctx.db.query("attributionTeams").withIndex("by_tenantId", q => q.eq("tenantId", tenantId)).take(RECORD_LIMIT + 1),
  ]);
  return {
    members: members.slice(0, RECORD_LIMIT), users: users.slice(0, RECORD_LIMIT), leadGen: leadGen.slice(0, RECORD_LIMIT),
    slack: slack.slice(0, RECORD_LIMIT), dmClosers: dmClosers.slice(0, RECORD_LIMIT), teams: teams.slice(0, RECORD_LIMIT),
    capped: [members, users, leadGen, slack, dmClosers, teams].some(rows => rows.length > RECORD_LIMIT),
  };
}
