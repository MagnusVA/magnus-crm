"use client";

import Link from "next/link";
import { format } from "date-fns";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { HistoryIcon } from "lucide-react";
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

type MeetingHistoryCardProps = {
  meetingHistory: MeetingHistoryEntry[];
  meetingDetailBasePath?: string;
};

/**
 * Compact meeting-history card.
 *
 * Dense one-line-per-meeting rows with a status dot + badge, capped to a
 * scrollable region so a long history never bloats the layout. The current
 * meeting is highlighted and non-interactive; others link to their detail page.
 */
export function MeetingHistoryCard({
  meetingHistory,
  meetingDetailBasePath = "/workspace/closer/meetings",
}: MeetingHistoryCardProps) {
  if (meetingHistory.length === 0) return null;

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <HistoryIcon className="size-4 text-muted-foreground" aria-hidden />
          Meeting History
          <span className="text-xs font-normal text-muted-foreground">
            ({meetingHistory.length})
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ScrollArea className="max-h-44">
          <ol className="flex flex-col gap-0.5 pr-2" aria-label="Lead meeting history">
            {meetingHistory.map((meeting) => {
              const statusKey = meeting.opportunityStatus as OpportunityStatus;
              const config = opportunityStatusConfig[statusKey];

              const row = (
                <div
                  className={cn(
                    "flex items-center gap-2.5 rounded-md px-1.5 py-1.5",
                    meeting.isCurrentMeeting
                      ? "bg-primary/5"
                      : "transition-colors hover:bg-accent/50",
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      meeting.isCurrentMeeting
                        ? "bg-primary ring-[3px] ring-primary/20"
                        : config?.dotClass ?? "bg-muted-foreground",
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <p
                      className={cn(
                        "truncate text-xs font-medium",
                        meeting.isCurrentMeeting && "text-primary",
                      )}
                    >
                      {format(meeting.scheduledAt, "MMM d, yyyy · h:mm a")}
                    </p>
                  </div>
                  <Badge
                    variant="secondary"
                    className={cn("shrink-0 text-[10px]", config?.badgeClass)}
                  >
                    {meeting.isCurrentMeeting ? "Current" : config?.label ?? "—"}
                  </Badge>
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
                      href={`${meetingDetailBasePath}/${meeting._id}`}
                      className="block rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {row}
                    </Link>
                  )}
                </li>
              );
            })}
          </ol>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
