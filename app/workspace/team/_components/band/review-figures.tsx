"use client";

import { QuietBoundary, useReviewCounts } from "../review/review-count";
import { BandFigure, BandFigures, BandFiguresPlaceholder } from "./band-figure";

// Team › Review: the band's figures, its one lime action, and the open-items
// count on the Review tab. The band (../team-band.tsx) renders these. All of
// them read the same review query as the page and the sidebar badge.

/** Same human?, Slack-only and Teams disagree: how many of each are open. */
export function ReviewFigures() {
  return (
    <QuietBoundary>
      <Figures />
    </QuietBoundary>
  );
}

function Figures() {
  const counts = useReviewCounts();
  if (!counts) return <BandFiguresPlaceholder />;
  return (
    <BandFigures>
      <BandFigure
        label="Same human?"
        tip="Team members that share an email or a name and may be one human. Joining them moves their records and credit to one; code never joins them on its own."
        value={counts.sameHuman}
        caption="email or name matches"
        tone={counts.sameHuman ? "warning" : "default"}
      />
      <BandFigure
        label="Slack-only"
        tip="Slack users the bot saw post qualified leads, with no CRM login and no other record. Their leads still count; they have no team until you link them."
        value={counts.slackOnly}
        caption="linked to nobody"
        tone={counts.slackOnly ? "warning" : "default"}
      />
      <BandFigure
        label="Teams disagree"
        tip="Team members whose lead gen team differs from their DM closer’s team, so Lead Gen and DM links credit different teams."
        value={counts.teamsDisagree}
        caption="lead gen vs DM links"
        tone={counts.teamsDisagree ? "warning" : "default"}
      />
    </BandFigures>
  );
}

/** The Review tab has no lime action on the band: each decision sits on its row. */
export function ReviewAction() {
  return null;
}

/**
 * The open review items, as an amber count on the Review tab. Nothing while
 * loading, at zero, or if the review can't be read (a tenant too large to
 * review): the count is a hint, and the band must not fail with it.
 */
export function ReviewTabCount() {
  return (
    <QuietBoundary>
      <OpenCount />
    </QuietBoundary>
  );
}

function OpenCount() {
  const count = useReviewCounts()?.total ?? 0;
  if (count <= 0) return null;
  return (
    <span
      className="rounded-[4px] bg-board-foreground/8 px-[5px] py-[3px] font-condensed text-[12px] leading-none tracking-[0.02em] text-warning tabular-nums"
      aria-label={`${count} open`}
    >
      {count}
    </span>
  );
}
