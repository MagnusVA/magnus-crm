"use client";

import Link from "next/link";
import { format } from "date-fns";
import type { AttributionCredit } from "@/convex/lib/attribution/detailPayload";
import {
  DEAL_POSITION_LABELS,
  type DealPosition,
} from "@/convex/opportunities/stages";
import { cn } from "@/lib/utils";
import { DetailCard, DetailCardFooter, detailLinkClass } from "./detail-card";
import { STAGE_TONE, StageChip } from "./stage-tone";
import type { MeetingDetail } from "./meeting-detail-types";

const ROLE_LABELS: Record<AttributionCredit["role"], string> = {
  lead_gen: "Lead gen",
  setter: "Setter",
  dm_team: "DM team",
  dm_closer: "DM closer",
  closer: "Closer",
};

const ROLE_ORDER: AttributionCredit["role"][] = [
  "lead_gen",
  "setter",
  "dm_team",
  "dm_closer",
  "closer",
];

const CHANNEL_LABELS = {
  lead_gen: "Lead gen",
  dm_portal: "DM portal",
  slack: "Slack",
  calendly: "Calendly",
  side_deal: "Side deal",
} as const;

/**
 * The stages this deal's track shows. The funnel's order, with the deal's
 * own ending: Won, Lost, or Lost straight from Booked when a missed call
 * closed it.
 */
function trackOf(
  position: DealPosition,
  missedCall: boolean,
): DealPosition[] {
  if (position === "lost") {
    return missedCall
      ? ["qualified", "booked", "lost"]
      : ["qualified", "booked", "call_held", "lost"];
  }
  if (position === "follow_up") {
    return ["qualified", "booked", "call_held", "follow_up", "won"];
  }
  return ["qualified", "booked", "call_held", "won"];
}

type CreditPart = { key: string; role: string; name: string };

/** One "Role Name" pair per credit, in funnel order. */
function creditParts(detail: MeetingDetail): CreditPart[] {
  const credits = detail.dealAttribution?.credits ?? [];
  if (credits.length > 0) {
    return [...credits]
      .sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role))
      .map((credit) => ({
        key: credit.id,
        role: credit.sourceKind === "respark" ? "Respark" : ROLE_LABELS[credit.role],
        name: credit.name ?? "Unknown",
      }));
  }
  // A deal with no attribution rows still names who the booking points at.
  const parts: CreditPart[] = [];
  if (detail.attributionTeam) {
    parts.push({ key: "team", role: "DM team", name: detail.attributionTeam.displayName });
  }
  if (detail.dmCloser) {
    parts.push({ key: "dm", role: "DM closer", name: detail.dmCloser.displayName });
  }
  if (detail.assignedCloser) {
    parts.push({
      key: "closer",
      role: "Closer",
      name: detail.assignedCloser.fullName ?? detail.assignedCloser.email,
    });
  }
  return parts;
}

/**
 * The deal behind this call: its stage on the funnel, who gets credit, its
 * first touch, and a link to the deal on the person's page.
 */
export function DealCard({ detail }: { detail: MeetingDetail }) {
  const { opportunity, meeting, lead } = detail;
  const position = opportunity.position;
  const missedCall =
    opportunity.systemLoss === "no_show" || opportunity.systemLoss === "canceled";
  const track = trackOf(position, missedCall);
  const current = track.indexOf(position);
  const tone = STAGE_TONE[position];
  const programName =
    (position === "won"
      ? (meeting.soldProgramName ?? opportunity.soldProgramName)
      : null) ??
    meeting.bookingProgramName ??
    opportunity.firstBookingProgramName ??
    null;
  const credits = creditParts(detail);
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
      <ol
        aria-label={`Deal stage: ${DEAL_POSITION_LABELS[position]}`}
        className="grid px-2 pt-3.5 pb-1"
        style={{ gridTemplateColumns: `repeat(${track.length}, minmax(0, 1fr))` }}
      >
        {track.map((step, index) => {
          const reached = index <= current;
          return (
            <li
              key={step}
              aria-current={index === current ? "step" : undefined}
              className={cn(
                "relative flex flex-col items-center gap-1.5 text-center",
                index > 0 &&
                  "before:absolute before:top-[7px] before:right-1/2 before:-left-1/2 before:h-0.5 before:content-['']",
                index > 0 && (reached ? tone.line : "before:bg-border"),
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "relative z-10 size-4 rounded-full border-2",
                  index < current && tone.fill,
                  index === current && cn("border-[3px] bg-card", tone.ring),
                  index > current && "border-muted-foreground/40 bg-card",
                )}
              />
              <span
                className={cn(
                  "px-0.5 font-condensed text-[0.6875rem] leading-tight font-semibold tracking-[0.1em] uppercase",
                  index === current ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {DEAL_POSITION_LABELS[step]}
                {index < current ? <span className="sr-only"> (passed)</span> : null}
              </span>
            </li>
          );
        })}
      </ol>

      <p className="px-4 pt-2 pb-3 text-[0.8125rem] leading-relaxed text-muted-foreground">
        {credits.length === 0
          ? "No credit recorded on this deal."
          : credits.map((part, index) => (
              <span key={part.key}>
                {index > 0 ? " · " : null}
                {part.role}{" "}
                <b className="font-semibold text-foreground" translate="no">
                  {part.name}
                </b>
              </span>
            ))}
      </p>

      <DetailCardFooter>
        <span className="text-[0.8125rem]">
          {firstTouch
            ? `First touch ${CHANNEL_LABELS[firstTouch.channel]} · ${format(firstTouch.occurredAt, "MMM d")}`
            : "First touch not recorded"}
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
