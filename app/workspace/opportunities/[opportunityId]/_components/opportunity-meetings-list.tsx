"use client";

import Link from "next/link";
import type { Id } from "@/convex/_generated/dataModel";
import {
  meetingAttendanceDisplay,
  meetingStatusConfig,
  type MeetingAttendanceStatus,
  type MeetingStatus,
} from "@/lib/status-config";
import { cn } from "@/lib/utils";
import { formatDealDateTime } from "./deal-format";

export type DealMeeting = {
  _id: Id<"meetings">;
  status: MeetingStatus;
  scheduledAt: number;
  durationMinutes: number;
  callClassification?: "new" | "follow_up";
};

/** The attendance word's ink, as the board and the strip colour it. */
const ATTENDANCE_INK: Record<MeetingAttendanceStatus, string> = {
  scheduled: "text-foreground",
  held: "text-stage-held-ink",
  no_show: "text-danger-ink",
  canceled: "text-muted-foreground",
  not_recorded: "text-warning-ink",
};

/**
 * The deal's calls as ruled rows, newest first: when (condensed), the
 * attendance word in its ink, and how long. Each row opens its meeting
 * page. A scheduled call that has ended reads "Not recorded"
 * (`meetingAttendanceDisplay`).
 */
export function OpportunityMeetingsList({
  meetings,
  meetingBasePath,
  now,
  timeZone,
}: {
  meetings: DealMeeting[];
  /** `/workspace/closer/meetings` or the admin's `/workspace/pipeline/meetings`. */
  meetingBasePath: string;
  now: number;
  timeZone: string;
}) {
  return (
    <ul>
      {meetings.map((meeting) => {
        const attendance = meetingAttendanceDisplay(meeting, now);
        const label = meetingStatusConfig[attendance].label;
        return (
          <li
            key={meeting._id}
            className="relative grid min-h-11 grid-cols-[minmax(0,1fr)_auto_3.75rem] items-center gap-x-3 border-t px-4 py-2 first:border-t-0 hover:bg-muted/60 sm:px-5"
          >
            <Link
              href={`${meetingBasePath}/${meeting._id}`}
              className="truncate font-condensed text-[0.9375rem] font-semibold tracking-[0.02em] tabular-nums outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
            >
              {formatDealDateTime(meeting.scheduledAt, timeZone, now)}
              {meeting.callClassification === "follow_up" ? (
                <span className="ml-2 font-sans text-[0.8125rem] font-normal tracking-normal text-muted-foreground">
                  Follow-up call
                </span>
              ) : null}
              <span className="sr-only">, {label}. Open the meeting</span>
            </Link>
            <span
              aria-hidden="true"
              className={cn(
                "font-condensed text-[0.8125rem] leading-none font-bold tracking-[0.08em] whitespace-nowrap uppercase",
                ATTENDANCE_INK[attendance],
              )}
            >
              {label}
            </span>
            <span className="text-right font-condensed text-sm text-muted-foreground tabular-nums">
              {meeting.durationMinutes} min
            </span>
          </li>
        );
      })}
    </ul>
  );
}
