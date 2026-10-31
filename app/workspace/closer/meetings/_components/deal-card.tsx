"use client";

import Link from "next/link";
import { format } from "date-fns";
import type { Id } from "@/convex/_generated/dataModel";
import type { DealAttributionDetail } from "@/convex/lib/attribution/detailPayload";
import type { DealPosition, SystemLossReason } from "@/convex/opportunities/stages";
import {
  DealCreditLine,
  DealStageTrack,
  TOUCH_CHANNEL_LABELS,
} from "@/app/workspace/_components/deal-stage-track";
import { DetailCard, DetailCardFooter, detailLinkClass } from "./detail-card";
import { StageChip } from "./stage-tone";

/**
 * What the card reads. The meeting page passes its `MeetingDetail`; the task
 * page passes the deal without a meeting.
 */
export type DealCardDetail = {
  opportunity: {
    _id: Id<"opportunities">;
    position: DealPosition;
    systemLoss: SystemLossReason | null;
    soldProgramName?: string;
    firstBookingProgramName?: string;
  };
  /** The page's call, whose programs come before the deal's. */
  meeting?: { soldProgramName?: string; bookingProgramName?: string } | null;
  lead: { _id: Id<"leads"> };
  dealAttribution: Pick<DealAttributionDetail, "credits" | "firstTouch"> | null;
  attributionTeam: { displayName: string } | null;
  dmCloser: { displayName: string } | null;
  assignedCloser: { fullName?: string; email: string } | null;
};

/**
 * The deal behind this call or task: its stage on the funnel, who gets
 * credit, a fact in the footer (its first touch unless the page passes
 * another, such as its payments), and a link to the deal on the person's
 * page.
 */
export function DealCard({
  detail,
  fact,
}: {
  detail: DealCardDetail;
  /** Replaces the footer's first-touch line. */
  fact?: React.ReactNode;
}) {
  const { opportunity, meeting, lead } = detail;
  const position = opportunity.position;
  const programName =
    (position === "won"
      ? (meeting?.soldProgramName ?? opportunity.soldProgramName)
      : null) ??
    meeting?.bookingProgramName ??
    opportunity.firstBookingProgramName ??
    null;
  const firstTouch = detail.dealAttribution?.firstTouch ?? null;

  return (
    <DetailCard
      title="Deal"
      badge={<StageChip position={position} systemLoss={opportunity.systemLoss} />}
      meta={
        programName ? (
          <span className="truncate" title={programName}>
            {programName}
          </span>
        ) : null
      }
    >
      <DealStageTrack position={position} systemLoss={opportunity.systemLoss} />

      <DealCreditLine source={detail} />

      <DetailCardFooter>
        <span className="text-[0.8125rem]">
          {fact ??
            (firstTouch
              ? `First touch ${TOUCH_CHANNEL_LABELS[firstTouch.channel]} · ${format(firstTouch.occurredAt, "MMM d")}`
              : "First touch not recorded")}
        </span>
        <Link
          href={`/workspace/leads-customers/${lead._id}?opportunityId=${opportunity._id}`}
          className={detailLinkClass}
        >
          Open deal
        </Link>
      </DetailCardFooter>
    </DetailCard>
  );
}
