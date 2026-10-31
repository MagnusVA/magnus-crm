"use client";

import { XIcon } from "lucide-react";
import { StageChip } from "@/app/workspace/closer/meetings/_components/stage-tone";
import { formatDealDate } from "@/app/workspace/opportunities/[opportunityId]/_components/deal-format";
import { Button } from "@/components/ui/button";
import { DialogClose, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { DealPosition, SystemLossReason } from "@/convex/opportunities/stages";
import type { BusinessDaySetting } from "@/lib/businessDay";
import { cn } from "@/lib/utils";

const SOURCE_WORDS = {
  calendly: "Booked through Calendly",
  slack_qualified: "Qualified through Slack",
  side_deal: "Logged as a side deal",
} as const;

/**
 * The modal's fixed header: the program as the title with the stage chip
 * beside it, and one 13px line with the day the deal was created and where
 * it came from (the credit line under it names the closer). The close button sits in the same row.
 */
export function DealModalHeader({
  title,
  position,
  systemLoss,
  closerName,
  createdAt,
  source,
  setting,
  now,
}: {
  title: string;
  position: DealPosition;
  systemLoss: SystemLossReason | null;
  closerName: string | null;
  createdAt: number;
  source: keyof typeof SOURCE_WORDS;
  setting: BusinessDaySetting;
  now: number;
}) {
  return (
    <DealModalHeaderFrame>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <DialogTitle className="text-lg leading-tight font-semibold" translate="no">
          {title}
        </DialogTitle>
        <StageChip position={position} systemLoss={systemLoss} />
      </div>
      <DialogDescription className="mt-1 text-[0.8125rem] leading-snug text-muted-foreground">
        {/* The credit line under the header names the closer. */}
        {closerName ? null : "No closer assigned · "}
        Created{" "}
        <span className="font-condensed text-sm tabular-nums">
          {formatDealDate(createdAt, setting, now)}
        </span>
        {" · "}
        {SOURCE_WORDS[source]}
      </DialogDescription>
    </DealModalHeaderFrame>
  );
}

/** The header's frame and close button, shared with the loading and unavailable states. */
export function DealModalHeaderFrame({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("flex shrink-0 items-start gap-3 border-b py-3 pr-3 pl-4 sm:pl-5", className)}>
      <div className="min-w-0 flex-1 pt-0.5">{children}</div>
      <DialogClose asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Close the deal">
          <XIcon aria-hidden="true" />
        </Button>
      </DialogClose>
    </div>
  );
}
