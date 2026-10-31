"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Skeleton } from "@/components/ui/skeleton";
import { useBusinessDay } from "@/hooks/use-business-day";
import { useNow } from "@/hooks/use-now";
import { dealProgramName } from "@/lib/person-page";
import { isShownOnTimeline, timelineSentence } from "@/lib/person-timeline";
import { cn } from "@/lib/utils";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import {
  DetailCard,
  DetailCardFooter,
  detailLinkClass,
} from "@/app/workspace/closer/meetings/_components/detail-card";
import { useEntityDetail } from "./entity-detail-context";
import { personDate, personDateTime, personShortDate } from "./person-format";

/** How many events the server sends per page. */
const PAGE_SIZE = 100;
/** How many rows the card adds per "Show older". */
const SHOWN_STEP = 10;

/** The event's dot on the stage scale. */
function dotClass(eventType: string, toStatus: string | null) {
  if (eventType === "payment.disputed" || eventType === "payment.voided") return "bg-stage-lost";
  if (
    eventType.startsWith("payment.") ||
    eventType.startsWith("customer.") ||
    eventType === "enrollment.created"
  ) {
    return "bg-stage-won";
  }
  if (
    eventType === "meeting.no_show" ||
    eventType === "meeting.canceled" ||
    eventType === "invitee.canceled" ||
    eventType === "opportunity.marked_lost" ||
    eventType === "opportunity.deleted"
  ) {
    return "bg-stage-lost";
  }
  if (
    eventType === "meeting.created" ||
    eventType === "invitee.created" ||
    eventType === "followUp.booked" ||
    eventType === "slack_qualified_lead_booked"
  ) {
    return "bg-stage-booked";
  }
  if (eventType.startsWith("followUp.")) return "bg-stage-follow-up";
  if (eventType === "lead.lifecycle_stage_changed" && (toStatus ?? "").toLowerCase() === "customer") {
    return "bg-stage-won";
  }
  if (eventType === "opportunity.stage_changed" || eventType === "opportunity.status_changed") {
    const to = (toStatus ?? "").toLowerCase();
    // Stages read "Closed (won)" and "Closed (lost)"; old statuses "Won", "Lost".
    if (to.includes("won")) return "bg-stage-won";
    if (to.includes("lost")) return "bg-stage-lost";
    if (to.startsWith("follow")) return "bg-stage-follow-up";
    if (to.startsWith("booked")) return "bg-stage-booked";
  }
  return "bg-stage-held";
}

/**
 * The person's history, newest first: every touch and change from the
 * event log (docs/plans/phase-2-person-first.md §6.1), one short sentence
 * per event, "fact · deal" (`timelineSentence`), beside its business day
 * and a dot on the stage scale. It sits in the rail, after Source.
 */
export function PersonTimelineCard() {
  const { lead, opportunities, businessTimeZone } = useEntityDetail();
  const { setting } = useBusinessDay();
  const now = useNow();
  const programById = new Map(
    opportunities.map(({ opportunity }) => [opportunity._id as string, dealProgramName(opportunity)]),
  );
  const programOf = (opportunityId: string) => programById.get(opportunityId) ?? null;
  const dayOf = (ms: number) => personDate(ms, setting, now);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [shownCount, setShownCount] = useState(SHOWN_STEP);
  const latest = useQuery(api.leadCustomers.timeline.getLeadTimeline, {
    leadId: lead._id,
    limit,
  });
  // Keeps the entries on screen while "Show older" loads a bigger page.
  const [kept, setKept] = useState<{ leadId: string; data: typeof latest }>({
    leadId: lead._id,
    data: undefined,
  });
  if (latest !== undefined && (kept.data !== latest || kept.leadId !== lead._id)) {
    setKept({ leadId: lead._id, data: latest });
  }
  const timeline = latest ?? (kept.leadId === lead._id ? kept.data : undefined);
  const entries = (timeline?.entries ?? []).filter(isShownOnTimeline);
  const shown = entries.slice(0, shownCount);
  const moreLoaded = entries.length > shownCount;
  const canShowOlder = moreLoaded || Boolean(timeline?.hasMore);

  const showOlder = () => {
    if (!moreLoaded && timeline?.hasMore) setLimit((current) => current + PAGE_SIZE);
    setShownCount((current) => current + SHOWN_STEP);
  };

  return (
    <DetailCard
      title="Timeline"
      meta={
        entries.length > 0 ? (
          <span className="tabular-nums">
            <b className="font-condensed text-sm font-semibold text-foreground">
              {entries.length}
              {timeline?.hasMore ? "+" : ""}
            </b>{" "}
            {entries.length === 1 ? "event" : "events"}
          </span>
        ) : null
      }
    >
      {timeline === undefined ? (
        <div role="status" aria-label="Loading the timeline" className="flex flex-col gap-2 px-4 py-3">
          {Array.from({ length: 5 }).map((_, index) => (
            <Skeleton key={index} className="h-5 w-full" />
          ))}
        </div>
      ) : timeline === null ? (
        <SectionEmpty title="No timeline for this person." />
      ) : entries.length === 0 ? (
        <SectionEmpty title="No events yet.">
          Bookings, calls, payments and notes appear here as they happen.
        </SectionEmpty>
      ) : (
        <ol className="py-1.5" aria-busy={latest === undefined}>
          {shown.map((entry) => {
            const { fact, figure, subject } = timelineSentence(entry, programOf, dayOf);
            return (
              <li
                key={entry.eventId}
                className="grid grid-cols-[3.25rem_6px_minmax(0,1fr)] items-start gap-x-2.5 px-4 py-[5px] text-[0.8125rem]"
                title={entry.actorName ? `By ${entry.actorName}` : undefined}
              >
                <time
                  dateTime={new Date(entry.occurredAt).toISOString()}
                  title={personDateTime(entry.occurredAt, businessTimeZone)}
                  className="font-condensed text-[0.8125rem] leading-5 font-semibold tracking-[0.02em] text-muted-foreground tabular-nums"
                  suppressHydrationWarning
                >
                  {personShortDate(entry.occurredAt, setting, now)}
                </time>
                <span
                  aria-hidden
                  className={cn("mt-[7px] size-1.5 rounded-full", dotClass(entry.eventType, entry.toStatus))}
                />
                <p className="min-w-0 leading-5 wrap-break-word" suppressHydrationWarning>
                  <span className="font-medium">{fact}</span>
                  {figure ? (
                    <>
                      {" · "}
                      <span className="font-condensed text-sm font-semibold tracking-[0.02em] tabular-nums">
                        {figure}
                      </span>
                    </>
                  ) : null}
                  {subject ? (
                    <span className="text-muted-foreground" translate="no">
                      {" · "}
                      {subject}
                    </span>
                  ) : null}
                </p>
              </li>
            );
          })}
        </ol>
      )}
      {canShowOlder || timeline?.capped ? (
        <DetailCardFooter className="text-[0.8125rem]">
          <span>{timeline?.capped && !canShowOlder ? "Older events aren’t shown." : `Showing ${shown.length}`}</span>
          {canShowOlder ? (
            <button type="button" className={detailLinkClass} onClick={showOlder}>
              Show older
            </button>
          ) : null}
        </DetailCardFooter>
      ) : null}
    </DetailCard>
  );
}
