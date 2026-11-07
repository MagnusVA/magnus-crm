"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { CheckIcon } from "lucide-react";
import { usePageTitle } from "@/hooks/use-page-title";
import { SectionErrorBoundary } from "@/app/workspace/_components/section-error-boundary";
import { MemberCardHost, useMemberCardHref } from "../member-card/member-card-host";
import { CARD } from "../team-ui";
import { useReviewData, type MemberId, type ReviewData, type SameHumanItem } from "./review-data";
import { ReviewSection } from "./review-ui";
import { ReviewSkeleton } from "./review-skeleton";
import { SameHumanRow } from "./same-human-item";
import { SlackUnlinkedRow } from "./slack-unlinked-item";
import { TeamsDisagreeRow } from "./teams-disagree-item";

const JoinDialog = dynamic(() => import("./join-dialog").then((mod) => mod.JoinDialog));

/**
 * Team › Review: the decisions only an admin can make, one row each, with
 * why it's here and what each choice changes. Code suggests; it never joins
 * two team members on its own. Everything but a join has an Undo.
 */
export function ReviewPageClient() {
  usePageTitle("Review");
  return (
    <>
      <SectionErrorBoundary
        sectionName="Review"
        fallback={
          <div role="alert" className={`${CARD} px-4 py-3.5 text-[14px]`}>
            <p className="font-medium text-danger-ink">Couldn’t load Review.</p>
            <p className="mt-0.5 text-[13px] text-muted-foreground">
              Reload the page to try again. A team with more than 500 records of one kind is too large to review at once.
            </p>
          </div>
        }
      >
        <ReviewBody />
      </SectionErrorBoundary>
      <MemberCardHost />
    </>
  );
}

function ReviewBody() {
  const data = useReviewData();
  const memberHref = useMemberCardHref();
  // Joins confirmed here that go on in the background, by the member that goes.
  const [joining, setJoining] = useState<ReadonlySet<MemberId>>(new Set());
  const [joinItem, setJoinItem] = useState<SameHumanItem | null>(null);

  if (!data) return <ReviewSkeleton />;
  const href = (key: string) => memberHref(key);
  const total = data.sameHuman.length + data.slackUnlinked.length + data.teamsDisagree.length;
  // The page's one lime action: the first join that can go ahead.
  const primaryKey = data.sameHuman.find((item) => item.canJoin && !joining.has(fromOf(item)))?.key;

  if (total === 0) return <NothingToDecide />;

  return (
    <div className="flex min-w-0 flex-col gap-3.5 short:gap-3">
      {data.sameHuman.length ? (
        <ReviewSection
          id="same-human"
          title="Same human?"
          tip="Team members that share an email or a name. Joining keeps one and moves the other’s records and credit to it. Code only suggests; you decide."
          meta="Same email first, then same name"
          count={data.sameHuman.length}
        >
          {data.sameHuman.map((item) => (
            <SameHumanRow
              key={item.key}
              item={item}
              data={data}
              memberHref={href}
              primary={item.key === primaryKey}
              joining={joining.has(fromOf(item))}
              onJoin={setJoinItem}
            />
          ))}
        </ReviewSection>
      ) : null}
      {data.slackUnlinked.length ? (
        <ReviewSection
          id="slack-only"
          title="Slack users linked to nobody"
          tip="Slack users the bot saw post qualified leads, with no CRM login and no other record. Their leads still count; linking them gives them a team member to belong to."
          meta="No login, lead gen worker or DM closer"
          count={data.slackUnlinked.length}
        >
          {data.slackUnlinked.map((item) => (
            <SlackUnlinkedRow key={item.key} item={item} data={data} memberHref={href} />
          ))}
        </ReviewSection>
      ) : null}
      {data.teamsDisagree.length ? (
        <ReviewSection
          id="teams-disagree"
          title="Teams disagree"
          tip="Team members whose lead gen worker is on one team and whose DM closer is on another, so Lead Gen and DM links credit different teams."
          meta="Lead gen team and DM links team"
          count={data.teamsDisagree.length}
        >
          {data.teamsDisagree.map((item) => (
            <TeamsDisagreeRow key={item.key} item={item} data={data} memberHref={href} />
          ))}
        </ReviewSection>
      ) : null}
      {joinItem ? <JoinFor item={joinItem} data={data} onClose={() => setJoinItem(null)} onJoining={(id) => setJoining((prev) => new Set(prev).add(id))} /> : null}
    </div>
  );
}

function fromOf(item: SameHumanItem): MemberId {
  return item.members.find((id) => id !== item.into) ?? item.members[0];
}

function JoinFor({
  item,
  data,
  onClose,
  onJoining,
}: {
  item: SameHumanItem;
  data: ReviewData;
  onClose: () => void;
  onJoining: (from: MemberId) => void;
}) {
  const into = data.member(item.into);
  const from = data.member(fromOf(item));
  if (!into?.teamMemberId || !from?.teamMemberId) return null;
  return (
    <JoinDialog
      from={{ ...from, teamMemberId: from.teamMemberId }}
      into={{ ...into, teamMemberId: into.teamMemberId }}
      teamName={data.teamName}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      onJoined={(done) => {
        if (!done) onJoining(from.teamMemberId!);
      }}
    />
  );
}

function NothingToDecide() {
  return (
    <div className={`${CARD} flex items-start gap-3 px-4 py-4`}>
      <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-stage-follow-up-ink">
        <CheckIcon className="size-3.5" aria-hidden />
      </span>
      <div>
        <p className="text-[14px] font-medium">Nothing to decide</p>
        <p className="mt-0.5 text-[13px] text-muted-foreground">
          No two team members share an email or a name, every Slack user belongs to someone or was left Slack-only, and
          every lead gen and DM team agrees. New matches show here as records come in.
        </p>
      </div>
    </div>
  );
}
