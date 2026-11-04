import type { Id } from "@/convex/_generated/dataModel";
import type { Directory, DirectoryMember } from "@/convex/team/contracts";
import type { ScheduleRole } from "../member-card/member-card-host";
import { EMPTY_WEEK, WEEKDAYS, weekTotal, type Weekday, type WeekHours } from "../schedule-editor";

// Team › Schedules, as data: one row per role record (a lead gen worker, a
// Slack qualifier, a DM closer), each with its own week in force today, and
// the groups the grid shows them in. The band's figures read the same rows.

export type RoleFilter = "all" | ScheduleRole;

export const ROLE_FILTERS: ReadonlyArray<{ role: RoleFilter; label: string }> = [
  { role: "all", label: "All" },
  { role: "lead_gen", label: "Lead gen" },
  { role: "slack", label: "Slack" },
  { role: "dm_closer", label: "DM closers" },
];

export function parseRoleFilter(value: string | null): RoleFilter {
  return value === "lead_gen" || value === "slack" || value === "dm_closer" ? value : "all";
}

export const ROLE_WORD: Record<ScheduleRole, string> = {
  lead_gen: "Lead gen",
  slack: "Slack",
  dm_closer: "DM closer",
};

export type ScheduleRow = {
  /** Unique across roles: the role and the role record's id. */
  id: string;
  role: ScheduleRole;
  member: Pick<DirectoryMember, "key" | "name">;
  week: WeekHours | null;
  weekChangedOn: string | null;
  /** Lead gen: its team (null = no team). DM closer: the team its links credit. */
  teamId: Id<"attributionTeams"> | null;
  /** A DM closer's utm_medium; null for the other roles. */
  utmMedium: string | null;
  /** The member's records in this role: a DM closer with two links has two. */
  sameRole: number;
  active: boolean;
  /** A week with some hours in it. An all-zero week counts as none. */
  scheduled: boolean;
};

/** Every role record in the directory, as schedule rows. */
export function scheduleRows(directory: Directory): ScheduleRow[] {
  const rows: ScheduleRow[] = [];
  for (const member of directory.members) {
    const who = { key: member.key, name: member.name };
    for (const worker of member.leadGen) {
      rows.push({
        id: `lead_gen:${worker.workerId}`,
        role: "lead_gen",
        member: who,
        week: worker.week,
        weekChangedOn: worker.weekChangedOn,
        teamId: worker.teamId,
        utmMedium: null,
        sameRole: member.leadGen.length,
        active: worker.isActive,
        scheduled: weekTotal(worker.week) > 0,
      });
    }
    for (const user of member.slack) {
      rows.push({
        id: `slack:${user.slackUserId}`,
        role: "slack",
        member: who,
        week: user.week,
        weekChangedOn: user.weekChangedOn,
        teamId: null,
        utmMedium: null,
        sameRole: member.slack.length,
        active: !user.isDeleted,
        scheduled: weekTotal(user.week) > 0,
      });
    }
    for (const closer of member.dmClosers) {
      rows.push({
        id: `dm_closer:${closer.dmCloserId}`,
        role: "dm_closer",
        member: who,
        week: closer.week,
        weekChangedOn: closer.weekChangedOn,
        teamId: closer.teamId,
        utmMedium: closer.utmMedium,
        sameRole: member.dmClosers.length,
        active: closer.isActive,
        scheduled: weekTotal(closer.week) > 0,
      });
    }
  }
  return rows;
}

/** Hours per weekday, added up over the rows. */
export function hoursByDay(rows: readonly Pick<ScheduleRow, "week">[]): WeekHours {
  const total = { ...EMPTY_WEEK };
  for (const row of rows) {
    if (!row.week) continue;
    for (const day of WEEKDAYS) total[day] += row.week[day];
  }
  return total;
}

/**
 * The weekdays a goal counts for a group (convex/lib/workSchedule.ts,
 * goalCountsDay): the days someone in the group works. Until anyone has
 * hours, every day counts. `rows` are the group's weeks in force today.
 */
export function countedDays(rows: readonly Pick<ScheduleRow, "week">[]): Weekday[] {
  const byDay = hoursByDay(rows);
  if (weekTotal(byDay) === 0) return [...WEEKDAYS];
  return WEEKDAYS.filter((day) => byDay[day] > 0);
}

export type GroupKind = "lead_gen_team" | "lead_gen_none" | "slack" | "dm_team";

export type ScheduleGroup = {
  key: string;
  kind: GroupKind;
  role: ScheduleRole;
  title: string;
  teamId: Id<"attributionTeams"> | null;
  teamArchived: boolean;
  rows: ScheduleRow[];
  /** Hours per weekday over the group's active rows. */
  byDay: WeekHours;
  /** Someone in the group has hours. Without it nothing is a gap: a goal counts every day. */
  anyHours: boolean;
  /** Weekdays nobody in the group works, once someone has hours. */
  gaps: Weekday[];
};

