import type { Id } from "../../convex/_generated/dataModel";
type TeamOption = { _id: Id<"attributionTeams">; name: string };

type TeamGroup<Row> = {
  key: string;
  teamId: Id<"attributionTeams"> | null;
  teamName: string;
  rows: Row[];
  submissions: number;
  scheduledHours: number;
};

const NO_TEAM_KEY = "no-team";

export function groupRowsByTeam<Row extends { teamId: Id<"attributionTeams"> | null; submissions: number; scheduledHours: number }>(rows: Row[], teams: TeamOption[] | undefined): TeamGroup<Row>[] {
  const teamNameById = new Map((teams ?? []).map((team) => [team._id, team.name]));
  const groups = new Map<string, TeamGroup<Row>>();
  for (const row of rows) {
    const key = row.teamId ?? NO_TEAM_KEY;
    const group = groups.get(key) ?? {
      key,
      teamId: row.teamId ?? null,
      teamName: row.teamId ? (teamNameById.get(row.teamId) ?? "Unknown team") : "No team",
      rows: [],
      submissions: 0,
      scheduledHours: 0,
    };
    group.rows.push(row);
    group.submissions += row.submissions;
    group.scheduledHours += row.scheduledHours;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => {
    if (a.key === NO_TEAM_KEY) return 1;
    if (b.key === NO_TEAM_KEY) return -1;
    if (a.submissions !== b.submissions) return b.submissions - a.submissions;
    return a.teamName.localeCompare(b.teamName);
  });
}

