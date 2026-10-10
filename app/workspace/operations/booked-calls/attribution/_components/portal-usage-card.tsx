"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { formatDistanceToNowStrict } from "date-fns";
import { api } from "@/convex/_generated/api";
import {
  getMemberDisplayName,
  MemberAvatar,
} from "@/app/workspace/_components/member-avatar";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

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
      <Skeleton
        className="h-64 w-full"
        role="status"
        aria-label="Loading recent portal copy activity"
      />
    );
  }

  const visibleEvents = expanded ? events : events.slice(0, COLLAPSED_COUNT);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent Link Copies</CardTitle>
        <CardDescription>
          Who copied which link. Generated URLs aren&apos;t stored.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {events.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No portal copy activity recorded yet.
          </p>
        ) : (
          <>
            <ol className="flex flex-col divide-y">
              {visibleEvents.map((event) => (
                <li
                  key={event.id}
                  className="flex gap-3 py-2.5 first:pt-0 last:pb-0"
                >
                  {event.dmCloser ? (
                    <MemberAvatar identity={event.dmCloser} className="mt-0.5" />
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-sm font-medium">
                        {event.dmCloser
                          ? getMemberDisplayName(event.dmCloser)
                          : event.dmCloserName}
                      </span>
                      <time
                        dateTime={new Date(event.copiedAt).toISOString()}
                        title={formatTimestamp(event.copiedAt)}
                        className="shrink-0 text-xs tabular-nums text-muted-foreground"
                      >
                        {formatDistanceToNowStrict(event.copiedAt, {
                          addSuffix: true,
                        })}
                      </time>
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {event.bookingProgramName}
                      <span aria-hidden="true"> · </span>
                      <span title={event.utmCampaign}>
                        {event.campaignLabel}
                      </span>
                    </p>
                    <p
                      className="truncate text-xs text-muted-foreground/70"
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
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mt-3 w-full"
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded ? "Show less" : `Show all ${events.length}`}
              </Button>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