type Team = Directory["teams"][number];

function compareTeams(left: Team, right: Team) {
  if (left.isActive !== right.isActive) return left.isActive ? -1 : 1;
  return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
}

function compareRows(left: ScheduleRow, right: ScheduleRow) {
  return (
    left.member.name.localeCompare(right.member.name, undefined, { sensitivity: "base" }) ||
    (left.utmMedium ?? "").localeCompare(right.utmMedium ?? "")
  );
}

function group(
  key: string,
  kind: GroupKind,
  role: ScheduleRole,
  title: string,
  team: Team | null,
  rows: ScheduleRow[],
): ScheduleGroup {
  // Totals and gaps count active records only, as the goals do, even while
  // inactive ones are shown.
  const byDay = hoursByDay(rows.filter((row) => row.active));
  const anyHours = weekTotal(byDay) > 0;
  return {
    key,
    kind,
    role,
    title,
    teamId: team?.teamId ?? null,
    teamArchived: team ? !team.isActive : false,
    rows: [...rows].sort(compareRows),
    byDay,
    anyHours,
    gaps: anyHours ? WEEKDAYS.filter((day) => byDay[day] === 0) : [],
  };
}

/**
 * The grid's groups, in role order: lead gen by team (then No team), all
 * Slack qualifiers together (they have no team), DM closers by the team their
 * links credit. Teams run active first, then by name. Empty groups drop out.
 */
export function scheduleGroups(rows: readonly ScheduleRow[], teams: readonly Team[]): ScheduleGroup[] {
  const sortedTeams = [...teams].sort(compareTeams);
  const teamById = new Map(teams.map((team) => [team.teamId, team]));
  const groups: ScheduleGroup[] = [];

  const leadGen = rows.filter((row) => row.role === "lead_gen");
  for (const team of sortedTeams) {
    const members = leadGen.filter((row) => row.teamId === team.teamId);
    if (members.length) groups.push(group(`lead_gen:${team.teamId}`, "lead_gen_team", "lead_gen", team.name, team, members));
  }
  // A worker whose team isn't in the directory's list reads as No team too.
  const noTeam = leadGen.filter((row) => row.teamId === null || !teamById.has(row.teamId));
  if (noTeam.length) groups.push(group("lead_gen:none", "lead_gen_none", "lead_gen", "No team", null, noTeam));

  const slack = rows.filter((row) => row.role === "slack");
  if (slack.length) groups.push(group("slack", "slack", "slack", "Slack qualifiers", null, slack));

  const dm = rows.filter((row) => row.role === "dm_closer");
  for (const team of sortedTeams) {
    const members = dm.filter((row) => row.teamId === team.teamId);
    if (members.length) groups.push(group(`dm_closer:${team.teamId}`, "dm_team", "dm_closer", team.name, team, members));
  }
  const strays = dm.filter((row) => row.teamId === null || !teamById.has(row.teamId));
  if (strays.length) groups.push(group("dm_closer:unknown", "dm_team", "dm_closer", "Unknown team", null, strays));

  return groups;
}

/**
 * The groups whose empty days a goal skips: the Slack qualifiers (the
 * qualified-leads goal) and each active DM team (its booked-calls goal),
 * counting active records only, as the goals do.
 */
export function goalGroups(rows: readonly ScheduleRow[], teams: readonly Team[]) {
  const active = rows.filter((row) => row.active);
  return scheduleGroups(active, teams.filter((team) => team.isActive)).filter(
    (candidate) => candidate.kind === "slack" || (candidate.kind === "dm_team" && candidate.teamId !== null),
  );
}

/** Group-days nobody works, over the groups a goal reads. */
export function uncoveredDays(rows: readonly ScheduleRow[], teams: readonly Team[]) {
  return goalGroups(rows, teams).reduce((sum, candidate) => sum + candidate.gaps.length, 0);
}

export const LONG_DAY: Record<Weekday, string> = {
  monday: "Mondays",
  tuesday: "Tuesdays",
  wednesday: "Wednesdays",
  thursday: "Thursdays",
  friday: "Fridays",
  saturday: "Saturdays",
  sunday: "Sundays",
};

/** "Sat and Sun", "Mon, Wed and Sun". */
export function listDays(days: readonly Weekday[], words: Record<Weekday, string>) {
  return listWords(days.map((day) => words[day]));
}

/** "A", "A and B", "A, B and C". */
export function listWords(words: readonly string[]) {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}
