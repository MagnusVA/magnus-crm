"use client";

import { useMemo, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { DirectoryMember } from "@/convex/team/contracts";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import { firstName } from "../team-ui";
import { memberRoles, memberTeamNames, type MemberId, type ReviewData, type SlackUnlinkedItem } from "./review-data";
import { MiniCard, ReasonChip, ReviewRow, runWithUndo } from "./review-ui";

type Candidate = { teamMemberId: MemberId; name: string; detail: string };

/**
 * A Slack user the bot saw post qualified leads, with no CRM login and no
 * other record. Link them to a team member (Undo restores the link), or leave
 * them Slack-only (Undo reopens it).
 */
export function SlackUnlinkedRow({
  item,
  data,
  memberHref,
}: {
  item: SlackUnlinkedItem;
  data: ReviewData;
  memberHref: (key: string) => string;
}) {
  const link = useMutation(api.team.members.linkSlackUser);
  const restore = useMutation(api.team.members.restoreSlackUserLink);
  const decide = useMutation(api.team.review.decide);
  const reopen = useMutation(api.team.review.reopen);
  const [busy, setBusy] = useState(false);
  const member = data.member(item.teamMemberId);
  const slack = member?.slack.find((row) => row.slackUserId === item.slackUserId);
  const candidates = useMemo(
    () => linkCandidates(data, item.teamMemberId),
    [data, item.teamMemberId],
  );
  if (!member || !slack) return null;
  const name = slack.name || member.name;
  const first = firstName(name);

  async function linkTo(candidate: Candidate) {
    setBusy(true);
    const linked = await runWithUndo({
      run: () => link({ slackUserId: item.slackUserId, teamMemberId: candidate.teamMemberId }),
      undo: ({ previous }) => restore({ previous }),
      message: () => `Linked ${name} to ${candidate.name}. The credit moves in the background.`,
      flow: "team_review_slack_linked",
      failure: "Couldn’t link this Slack user.",
    });
    // On success the row leaves the list; it only stays busy-free on failure.
    if (!linked) setBusy(false);
  }

  async function leaveSlackOnly() {
    setBusy(true);
    await runWithUndo({
      run: () => decide({ key: item.key }),
      undo: () => reopen({ key: item.key }),
      message: () => `${name} stays Slack-only.`,
      flow: "team_review_slack_only_kept",
      failure: "Couldn’t save that decision.",
    });
    setBusy(false);
  }

  return (
    <ReviewRow
      busy={busy}
      subject={
        <MiniCard
          name={name}
          href={memberHref(member.key)}
          line={[slack.handle ? `Slack @${slack.handle}` : "Slack", "No CRM login", "No other record"].join(" · ")}
        />
      }
      actions={
        <>
          <LinkPicker candidates={candidates} disabled={busy} onPick={(candidate) => void linkTo(candidate)} />
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void leaveSlackOnly()}>
            Leave Slack-only
          </Button>
        </>
      }
      why={
        <>
          <ReasonChip
            label="No match"
            tip="No login, lead gen worker or DM closer shares this Slack user’s email or name, so nothing is suggested. Pick the team member yourself, if there is one."
          />
          <span className="ml-0.5">
            Left Slack-only, {first}’s qualified leads still count; {first} just has no team. Linking moves that credit to
            the team member you pick, in the background.
          </span>
        </>
      }
    />
  );
}

function LinkPicker({
  candidates,
  disabled,
  onPick,
}: {
  candidates: Candidate[];
  disabled: boolean;
  onPick: (candidate: Candidate) => void;
}) {
  return (
    <Combobox
      items={candidates}
      value={null}
      onValueChange={(candidate: Candidate | null) => {
        if (candidate) onPick(candidate);
      }}
      itemToStringLabel={(candidate: Candidate) => candidate.name}
      itemToStringValue={(candidate: Candidate) => candidate.teamMemberId}
      autoHighlight
      disabled={disabled}
    >
      <ComboboxInput
        placeholder="Link to a team member…"
        aria-label="Link to a team member"
        className="h-7 w-[15rem] text-[13px]"
        disabled={disabled}
      />
      <ComboboxContent className="min-w-[18rem]">
        <ComboboxEmpty>No team member by that name.</ComboboxEmpty>
        <ComboboxList>
          {(candidate: Candidate) => (
            <ComboboxItem key={candidate.teamMemberId} value={candidate}>
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{candidate.name}</span>
                <span className="truncate text-[12px] text-muted-foreground">{candidate.detail}</span>
              </span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

/** Everyone with a login, a lead gen worker or a DM closer, by name. */
function linkCandidates(data: ReviewData, self: MemberId): Candidate[] {
  return data.directory.members
    .filter(
      (row): row is DirectoryMember & { teamMemberId: MemberId } =>
        row.teamMemberId !== null &&
        row.teamMemberId !== self &&
        (row.login !== null || row.leadGen.length > 0 || row.dmClosers.length > 0),
    )
    .map((row) => ({
      teamMemberId: row.teamMemberId,
      name: row.name,
      detail: [...memberRoles(row), ...memberTeamNames(row, data.teamName)].join(" · "),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
