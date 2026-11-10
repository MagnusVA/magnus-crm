import type { QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { tenantBusinessToday } from "../lib/tenantBusinessDay";
import {
  preferredLogin,
  slackUserTeamMemberName,
  userTeamMemberName,
} from "../lib/teamMembers";
import { userMemberIdentity } from "../lib/memberIdentity";
import {
  weekOn,
  weekChangedOn,
  type DatedScheduleRow,
} from "../lib/workSchedule";
import { type DirectoryMember } from "./contracts";
import { readTeamRecords, SCHEDULE_LIMIT } from "./data";

export async function buildDirectory(ctx: QueryCtx, tenantId: Id<"tenants">) {
  const [data, today, leadGenRows, slackRows, dmRows] = await Promise.all([
    readTeamRecords(ctx, tenantId),
    tenantBusinessToday(ctx, tenantId),
    ctx.db
      .query("leadGenWorkerSchedules")
      .withIndex(
        "by_tenantId_and_workerId_and_weekday_and_effectiveFrom",
        (q) => q.eq("tenantId", tenantId),
      )
      .take(SCHEDULE_LIMIT + 1),
    ctx.db
      .query("slackQualifierSchedules")
      .withIndex(
        "by_tenantId_and_slackUserId_and_weekday_and_effectiveFrom",
        (q) => q.eq("tenantId", tenantId),
      )
      .take(SCHEDULE_LIMIT + 1),
    ctx.db
      .query("dmCloserSchedules")
      .withIndex(
        "by_tenantId_and_dmCloserId_and_weekday_and_effectiveFrom",
        (q) => q.eq("tenantId", tenantId),
      )
      .take(SCHEDULE_LIMIT + 1),
  ]);
  const members = new Map<string, DirectoryMember>();
  function member(
    key: string,
    teamMemberId: DirectoryMember["teamMemberId"],
    name: string,
  ) {
    let found = members.get(key);
    if (!found) {
      found = {
        key,
        teamMemberId,
        name,
        login: null,
        leadGen: [],
        slack: [],
        dmClosers: [],
      };
      members.set(key, found);
    }
    return found;
  }
  for (const row of data.members) member(row._id, row._id, row.displayName);
  const schedule = (rows: DatedScheduleRow[]) => ({
    week: weekOn(rows, today),
    weekChangedOn: weekChangedOn(rows, today),
  });
  // Group logins first so creation order cannot hide the active login behind a removed one.
  const loginGroups = new Map<string, typeof data.users>();
  for (const user of data.users) {
    const key = user.teamMemberId ?? `users:${user._id}`;
    loginGroups.set(key, [...(loginGroups.get(key) ?? []), user]);
  }
  for (const [key, users] of loginGroups) {
    const user = preferredLogin(users)!;
    const identity = await userMemberIdentity(ctx, user);
    member(key, user.teamMemberId ?? null, userTeamMemberName(user)).login = {
      userId: user._id,
      name: userTeamMemberName(user),
      email: user.email,
      role: user.role,
      isActive: user.isActive,
      removed: user.deletedAt !== undefined || !user.isActive,
      calendlyLinked: Boolean(user.calendlyUserUri),
      invitationPending: user.invitationStatus === "pending",
      profilePictureUrl: identity.imageUrl ?? null,
      aiAssistantBlocked: user.mcpBlockedAt !== undefined,
    };
  }
  for (const row of data.leadGen)
    member(
      row.teamMemberId ?? `leadGenWorkers:${row._id}`,
      row.teamMemberId ?? null,
      row.displayName?.trim() || row.email,
    ).leadGen.push({
      workerId: row._id,
      name: row.displayName?.trim() || row.email,
      email: row.email,
      teamId: row.teamId ?? null,
      isActive: row.isActive,
      ...schedule(
        leadGenRows
          .slice(0, SCHEDULE_LIMIT)
          .filter((s) => s.workerId === row._id),
      ),
    });
  for (const row of data.slack) {
    if (row.isBot) continue;
    member(
      row.teamMemberId ?? `slackUsers:${row._id}`,
      row.teamMemberId ?? null,
      slackUserTeamMemberName(row),
    ).slack.push({
      slackUserId: row.slackUserId,
      name: slackUserTeamMemberName(row),
      handle: row.username ?? null,
      isDeleted: row.isDeleted,
      ...schedule(
        slackRows
          .slice(0, SCHEDULE_LIMIT)
          .filter((s) => s.slackUserId === row.slackUserId),
      ),
    });
  }
  for (const row of data.dmClosers)
    member(
      row.teamMemberId ?? `dmClosers:${row._id}`,
      row.teamMemberId ?? null,
      row.displayName,
    ).dmClosers.push({
      dmCloserId: row._id,
      name: row.displayName,
      teamId: row.teamId,
      utmMedium: row.utmMedium,
      isActive: row.isActive,
      ...schedule(
        dmRows.slice(0, SCHEDULE_LIMIT).filter((s) => s.dmCloserId === row._id),
      ),
    });
  return {
    today,
    members: [...members.values()]
      .filter(
        (row) =>
          row.login ||
          row.leadGen.length ||
          row.slack.length ||
          row.dmClosers.length,
      )
      .sort((a, b) => a.name.localeCompare(b.name)),
    teams: data.teams.map((row) => ({
      teamId: row._id,
      name: row.displayName,
      utmSource: row.utmSource,
      isActive: row.isActive,
      bookingDailyQuota: row.bookingDailyQuota ?? null,
    })),
    capped:
      data.capped ||
      [leadGenRows, slackRows, dmRows].some(
        (rows) => rows.length > SCHEDULE_LIMIT,
      ),
  };
}
