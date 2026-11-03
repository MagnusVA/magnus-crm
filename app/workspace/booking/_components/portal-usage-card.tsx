"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { formatDistanceToNowStrict } from "date-fns";
import { api } from "@/convex/_generated/api";
import {
  getMemberDisplayName,
  MemberAvatar,
} from "@/app/workspace/_components/member-avatar";
import {
  DetailCard,
  DetailCardFooter,
  detailLinkClass,
} from "@/app/workspace/closer/meetings/_components/detail-card";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { Skeleton } from "@/components/ui/skeleton";
import { CardNote } from "./attribution-ui";

const TITLE = "Recent link copies";

const COLLAPSED_COUNT = 8;

function formatTimestamp(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

export function PortalUsageCard() {
  const events = useQuery(api.linkPortal.copyQueries.listRecentCopyEvents, {
    limit: 25,
  });
  const [expanded, setExpanded] = useState(false);

  if (events === undefined) {
    return (
      <DetailCard title={TITLE} className="min-w-0">
        <div role="status" aria-label="Loading recent portal copy activity" className="divide-y">
          {Array.from({ length: 4 }, (_, row) => (
            <div key={row} className="flex gap-3 px-4 py-2.5">
              <Skeleton className="size-8 shrink-0 rounded-full" />
              <div className="flex flex-1 flex-col gap-1.5">
                <Skeleton className="h-3.5 w-32" />
                <Skeleton className="h-3 w-48" />
                <Skeleton className="h-3 w-40" />
              </div>
            </div>
          ))}
        </div>
      </DetailCard>
    );
  }

  const visibleEvents = expanded ? events : events.slice(0, COLLAPSED_COUNT);

  return (
    <DetailCard title={TITLE} className="min-w-0">
      <CardNote>Who copied which link. Generated URLs aren&apos;t stored.</CardNote>
      {events.length === 0 ? (
        <SectionEmpty title="No portal copy activity recorded yet." />
      ) : (
        <>
          <ol aria-label={TITLE} className="flex flex-col divide-y">
            {visibleEvents.map((event) => (
              <li key={event.id} className="flex gap-3 px-4 py-2.5">
                {event.dmCloser ? (
                  <MemberAvatar identity={event.dmCloser} className="mt-0.5" />
                ) : null}
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate font-medium">
                      {event.dmCloser
                        ? getMemberDisplayName(event.dmCloser)
                        : event.dmCloserName}
                    </span>
                    <time
                      dateTime={new Date(event.copiedAt).toISOString()}
                      title={formatTimestamp(event.copiedAt)}
                      className="shrink-0 font-condensed text-[13px] font-semibold tracking-[0.02em] text-muted-foreground tabular-nums"
                    >
                      {formatDistanceToNowStrict(event.copiedAt, {
                        addSuffix: true,
                      })}
                    </time>
                  </div>
                  <p className="truncate text-[13px] text-muted-foreground">
                    {event.bookingProgramName}
                    <span aria-hidden="true"> · </span>
                    <span title={event.utmCampaign}>
                      {event.campaignLabel}
                    </span>
                  </p>
                  <p
                    className="truncate text-[13px] text-muted-foreground"
                    title={`${event.attributionTeamName} · ${event.eventTypeName}`}
                  >
                    {event.attributionTeamName}
                    <span aria-hidden="true"> · </span>
                    {event.eventTypeName}
                  </p>
                </div>
              </li>
            ))}
          </ol>
          {events.length > COLLAPSED_COUNT ? (
            <DetailCardFooter className="text-[13px] font-normal">
              <span>
                <span className="font-condensed text-[15px] font-semibold text-foreground tabular-nums">
                  {visibleEvents.length}
                </span>{" "}
                of {events.length} shown
              </span>
              <button
                type="button"
                className={detailLinkClass}
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded ? "Show less" : `Show all ${events.length}`}
              </button>
            </DetailCardFooter>
          ) : null}
        </>
      )}
    </DetailCard>
  );
}
