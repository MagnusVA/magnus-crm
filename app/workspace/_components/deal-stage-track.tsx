import type { AttributionCredit, DealAttributionDetail } from "@/convex/lib/attribution/detailPayload";
import {
  DEAL_POSITION_LABELS,
  type DealPosition,
  type SystemLossReason,
} from "@/convex/opportunities/stages";
import { STAGE_TONE } from "@/app/workspace/closer/meetings/_components/stage-tone";
import { cn } from "@/lib/utils";

// The deal's stage track and its credit line, shared by the meeting and
// task pages' Deal card, the person page's deal cards and the deal modal
// (DESIGN.md, "DealCard and the Stage Track").

/**
 * The stages this deal's track shows. The funnel's order, with the deal's
 * own ending: Won, Lost, or Lost straight from Booked when a missed call
 * closed it.
 */
export function dealTrackOf(position: DealPosition, missedCall: boolean): DealPosition[] {
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

/**
 * One node per stage on the deal's path: passed nodes filled with the
 * current stage's colour, the current one a ring of it, later ones faint.
 */
export function DealStageTrack({
  position,
  systemLoss,
  className,
}: {
  position: DealPosition;
  systemLoss: SystemLossReason | null;
  className?: string;
}) {
  const missedCall = systemLoss === "no_show" || systemLoss === "canceled";
  const track = dealTrackOf(position, missedCall);
  const current = track.indexOf(position);
  const tone = STAGE_TONE[position];

  return (
    <ol
      aria-label={`Deal stage: ${DEAL_POSITION_LABELS[position]}`}
      className={cn("grid px-2 pt-3.5 pb-1", className)}
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
  );
}

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

export const TOUCH_CHANNEL_LABELS = {
  lead_gen: "Lead gen",
  dm_portal: "DM portal",
  slack: "Slack",
  calendly: "Calendly",
  side_deal: "Side deal",
} as const;

/** What the credit line reads: the deal's credit rows, else who its booking points at. */
export type DealCreditSource = {
  dealAttribution: Pick<DealAttributionDetail, "credits"> | null;
  attributionTeam?: { displayName: string } | null;
  dmCloser?: { displayName: string } | null;
  assignedCloser?: { fullName?: string; email: string } | null;
};

type CreditPart = { key: string; role: string; name: string };

/**
 * One "Role Name" pair per credit, in funnel order. A person credited twice
 * in the same role (a deal can carry a credit row per booking) is named once.
 */
export function dealCreditParts(source: DealCreditSource): CreditPart[] {
  const credits = source.dealAttribution?.credits ?? [];
  if (credits.length > 0) {
    const seen = new Set<string>();
    return [...credits]
      .sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role))
      .map((credit) => ({
        key: credit.id,
        role: credit.sourceKind === "respark" ? "Respark" : ROLE_LABELS[credit.role],
        name: credit.name ?? "Unknown",
      }))
      .filter((part) => {
        const id = `${part.role}|${part.name}`;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
  }
  // A deal with no attribution rows still names who the booking points at.
  const parts: CreditPart[] = [];
  if (source.attributionTeam) {
    parts.push({ key: "team", role: "DM team", name: source.attributionTeam.displayName });
  }
  if (source.dmCloser) {
    parts.push({ key: "dm", role: "DM closer", name: source.dmCloser.displayName });
  }
  if (source.assignedCloser) {
    parts.push({
      key: "closer",
      role: "Closer",
      name: source.assignedCloser.fullName ?? source.assignedCloser.email,
    });
  }
  return parts;
}

/** "Lead gen **Ana** · Closer **Bo**", in 13px slate. */
export function DealCreditLine({
  source,
  className,
}: {
  source: DealCreditSource;
  className?: string;
}) {
  const credits = dealCreditParts(source);
  return (
    <p className={cn("px-4 pt-2 pb-3 text-[0.8125rem] leading-relaxed text-muted-foreground", className)}>
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
  );
}

