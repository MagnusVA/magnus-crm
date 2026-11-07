"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { PlusIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ArchiveButton } from "../teams/archive-team-button";
import { AttributionTeamDialog } from "../teams/attribution-team-dialog";
import { membersLine, useTeamsDirectory } from "../teams/teams-data";
import { formatHours } from "../schedule-editor";
import { plural } from "../team-ui";
import { BandFigure, BandFigures, BandFiguresPlaceholder, BOARD_BUTTON } from "./band-figure";

// Team › Teams and one team's page: the band's figures, title and actions.

/** Active teams, members on a team, lead gen with no team, booked goals set. */
export function TeamsFigures() {
  const directory = useTeamsDirectory();
  if (!directory) return <BandFiguresPlaceholder />;
  const active = directory.teams.filter((team) => team.isActive);
  const onTeam = active.reduce((sum, team) => {
    const stats = directory.statsFor(team._id);
    return sum + stats.activeLeadGen + stats.activeDm;
  }, 0);
  const withGoal = active.filter((team) => team.bookingDailyQuota !== undefined).length;
  return (
    <BandFigures>
      <BandFigure
        label="Active teams"
        tip="Teams that appear on reports and in the link portal, and get credit for bookings. Archived teams keep their history."
        value={active.length}
        caption={`${directory.teams.length - active.length} archived`}
      />
      <BandFigure
        label="On a team"
        tip="Active lead generators and DM closers on an active team. Someone with both roles counts twice."
        value={onTeam}
        caption="lead gen and DM closers"
      />
      <BandFigure
        label="No team"
        tip="Active lead generators with no team. Lead Gen lists them under No team."
        value={directory.noTeam.length}
        caption="Show them"
        href="/workspace/team?role=lead_gen"
        tone={directory.noTeam.length ? "warning" : "default"}
      />
      <BandFigure
        label="Booked goals"
        tip="Active teams with a booked-calls goal per business day. Booked Calls draws each team's goal ring from it."
        value={withGoal}
        of={active.length}
        caption="Goals"
        href="/workspace/team/goals#booked"
      />
    </BandFigures>
  );
}

/** The Teams tab's lime action: New team (`?new=team` opens the dialog). */
export function TeamsAction() {
  return (
    <Button asChild className="self-start">
      <Link href="/workspace/team/teams?new=team">
        <PlusIcon aria-hidden />
        New team
      </Link>
    </Button>
  );
}

function useTeam(teamId: string | undefined) {
  const teams = useQuery(api.attribution.teams.listTeams, {});
  return { loaded: teams !== undefined, team: teams?.find((row) => row._id === teamId) };
}

/** The team page's title: the team's name and whether it is active. */
export function TeamTitle({ teamId }: { teamId: string | undefined }) {
  const { loaded, team } = useTeam(teamId);
  if (!team) return <>{loaded ? "Team not found" : " "}</>;
  return (
    <>
      {team.displayName}
      <span
        className={cn(
          "rounded-[4px] border px-1.5 py-0.5 font-condensed text-[11px] font-bold tracking-[0.1em] uppercase",
          team.isActive ? "border-board-foreground/25 text-board-foreground" : "border-board-foreground/15 text-board-muted",
        )}
      >
        {team.isActive ? "Active" : "Archived"}
      </span>
    </>
  );
}

/** "utm_source dm_team_brian · goal 25 booked calls a business day · 19 active members". */
export function TeamMeta({ teamId }: { teamId: string | undefined }) {
  const directory = useTeamsDirectory();
  const team = directory?.teams.find((row) => row._id === teamId);
  if (!directory || !team) return null;
  const stats = directory.statsFor(team._id);
  return (
    <>
      utm_source <span className="font-mono text-board-foreground">{team.utmSource}</span>
      {" · "}
      {team.bookingDailyQuota !== undefined
        ? `goal ${team.bookingDailyQuota} booked calls a business day`
        : "no daily goal"}
      {" · "}
      {plural(stats.activeLeadGen + stats.activeDm, "active member")}
    </>
  );
}

/** Members, hours a week, booked goal, and bookings through its DM links. */
export function TeamFigures({ teamId }: { teamId: string | undefined }) {
  const directory = useTeamsDirectory();
  const activity = useQuery(api.bookingSetup.queries.getBookingActivity, {});
  const team = directory?.teams.find((row) => row._id === teamId);
  if (!directory || activity === undefined) return <BandFiguresPlaceholder />;
  if (!team) return null;
  const stats = directory.statsFor(team._id);
  return (
    <BandFigures>
      <BandFigure
        label="Members"
        tip="Active lead generators and DM closers on this team. Someone with both roles counts twice."
        value={stats.activeLeadGen + stats.activeDm}
        caption={membersLine(stats)}
      />
      <BandFigure
        label="Hours a week"
        tip="The weeks in force today of this team's active lead generators and DM closers, added up."
        value={formatHours(stats.hours)}
        unit="h"
        caption="scheduled"
      />
      <BandFigure
        label="Booked goal"
        tip="Booked calls this team should make each business day. Booked Calls draws the team's goal ring from it."
        value={team.bookingDailyQuota ?? "—"}
        caption={team.bookingDailyQuota !== undefined ? "a business day" : "No goal"}
      />
      <BandFigure
        label="Booked · 30 days"
        tip="Bookings in the last 30 days through links with this team's utm_source."
        value={activity.bookings30d.teams[team._id] ?? 0}
        caption="through its DM links"
      />
    </BandFigures>
  );
}

/** Edit team (name, utm_source, goal) and Archive or Restore, on the band. */
export function TeamActions({ teamId }: { teamId: string | undefined }) {
  const { team } = useTeam(teamId);
  const [editing, setEditing] = useState(false);
  if (!team) return null;
  return (
    <div className="mt-3 flex items-center gap-2">
      <Button variant="outline" size="sm" className={BOARD_BUTTON} onClick={() => setEditing(true)}>
        Edit team
      </Button>
      <ArchiveButton team={team} className={BOARD_BUTTON} />
      <AttributionTeamDialog open={editing} onOpenChange={setEditing} team={team} />
    </div>
  );
}
