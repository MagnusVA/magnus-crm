"use client";

import { useState } from "react";
import Link from "next/link";
import { format } from "date-fns";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { DealStageBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ChevronDownIcon, HistoryIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { dealPositionConfig } from "@/lib/status-config";
import type { Doc } from "@/convex/_generated/dataModel";
import type { DealPosition, SystemLossReason } from "@/convex/opportunities/stages";

// Each meeting shows its deal's position (docs/plans/phase-5-deal-status.md §6.1).
type MeetingHistoryEntry = Doc<"meetings"> & {
  dealPosition: DealPosition;
  dealSystemLoss: SystemLossReason | null;
  isCurrentMeeting: boolean;
};

type MeetingHistoryCardProps = {
  meetingHistory: MeetingHistoryEntry[];
  meetingDetailBasePath?: string;
};

/**
 * Compact meeting-history card, collapsed by default.
 *
 * Dense one-line-per-meeting rows with a status dot + badge, capped to a
 * scrollable region so a long history never bloats the layout.
 */
export function MeetingHistoryCard({
  meetingHistory,
  meetingDetailBasePath = "/workspace/closer/meetings",
}: MeetingHistoryCardProps) {
  const [open, setOpen] = useState(false);

  if (meetingHistory.length === 0) return null;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <Card size="sm">
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer select-none transition-colors hover:bg-accent/30">
            <CardTitle className="flex items-center justify-between gap-2 text-sm">
              <span className="flex min-w-0 items-center gap-2">
                <HistoryIcon
                  className="size-4 shrink-0 text-muted-foreground"
                  aria-hidden
                />
                Meeting History
                <span className="text-xs font-normal text-muted-foreground">
                  ({meetingHistory.length})
                </span>
              </span>
              <ChevronDownIcon
                className={cn(
                  "size-4 shrink-0 text-muted-foreground transition-transform",
                  open && "rotate-180",
                )}
                aria-hidden
              />
            </CardTitle>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="pt-0">
            <ScrollArea className="max-h-44">
              <ol
                className="flex flex-col gap-0.5 pr-2"
                aria-label="Lead meeting history"
              >
                {meetingHistory.map((meeting) => {
                  const config = dealPositionConfig[meeting.dealPosition];

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
                            : config.dotClass,
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
                      {meeting.isCurrentMeeting ? (
                        <Badge
                          variant="secondary"
                          className={cn("shrink-0 text-[10px]", config.badgeClass)}
                        >
                          Current
                        </Badge>
                      ) : (
                        <DealStageBadge
                          position={meeting.dealPosition}
                          systemLoss={meeting.dealSystemLoss}
                          className="shrink-0 text-[10px]"
                        />
                      )}
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
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}
