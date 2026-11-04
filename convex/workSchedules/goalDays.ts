import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { createLiveReadState, type LiveReadState } from "../lib/liveQueryBounds";
import { goalCountsDay, goalDayCount, type DatedScheduleRow } from "../lib/workSchedule";
import { loadScheduleRowsByOwner } from "./rangeHours";

// A goal's target is its daily goal times the days someone in its group works
// (goalDayCount in convex/lib/workSchedule.ts). The qualified-leads goal is
// tenant-wide; the booked-calls goal is per DM team. The live dashboards, the
// Slack qualifications report and the report snapshot job all count each
// group through these helpers.

/** Matches the Qualifications dashboard's Slack user registry bound. */
export const QUALIFIED_GOAL_SLACK_USER_LIMIT = 300;

/**
 * The days of `dayKeys` the qualified-leads goal counts. Its group is every
 * Slack qualifier with a schedule (rows on any date) whose Slack user isn't
 * deleted.
 */
export function qualifiedGoalDayCount(
  slackUsers: readonly Pick<Doc<"slackUsers">, "slackUserId" | "isDeleted">[],
  scheduleRowsBySlackUserId: ReadonlyMap<string, readonly DatedScheduleRow[]>,
  dayKeys: readonly string[],
) {
  const group = slackUsers.flatMap((user) => {
    const rows = scheduleRowsBySlackUserId.get(user.slackUserId) ?? [];
    return !user.isDeleted && rows.length > 0 ? [rows] : [];
  });
  return goalDayCount(group, dayKeys);
}

/**
 * Reads the qualified-leads goal's group: the tenant's Slack users and their
 * schedule rows. Null when either read was capped.
 */
export async function loadQualifiedGoalGroup(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  state: LiveReadState = createLiveReadState(),
) {
  const slackUsers = await ctx.db
    .query("slackUsers")
    .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
    .take(QUALIFIED_GOAL_SLACK_USER_LIMIT + 1);
  if (slackUsers.length > QUALIFIED_GOAL_SLACK_USER_LIMIT) return null;
  const scheduleRowsBySlackUserId = await loadScheduleRowsByOwner(ctx, {
    tenantId,
    keys: slackUsers.map((user) => user.slackUserId),
    owner: (slackUserId) => ({ table: "slackQualifierSchedules", slackUserId }),
    liveReadState: state,
  });
  if (state.capped) return null;
  return { slackUsers, scheduleRowsBySlackUserId };
}

/**
 * Each team's goal group: the schedule rows of its active DM closers. Null
 * when the schedule reads ran out of budget.
 */
export async function loadBookingGoalGroups(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    teamIds: readonly Id<"attributionTeams">[];
    dmClosers: readonly Pick<Doc<"dmClosers">, "_id" | "teamId" | "isActive">[];
  },
): Promise<Map<Id<"attributionTeams">, DatedScheduleRow[][]> | null> {
  const teamIds = new Set(args.teamIds);
  const members = args.dmClosers.filter((closer) => closer.isActive && teamIds.has(closer.teamId));
  const state = createLiveReadState();
  const rowsByCloser = await loadScheduleRowsByOwner(ctx, {
    tenantId: args.tenantId,
    keys: members.map((closer) => closer._id),
    owner: (dmCloserId) => ({ table: "dmCloserSchedules", dmCloserId }),
    liveReadState: state,
  });
  if (state.capped) return null;
  const groups = new Map<Id<"attributionTeams">, DatedScheduleRow[][]>();
  for (const teamId of teamIds) {
    groups.set(
      teamId,
      members.filter((closer) => closer.teamId === teamId).map((closer) => rowsByCloser.get(closer._id) ?? []),
    );
  }
  return groups;
}

/**
 * Each team's goal days in `dayKeys`: the days one of the team's active DM
 * closers works, or every day until one has hours (goalDayCount). Null when
 * the schedule reads ran out of budget.
 */
export async function bookingGoalDayCounts(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    teamIds: readonly Id<"attributionTeams">[];
    dmClosers: readonly Pick<Doc<"dmClosers">, "_id" | "teamId" | "isActive">[];
    dayKeys: readonly string[];
  },
): Promise<Map<Id<"attributionTeams">, number> | null> {
  const groups = await loadBookingGoalGroups(ctx, args);
  if (!groups) return null;
  return new Map([...groups].map(([teamId, group]) => [teamId, goalDayCount(group, args.dayKeys)]));
}

/** Whether a team's goal counts `dayKey`, from its loaded group. */
export function bookingGoalCountsDay(group: readonly DatedScheduleRow[][] | undefined, dayKey: string) {
  return goalCountsDay(group ?? [], dayKey);
}
