"use client";

import Link from "next/link";
import { format } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  opportunityStatusConfig,
  type OpportunityStatus,
} from "@/lib/status-config";
import type { Doc } from "@/convex/_generated/dataModel";

type MeetingHistoryEntry = Doc<"meetings"> & {
  opportunityStatus: Doc<"opportunities">["status"];
  isCurrentMeeting: boolean;
};

type MeetingHistoryTimelineProps = {
  meetingHistory: MeetingHistoryEntry[];
};

/**
 * Vertical timeline of all meetings for a lead across all opportunities.
 *
 * - Status‑colored dots from centralised `status-config.ts` (all 7 statuses)
 * - Current meeting highlighted with primary ring
 * - Other meetings link to their detail pages for easy navigation
 * - Semantic `<ol>` with `aria-label` and `aria-current` for accessibility
 */
export function MeetingHistoryTimeline({
  meetingHistory,
}: MeetingHistoryTimelineProps) {
  if (meetingHistory.length === 0) return null;

  return (
    <ol className="flex flex-col" aria-label="Lead meeting history">
      {meetingHistory.map((meeting, idx) => {
        const statusKey = meeting.opportunityStatus as OpportunityStatus;
        const config = opportunityStatusConfig[statusKey];
        const isLast = idx === meetingHistory.length - 1;

        const row = (
          <div className="flex items-start gap-3 py-2">
            {/* Dot + vertical connector */}
            <div className="flex flex-col items-center pt-1.5">
              <div
                className={cn(
                  "size-2.5 shrink-0 rounded-full",
                  meeting.isCurrentMeeting
                    ? "bg-primary ring-[3px] ring-primary/25"
                    : config?.dotClass ?? "bg-muted-foreground",
                )}
              />
              {!isLast && <div className="my-1 min-h-5 w-px bg-border" />}
            </div>

            {/* Meeting info */}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <p
                  className={cn(
                    "text-sm font-medium",
                    meeting.isCurrentMeeting && "text-primary",
                  )}
                >
                  {format(meeting.scheduledAt, "MMM d, yyyy")}
                </p>
                <Badge
                  variant="secondary"
                  className={cn("text-[10px]", config?.badgeClass)}
                >
                  {config?.label ?? "Unknown"}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                {format(meeting.scheduledAt, "h:mm a")}
                {meeting.isCurrentMeeting && (
                  <span className="ml-1.5 font-medium text-primary">
                    · Current
                  </span>
                )}
              </p>
            </div>
          </div>
        );

        return (
          <li
            key={meeting._id}
            aria-current={meeting.isCurrentMeeting ? "step" : undefined}
          >
            {meeting.isCurrentMeeting ? (
              row
            ) : (
              <Link
                href={`/workspace/closer/meetings/${meeting._id}`}
                className="-mx-1 block rounded-md px-1 transition-colors hover:bg-accent/50"
              >
                {row}
              </Link>
            )}
          </li>
        );
      })}
    </ol>
  );
}
