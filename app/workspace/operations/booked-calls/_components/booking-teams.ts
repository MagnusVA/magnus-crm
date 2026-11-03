import type {
  BookedCallsDashboardViewModel,
  DmCloserViewModel,
} from "@/lib/operations-reports/booked-dashboard";
import { bookingPace, type BookingPace, type BookingPaceKind } from "@/lib/operations-reports/booking-pace";

// The Booked calls page reads its numbers by DM team: each team's goal and
// pace, and its DM closers ranked inside the team.

export type BookingTeam = {
  key: string;
  label: string;
  dailyQuota: number | null;
  /** True for the DM closers with no team: never a goal, only a ranking. */
  unassigned: boolean;
  pace: BookingPace;
  /** The team's DM closers, most booked first. */
  closers: DmCloserViewModel[];
};

const NO_TEAM = "No team";

function byBooked(a: DmCloserViewModel, b: DmCloserViewModel) {
  return (
    b.booked - a.booked ||
    (b.bookedPerHour ?? -1) - (a.bookedPerHour ?? -1) ||
    a.label.localeCompare(b.label)
  );
}

/**
 * Teams in the goal's order, then any team only the closers name, then
 * closers with no team. A team shows when it has a goal, a booking or a
 * DM closer in the range.
 */
export function bookingTeams(
  data: BookedCallsDashboardViewModel,
  includesToday: boolean,
): BookingTeam[] {
  const closersByTeam = new Map<string, DmCloserViewModel[]>();
  for (const closer of data.dmClosers) {
    const label = closer.teamLabel ?? NO_TEAM;
    closersByTeam.set(label, [...(closersByTeam.get(label) ?? []), closer]);
  }

  const teams: BookingTeam[] = [];
  const seen = new Set<string>();
  for (const team of data.goal.teams) {
    const closers = (closersByTeam.get(team.label) ?? []).sort(byBooked);
    seen.add(team.label);
    if (team.target === null && team.progress === 0 && closers.length === 0) continue;
    teams.push({
      key: team.label,
      label: team.label,
      dailyQuota: team.dailyQuota,
      unassigned: false,
      closers,
      pace: bookingPace({
        booked: team.progress,
        dailyQuota: team.dailyQuota,
        goal: team.target,
        dayCount: data.goal.businessDayCount,
        includesToday,
      }),
    });
  }
  const rest = [...closersByTeam.keys()]
    .filter((label) => !seen.has(label))
    .sort((a, b) => (a === NO_TEAM ? 1 : b === NO_TEAM ? -1 : a.localeCompare(b)));
  for (const label of rest) {
    const closers = (closersByTeam.get(label) ?? []).sort(byBooked);
    teams.push({
      key: `closers:${label}`,
      label,
      dailyQuota: null,
      unassigned: label === NO_TEAM,
      closers,
      pace: bookingPace({
        booked: closers.reduce((sum, closer) => sum + closer.booked, 0),
        dailyQuota: null,
        goal: null,
        dayCount: data.goal.businessDayCount,
        includesToday,
      }),
    });
  }
  return teams;
}

/** Each pace's colour, from the stage scale and the urgency colours (DESIGN.md). */
export const PACE_TONE: Record<
  BookingPaceKind,
  { ink: string; fill: string; stroke: string }
> = {
  met: { ink: "text-stage-won-ink", fill: "bg-stage-won", stroke: "stroke-stage-won" },
  ahead: { ink: "text-stage-follow-up-ink", fill: "bg-stage-follow-up", stroke: "stroke-stage-follow-up" },
  on_pace: { ink: "text-stage-follow-up-ink", fill: "bg-stage-follow-up", stroke: "stroke-stage-follow-up" },
  behind: { ink: "text-warning-ink", fill: "bg-warning", stroke: "stroke-warning" },
  missed: { ink: "text-danger-ink", fill: "bg-stage-lost", stroke: "stroke-stage-lost" },
  no_goal: { ink: "text-stage-held-ink", fill: "bg-stage-held", stroke: "stroke-stage-held" },
};
