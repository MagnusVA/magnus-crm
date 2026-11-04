"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { ArrowLeftIcon, GitMergeIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { DirectoryMember } from "@/convex/team/contracts";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ActiveWord, firstName } from "../team-ui";
import {
  capitalize,
  joinWords,
  memberActive,
  memberEmails,
  memberRoles,
  memberTeamNames,
  recordsList,
  type ReviewData,
  type SameHumanItem,
  type TeamId,
} from "./review-data";
import { MiniCard, ReasonChip, ReviewRow, runWithUndo } from "./review-ui";

/**
 * "Same human?": two team members that share an email or a name, side by
 * side. Join (after a confirm), or Not the same (with Undo). Code never joins
 * them on its own.
 */
export function SameHumanRow({
  item,
  data,
  memberHref,
  primary,
  joining,
  onJoin,
}: {
  item: SameHumanItem;
  data: ReviewData;
  memberHref: (key: string) => string;
  /** This row holds the page's one lime action. */
  primary: boolean;
  /** A join was confirmed and goes on in the background. */
  joining: boolean;
  onJoin: (item: SameHumanItem) => void;
}) {
  const decide = useMutation(api.team.review.decide);
  const reopen = useMutation(api.team.review.reopen);
  const [busy, setBusy] = useState(false);
  const into = data.member(item.into);
  const fromId = item.members.find((id) => id !== item.into);
  const from = fromId ? data.member(fromId) : undefined;
  if (!into || !from) return null;

  async function notTheSame() {
    setBusy(true);
    await runWithUndo({
      run: () => decide({ key: item.key }),
      undo: () => reopen({ key: item.key }),
      message: () => `Kept apart: ${from!.name} and ${into!.name}.`,
      flow: "team_review_not_same",
      failure: "Couldn’t save that decision.",
    });
    setBusy(false);
  }

  const moving = recordsList(from);
  const intoFirst = firstName(into.name);
  const single = moving.length === 1 && moving[0].startsWith("a ");

  return (
    <ReviewRow
      busy={busy}
      subject={
        <div className="grid grid-cols-1 items-center gap-2 @2xl:grid-cols-[minmax(0,1fr)_24px_minmax(0,1fr)]">
          <PairCard member={into} data={data} memberHref={memberHref} />
          <span className="hidden justify-center text-muted-foreground @2xl:flex">
            <ArrowLeftIcon className="size-4" aria-hidden />
            <span className="sr-only">would take in</span>
          </span>
          <PairCard member={from} data={data} memberHref={memberHref} />
        </div>
      }
      actions={
        joining ? (
          <span
            role="status"
            className="inline-flex items-center gap-1.5 font-condensed text-[13px] font-bold tracking-[0.08em] text-muted-foreground uppercase"
          >
            <Spinner className="size-3.5" aria-hidden role={undefined} />
            Joining…
          </span>
        ) : (
          <>
            {item.canJoin ? (
              <Button
                size="sm"
                variant={primary ? "default" : "outline"}
                disabled={busy}
                onClick={() => onJoin(item)}
              >
                <GitMergeIcon aria-hidden />
                Join into {into.name}
              </Button>
            ) : (
              <span className="max-w-[22rem] text-[12.5px] leading-snug text-warning-ink">
                {item.blockedReason ?? "These two can’t be joined."}
              </span>
            )}
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void notTheSame()}>
              Not the same
            </Button>
          </>
        )
      }
      why={
        <>
          {item.reasons.map((reason) => (
            <ReasonChip key={reason} label={REASON_LABEL[reason]} tip={reasonTip(reason, into, from, data.teamName)} />
          ))}
          <span className="ml-0.5">
            {joining
              ? `Moving ${joinWords(moving) || "the records"} to ${intoFirst}. This row goes once it’s done.`
              : item.canJoin
                ? `Joining keeps one ${into.name}. ${
                    moving.length
                      ? `${capitalize(joinWords(moving))} ${single ? "moves" : "move"} to ${intoFirst}, with ${single ? "its" : "their"} past credit.`
                      : "The other record is empty, so joining only removes it."
                  }`
                : item.reasons.includes("same_email")
                  ? "Same email, so likely one human. Once one of them has no active login, you can join them."
                  : "Only the name matches, so code only suggests it. Not the same keeps them apart."}
          </span>
        </>
      }
    />
  );
}

const REASON_LABEL = { same_email: "Same email", same_name: "Same name", same_team: "Same team" } as const;

function PairCard({
  member,
  data,
  memberHref,
}: {
  member: DirectoryMember;
  data: ReviewData;
  memberHref: (key: string) => string;
}) {
  if (member.teamMemberId && data.isEmpty(member.teamMemberId)) {
    return (
      <MiniCard
        name={member.name}
        line="No records left: no login, lead gen, Slack or DM closer"
        status={<ActiveWord active={false} off="Empty" className="text-[11px]" />}
      />
    );
  }
  const href = memberHref(member.key);
  const line = [
    member.login ? member.login.email + (member.login.removed ? " (login removed)" : "") : "No CRM login",
    ...memberRoles(member).filter((role) => !role.endsWith(" login")),
    ...memberTeamNames(member, data.teamName),
  ].join(" · ");
  return (
    <MiniCard
      name={member.name}
      href={href}
      line={<span title={line}>{line}</span>}
      status={<ActiveWord active={memberActive(member)} off="Inactive" className="text-[11px]" />}
    />
  );
}

function names(member: DirectoryMember) {
  return [
    member.name,
    member.login?.name ?? "",
    ...member.leadGen.map((row) => row.name),
    ...member.slack.map((row) => row.name),
    ...member.dmClosers.map((row) => row.name),
  ].filter(Boolean);
}

function normalized(name: string) {
  return name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

function reasonTip(
  reason: SameHumanItem["reasons"][number],
  a: DirectoryMember,
  b: DirectoryMember,
  teamName: (id: TeamId | null) => string,
) {
  if (reason === "same_email") {
    const theirs = memberEmails(b);
    const email = [...memberEmails(a)].find((row) => theirs.has(row));
    return `Both use ${email ?? "the same email"}. An email belongs to one human, so this is most likely one person with two records.`;
  }
  if (reason === "same_name") {
    const theirs = new Set(names(b).map(normalized));
    const name = names(a).find((row) => theirs.has(normalized(row)));
    return `Both are named ${name ?? a.name}. Two people can share a name, so code only suggests this; you decide.`;
  }
  const teamIds = (member: DirectoryMember) =>
    new Set<TeamId>([...member.leadGen.flatMap((row) => (row.teamId ? [row.teamId] : [])), ...member.dmClosers.map((row) => row.teamId)]);
  const theirs = teamIds(b);
  const shared = [...teamIds(a)].filter((id) => theirs.has(id)).map(teamName);
  return `Both have a record on ${joinWords(shared) || "the same team"}. It backs up the match; it never makes one alone.`;
}
