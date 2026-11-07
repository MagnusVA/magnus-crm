"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { firstName, HelpTip } from "../team-ui";
import { saveWithUndo } from "./card-ui";
import { teamName, type DirectoryMember, type DirectoryTeam, type TeamsDisagreeItem } from "./member-model";

const CHOICE =
  "flex min-h-[4.5rem] flex-col items-start gap-1 rounded-[7px] border border-warning-ink/20 bg-card px-3 py-2.5 text-left outline-none hover:border-foreground/30 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60";

function listNames(names: string[]) {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The amber choice when a member's lead gen team and DM closer team differ:
 * one team for both (Undo restores every record's team), or keep both on
 * purpose (Undo reopens the flag).
 */
export function TeamsDisagree({
  member,
  item,
  teams,
}: {
  member: DirectoryMember;
  item: TeamsDisagreeItem;
  teams: readonly DirectoryTeam[];
}) {
  const setTeamEverywhere = useMutation(api.team.review.setTeamEverywhere);
  const restoreTeams = useMutation(api.team.review.restoreTeams);
  const decide = useMutation(api.team.review.decide);
  const reopen = useMutation(api.team.review.reopen);
  const [busy, setBusy] = useState(false);
  const first = firstName(member.name);

  const leadGenNames = [...new Set(item.leadGenTeamIds.map((teamId) => teamName(teams, teamId)))];
  const dmNames = [...new Set(item.dmCloserTeamIds.map((teamId) => teamName(teams, teamId)))];
  const choices = [
    ...new Set([...item.leadGenTeamIds, ...item.dmCloserTeamIds].filter((teamId): teamId is Id<"attributionTeams"> => teamId !== null)),
  ]
    .map((teamId) => teams.find((team) => team.teamId === teamId))
    .filter((team): team is DirectoryTeam => Boolean(team?.isActive));

  async function oneTeam(team: DirectoryTeam) {
    if (!member.teamMemberId) return;
    const teamMemberId = member.teamMemberId;
    setBusy(true);
    await saveWithUndo({
      run: () => setTeamEverywhere({ teamMemberId, teamId: team.teamId }),
      undo: (result) => restoreTeams({ previous: result.previous }),
      message: `${first} is on ${team.name} for lead gen and DM links`,
      description: (result) =>
        result.dmClosersKeptTeam
          ? `${first}’s DM closers kept their team: a DM closer always has one.`
          : "From now on. Past captures and bookings keep their team.",
      flow: "team_member_card_team_everywhere",
      event: "team_member_teams_unified",
    });
    setBusy(false);
  }

  async function keepBoth() {
    setBusy(true);
    await saveWithUndo({
      run: () => decide({ key: item.key }),
      undo: () => reopen({ key: item.key }),
      message: `${first} keeps both teams`,
      description: "The flag goes away. Review shows it again if you undo.",
      flow: "team_member_card_keep_both",
      event: "team_member_teams_kept",
    });
    setBusy(false);
  }

  return (
    <div className="mx-5 mt-4 rounded-lg bg-warning-surface px-3.5 py-3 text-warning-ink" role="group" aria-label={`${first}’s teams disagree`}>
      <p className="text-[14px] font-semibold">
        <HelpTip tip="A member's lead gen record and DM closer record point at different teams. That can be on purpose; pick one team, or keep both and the flag goes away.">
          {first}’s teams disagree
        </HelpTip>
      </p>
      <p className="mt-1 text-[13px] leading-snug">
        Lead Gen counts {first}’s captures for <b className="font-semibold">{listNames(leadGenNames)}</b>, but {first}’s DM
        links credit <b className="font-semibold">{listNames(dmNames)}</b>.
      </p>
      <div className="mt-2.5 grid grid-cols-1 gap-2 @lg/card:grid-cols-3">
        {choices.map((team) => (
          <button key={team.teamId} type="button" className={CHOICE} disabled={busy || !member.teamMemberId} onClick={() => void oneTeam(team)}>
            <span className="text-[13.5px] font-semibold text-foreground">{team.name} for both</span>
            <span className="text-[12.5px] leading-snug text-muted-foreground">
              Lead gen and DM links both count for {team.name} from now on.
            </span>
          </button>
        ))}
        <button type="button" className={CHOICE} disabled={busy} onClick={() => void keepBoth()}>
          <span className="text-[13.5px] font-semibold text-foreground">Keep both</span>
          <span className="text-[12.5px] leading-snug text-muted-foreground">
            {first} works lead gen for one team and DM links for another. The flag goes away.
          </span>
        </button>
      </div>
    </div>
  );
}
