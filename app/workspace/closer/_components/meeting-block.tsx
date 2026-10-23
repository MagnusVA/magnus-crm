"use client";

import { useNow } from "@/hooks/use-now";

import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { format } from "date-fns";
import {
  ArrowRightIcon,
  BriefcaseIcon,
  CalendarDaysIcon,
  ClockIcon,
  type LucideIcon,
  VideoIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  meetingStatusConfig,
  meetingAttendanceDisplay,
  type MeetingStatus,
} from "@/lib/status-config";
import { dealPositionLabel } from "@/convex/opportunities/stageLabels";
import type { DealPosition, SystemLossReason } from "@/convex/opportunities/stages";

type MeetingDisplayProps = {
  meetingId: string;
  scheduledAt: number;
  durationMinutes: number;
  status: MeetingStatus;
  leadName: string;
  eventTypeName?: string | null;
  /** Where the meeting's deal is now; null when the deal is gone. */
  dealPosition: DealPosition | null;
  /** The loss the system wrote on the deal, such as a no-show, if it did. */
  dealSystemLoss: SystemLossReason | null;
  meetingJoinUrl?: string;
  zoomJoinUrl?: string;
};

type MeetingBlockProps = MeetingDisplayProps & {
  className?: string;
  style?: CSSProperties;
};

export function MeetingBlock({
  className,
  style,
  ...meeting
}: MeetingBlockProps) {
  const config =
    meetingStatusConfig[meetingAttendanceDisplay(meeting, useNow())];
  const startTime = format(meeting.scheduledAt, "h:mm a");
  const endTime = getEndTime(meeting.scheduledAt, meeting.durationMinutes);
  const isShort = meeting.durationMinutes < 30;

  return (
    <MeetingDetailsDialog {...meeting}>
      <button
        type="button"
        className={cn(
          "absolute overflow-hidden rounded-md border-l-[3px] px-2 py-1 text-left text-xs transition-opacity hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
          config.blockClass,
          className,
        )}
        style={style}
        aria-label={`${meeting.leadName}, ${startTime} - ${endTime}, ${config.label}`}
      >
        {isShort ? (
          <span className={cn("block truncate font-medium", config.textClass)}>
            {meeting.leadName} · {startTime}
          </span>
        ) : (
          <>
            <span className={cn("block truncate font-medium", config.textClass)}>
              {meeting.leadName}
            </span>
            <span className="block truncate text-muted-foreground">
              {startTime} - {endTime}
              {meeting.eventTypeName ? ` · ${meeting.eventTypeName}` : ""}
            </span>
          </>
        )}
      </button>
    </MeetingDetailsDialog>
  );
}

export function MeetingPill({
  className,
  ...meeting
}: MeetingDisplayProps & { className?: string }) {
  const config =
    meetingStatusConfig[meetingAttendanceDisplay(meeting, useNow())];

  return (
    <MeetingDetailsDialog {...meeting}>
      <button
        type="button"
        className={cn(
          "w-full truncate rounded px-1 py-px text-left text-[10px] leading-tight transition-opacity hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          config.blockClass,
          config.textClass,
          className,
        )}
        aria-label={`${meeting.leadName} at ${format(
          meeting.scheduledAt,
          "h:mm a",
        )}`}
      >
        {format(meeting.scheduledAt, "h:mm")} {meeting.leadName}
      </button>
    </MeetingDetailsDialog>
  );
}

function MeetingDetailsDialog({
  children,
  meetingId,
  scheduledAt,
  durationMinutes,
  status,
  leadName,
  eventTypeName,
  dealPosition,
  dealSystemLoss,
  meetingJoinUrl,
  zoomJoinUrl,
}: MeetingDisplayProps & { children: ReactNode }) {
  const config = meetingStatusConfig[
    meetingAttendanceDisplay({ status, scheduledAt, durationMinutes }, useNow())
  ];
  const dotClass = config.dotClass;
  const startTime = format(scheduledAt, "EEEE, MMM d · h:mm a");
  const endTime = getEndTime(scheduledAt, durationMinutes);
  // A canceled meeting shows on the calendar, but there's nothing to join.
  const joinUrl =
    status === "canceled" ? undefined : (meetingJoinUrl ?? zoomJoinUrl);

  return (
    <Dialog>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="mb-1 flex items-center gap-2">
            <span
              className={cn("size-2 rounded-full", dotClass)}
              aria-hidden="true"
            />
            <Badge variant="outline">{config.label}</Badge>
          </div>
          <DialogTitle className="pr-8">{leadName}</DialogTitle>
          <DialogDescription>
            {eventTypeName ?? "Scheduled Calendly meeting"}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-2 rounded-lg border bg-muted/30 p-3">
          <DetailRow
            icon={CalendarDaysIcon}
            label="When"
            value={`${startTime} - ${endTime}`}
          />
          <DetailRow
            icon={ClockIcon}
            label="Duration"
            value={`${durationMinutes} min`}
          />
          {eventTypeName ? (
            <DetailRow
              icon={CalendarDaysIcon}
              label="Meeting Type"
              value={eventTypeName}
            />
          ) : null}
          {dealPosition ? (
            <DetailRow
              icon={BriefcaseIcon}
              label="Deal"
              value={dealPositionLabel(dealPosition, dealSystemLoss)}
            />
          ) : null}
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Close</Button>
          </DialogClose>
          <Button variant="outline" asChild>
            <Link href={`/workspace/closer/meetings/${meetingId}`}>
              View Details
              <ArrowRightIcon data-icon="inline-end" aria-hidden="true" />
            </Link>
          </Button>
          {joinUrl ? (
            <Button asChild>
              <a href={joinUrl} target="_blank" rel="noopener noreferrer">
                <VideoIcon data-icon="inline-start" aria-hidden="true" />
                Go to Meeting
              </a>
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DetailRow({
  icon: Icon,
  label,
  value,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
}) {
  return (
    <div className="flex min-w-0 items-start gap-2">
      <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0">
        <p className="text-[11px] font-medium text-muted-foreground">{label}</p>
        <p className="break-words text-sm">{value}</p>
      </div>
    </div>
  );
}

function getEndTime(scheduledAt: number, durationMinutes: number): string {
  return format(scheduledAt + durationMinutes * 60 * 1000, "h:mm a");
}
