"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { firstName } from "../team-ui";
import { joinWords, type ReviewData, type TeamId, type TeamsDisagreeItem } from "./review-data";
import { MiniCard, ReviewRow, runWithUndo } from "./review-ui";

/**
 * A member whose lead gen team and DM closer team differ. Put both roles on
 * one team (Undo restores each record's team), or keep both (Undo reopens).
 */
export function TeamsDisagreeRow({
  item,
  data,
  memberHref,
}: {
  item: TeamsDisagreeItem;
  data: ReviewData;
  memberHref: (key: string) => string;
}) {
  const setTeam = useMutation(api.team.review.setTeamEverywhere);
  const restore = useMutation(api.team.review.restoreTeams);
  const decide = useMutation(api.team.review.decide);
  const reopen = useMutation(api.team.review.reopen);
  const [busy, setBusy] = useState(false);
  const member = data.member(item.teamMemberId);
  if (!member) return null;
  const first = firstName(member.name);

  const leadGenTeams = joinWords(item.leadGenTeamIds.map(data.teamName));
  const dmTeams = joinWords(item.dmCloserTeamIds.map(data.teamName));
  // One choice per team either role is on; null (No team) is never a choice.
  const candidates = [...new Set<TeamId>([...item.leadGenTeamIds.flatMap((id) => (id ? [id] : [])), ...item.dmCloserTeamIds])];

  async function bothOn(teamId: TeamId) {
    const team = data.teamName(teamId);
    setBusy(true);
    await runWithUndo({
      run: () => setTeam({ teamMemberId: item.teamMemberId, teamId }),
      undo: ({ previous }) => restore({ previous }),
      message: ({ dmClosersKeptTeam }) =>
        `${first}: ${team} for lead gen and DM links.${dmClosersKeptTeam ? " The DM closers kept their team." : ""}`,
      flow: "team_review_team_set",
      failure: "Couldn’t change the team.",
    });
    setBusy(false);
  }

  async function keepBoth() {
    setBusy(true);
    await runWithUndo({
      run: () => decide({ key: item.key }),
      undo: () => reopen({ key: item.key }),
      message: () => `${first} keeps both teams.`,
      flow: "team_review_teams_kept",
      failure: "Couldn’t save that decision.",
    });
    setBusy(false);
  }

  return (
    <ReviewRow
      busy={busy}
      subject={
        <MiniCard
          bare
          name={member.name}
          href={memberHref(member.key)}
          line={
            <>
              Lead gen counts for <b className="font-semibold text-foreground">{leadGenTeams}</b> · DM links credit{" "}
              <b className="font-semibold text-foreground">{dmTeams}</b>
            </>
          }
        />
      }
      actions={
        <>
          {candidates.map((teamId) => {
            const team = data.team(teamId);
            const archived = team !== undefined && !team.isActive;
            const button = (
              <Button
                key={teamId}
                size="sm"
                variant="outline"
                disabled={busy || archived || !team}
                onClick={() => void bothOn(teamId)}
              >
                {data.teamName(teamId)} for both
              </Button>
            );
            if (!archived) return button;
            // A disabled button gets no hover, so the reason sits on a wrapper.
            return (
              <Tooltip key={teamId}>
                <TooltipTrigger asChild>
                  <span tabIndex={0} className="rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    {button}
                  </span>
                </TooltipTrigger>
                <TooltipContent className="max-w-[17rem] text-[12.5px] leading-snug">
                  {data.teamName(teamId)} is archived, and lead gen workers need an active team. Restore it on Teams first.
                </TooltipContent>
              </Tooltip>
            );
          })}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void keepBoth()}>
            Keep both
          </Button>
        </>
      }
      why={
        <span>
          {item.leadGenTeamIds.includes(null)
            ? `${first}’s lead gen worker has no team, so Lead Gen counts ${first}’s captures under No team. A team for both moves the worker onto it.`
            : `Moving the DM closer changes the utm_source on links ${first} copies from now on; links already sent keep crediting ${dmTeams}.`}
        </span>
      }
    />
  );
}
