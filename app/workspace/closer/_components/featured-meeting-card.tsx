"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { format, formatDistanceToNow } from "date-fns";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardAction,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  VideoIcon,
  ArrowRightIcon,
  ClockIcon,
  CalendarDaysIcon,
  UserIcon,
} from "lucide-react";

type FeaturedMeetingCardProps = {
  meeting: {
    _id: string;
    scheduledAt: number;
    durationMinutes: number;
    zoomJoinUrl?: string;
  };
  lead: {
    fullName?: string;
    email: string;
  } | null;
  eventTypeName: string | null;
};

/**
 * Hero card for the closer's next scheduled meeting.
 *
 * Displays lead info, event type, meeting time, a live countdown that
 * refreshes every minute, and action buttons (Join Zoom / View Details).
 *
 * Visual hierarchy: a colored left‑border signals urgency —
 *   primary (> 30 min), amber (< 30 min), emerald (started).
 */
export function FeaturedMeetingCard({
  meeting,
  lead,
  eventTypeName,
}: FeaturedMeetingCardProps) {
  // Lazy initial value avoids calling Date.now() on every render
  // (rerender-lazy-state-init)
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const timeUntil = meeting.scheduledAt - now;
  const isStartingSoon = timeUntil > 0 && timeUntil < 30 * 60 * 1000;
  const hasStarted = timeUntil <= 0;

  const countdownText = hasStarted
    ? "Starting now"
    : formatDistanceToNow(meeting.scheduledAt, { addSuffix: true });

  return (
    <Card
      className={cn(
        "border-l-[3px]",
        hasStarted
          ? "border-l-emerald-500"
          : isStartingSoon
            ? "border-l-amber-500"
            : "border-l-primary",
      )}
    >
      <CardHeader>
        <div className="flex items-center gap-2.5">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
            <UserIcon className="size-4 text-primary" />
          </div>
          <div className="min-w-0">
            <CardTitle className="truncate">
              {lead?.fullName ?? lead?.email ?? "Unknown Lead"}
            </CardTitle>
            {lead?.fullName && lead.email && (
              <p className="truncate text-xs text-muted-foreground">
                {lead.email}
              </p>
            )}
          </div>
        </div>
        <CardAction>
          <Badge
            variant={isStartingSoon || hasStarted ? "default" : "secondary"}
            aria-live="polite"
            className={cn(
              isStartingSoon &&
                "bg-amber-500/15 text-amber-700 dark:text-amber-400",
              hasStarted &&
                "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
            )}
          >
            <ClockIcon data-icon="inline-start" />
            {countdownText}
          </Badge>
        </CardAction>
      </CardHeader>

      <CardContent>
        <div className="flex flex-col gap-4">
          {/* Meeting details */}
          <div className="flex flex-col gap-1.5 text-sm text-muted-foreground">
            {eventTypeName && (
              <div className="flex items-center gap-2">
                <CalendarDaysIcon className="size-3.5 shrink-0" />
                <span>{eventTypeName}</span>
              </div>
            )}
            <div className="flex items-center gap-2">
              <ClockIcon className="size-3.5 shrink-0" />
              <span>
                {format(meeting.scheduledAt, "EEEE, MMM d · h:mm a")}
                {" · "}
                {meeting.durationMinutes}&nbsp;min
              </span>
            </div>
          </div>

          {/* Actions */}
          <div className="flex flex-wrap items-center gap-2">
            {meeting.zoomJoinUrl && (
              <Button asChild>
                <a
                  href={meeting.zoomJoinUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <VideoIcon data-icon="inline-start" />
                  Join Meeting
                </a>
              </Button>
            )}
            <Button variant="outline" asChild>
              <Link href={`/workspace/closer/meetings/${meeting._id}`}>
                View Details
                <ArrowRightIcon data-icon="inline-end" />
              </Link>
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
