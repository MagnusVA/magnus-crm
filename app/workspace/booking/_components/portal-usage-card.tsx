"use client";

import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { getMemberDisplayName, MemberAvatar } from "@/app/workspace/_components/member-avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { CalendlyDot } from "./calendly-dot";
import { PortalCard, PortalCardFoot } from "./portal/portal-card";

const TITLE = "Recent link copies";
const META = "Who copied which link. Links themselves aren’t stored.";
const COLLAPSED_COUNT = 8;

const TIMESTAMP_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const SHORT_DATE_FORMAT = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

function formatTimestamp(timestamp: number) {
  return TIMESTAMP_FORMAT.format(timestamp);
}

/** "25 min ago", "4 hours ago", "3 days ago", then the date. */
export function shortAgo(timestamp: number, now: number) {
  const minutes = Math.floor((now - timestamp) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  return SHORT_DATE_FORMAT.format(timestamp);
}

/**
 * Concept C's Recent link copies: who copied, which program and campaign,
 * and which team and event type the link pointed at (with its Calendly
 * colour), newest first.
 */
export function PortalUsageCard() {
  const events = useQuery(api.linkPortal.copyQueries.listRecentCopyEvents, { limit: 25 });
  const coverage = useQuery(api.bookingSetup.queries.getCoverage, {});
  const [expanded, setExpanded] = useState(false);
  // One clock per render of the list, so every row ages together.
  const [now] = useState(() => Date.now());
  const colorById = useMemo(
    () => new Map((coverage?.eventTypes ?? []).map((eventType) => [eventType._id as string, eventType.calendlyColor])),
    [coverage],
  );

  if (events === undefined) {
    return (
      <PortalCard id="card-copies" title={TITLE} meta={META}>
        <div role="status" aria-label="Loading recent link copies">
          {Array.from({ length: 5 }, (_, row) => (
            <div key={row} className="grid grid-cols-[30px_minmax(0,1fr)_auto] gap-2.5 border-b border-border px-4 py-[9px] last:border-b-0">
              <Skeleton className="size-7 rounded-full" />
              <div className="flex flex-col gap-1.5">
                <Skeleton className="h-3.5 w-32" />
                <Skeleton className="h-3 w-44" />
                <Skeleton className="h-3 w-52" />
              </div>
              <Skeleton className="h-3 w-14" />
            </div>
          ))}
        </div>
      </PortalCard>
    );
  }

  const visible = expanded ? events : events.slice(0, COLLAPSED_COUNT);

  return (
    <PortalCard id="card-copies" title={TITLE} meta={META}>
      {events.length === 0 ? (
        <p className="px-4 py-5 text-[13px] text-muted-foreground">
          No copies yet. When a DM closer taps a link in the portal, it shows up here.
        </p>
      ) : (
        <ol aria-label={TITLE}>
          {visible.map((event) => {
            const name = event.dmCloser ? getMemberDisplayName(event.dmCloser) : event.dmCloserName;
            return (
              <li
                key={event.id}
                className="grid grid-cols-[30px_minmax(0,1fr)_auto] items-start gap-2.5 border-b border-border px-4 py-[9px] last:border-b-0"
              >
                {event.dmCloser ? (
                  <MemberAvatar identity={event.dmCloser} className="size-7" />
                ) : (
                  <span aria-hidden className="size-7 rounded-full bg-muted" />
                )}
                <div className="min-w-0">
                  <div className="truncate text-[13.5px] font-medium">{name}</div>
                  <div className="truncate text-[12px] text-muted-foreground">
                    {event.bookingProgramName}
                    <span aria-hidden> · </span>
                    <span title={`utm_campaign=${event.utmCampaign}`}>{event.campaignLabel}</span>
                  </div>
                  <div
                    className="flex min-w-0 items-center gap-1 text-[12px] text-muted-foreground"
                    title={`${event.attributionTeamName} · ${event.eventTypeName}`}
                  >
                    <span className="flex-none">{event.attributionTeamName}</span>
                    <span aria-hidden className="flex-none">
                      ·
                    </span>
                    <CalendlyDot color={colorById.get(event.eventTypeConfigId)} />
                    <span className="truncate">{event.eventTypeName}</span>
                  </div>
                </div>
                <time
                  dateTime={new Date(event.copiedAt).toISOString()}
                  title={formatTimestamp(event.copiedAt)}
                  className="font-condensed text-[12.5px] leading-[1.4] font-semibold whitespace-nowrap text-muted-foreground tabular-nums"
                >
                  {shortAgo(event.copiedAt, now)}
                </time>
              </li>
            );
          })}
        </ol>
      )}
      {events.length > COLLAPSED_COUNT ? (
        <PortalCardFoot>
          <span>
            <b className="font-condensed text-[15px] font-semibold text-foreground tabular-nums">{visible.length}</b> of{" "}
            {events.length} shown
          </span>
          <button
            type="button"
            className="ml-auto font-medium text-primary-ink underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "Show fewer" : `Show all ${events.length}`}
          </button>
        </PortalCardFoot>
      ) : null}
    </PortalCard>
  );
}
