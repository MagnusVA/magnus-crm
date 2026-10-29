"use client";

import Link from "next/link";
import { CopyIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { BusinessDaySetting } from "@/lib/businessDay";
import { meetingAttendanceDisplay, meetingStatusConfig } from "@/lib/status-config";
import { cn } from "@/lib/utils";
import { formatDateTime } from "@/app/workspace/closer/_components/today-time";
import { DetailCard } from "@/app/workspace/closer/meetings/_components/detail-card";
import type { TaskDetail } from "./task-detail-types";

/**
 * The deal's calls, newest first: when, the attendance word, how long, and
 * one line on what happened (the no-show's note, else the newest comment),
 * each opening its meeting page. "Not recorded" is the display rule for a
 * scheduled call that has ended (`meetingAttendanceDisplay`).
 */
export function DealCallsCard({
  meetings,
  now,
  setting,
  meetingBasePath,
}: {
  meetings: TaskDetail["dealMeetings"];
  now: number;
  setting: BusinessDaySetting;
  /** `/workspace/closer/meetings` or the admin's `/workspace/pipeline/meetings`. */
  meetingBasePath: string;
}) {
  return (
    <DetailCard
      title="Calls on this deal"
      meta={meetings.length > 0 ? <span className="tabular-nums">{meetings.length}</span> : null}
    >
      {meetings.length === 0 ? (
        <p className="px-4 py-3 text-[0.8125rem] text-muted-foreground">
          No calls on this deal yet.
        </p>
      ) : (
        <ul>
          {meetings.map((meeting) => {
            const attendance = meetingAttendanceDisplay(meeting, now);
            const missed = attendance === "no_show" || attendance === "canceled";
            return (
              <li
                key={meeting._id}
                className="relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-0.5 border-t px-4 py-2.5 first:border-t-0 hover:bg-accent/60"
              >
                <Link
                  href={`${meetingBasePath}/${meeting._id}`}
                  className="truncate font-semibold tabular-nums outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
                >
                  {formatDateTime(meeting.scheduledAt, setting.timeZone)}
                </Link>
                <span
                  className={cn(
                    "justify-self-end font-condensed text-sm font-semibold tracking-[0.06em] whitespace-nowrap uppercase",
                    missed ? "text-danger-ink" : "text-muted-foreground",
                  )}
                >
                  {meetingStatusConfig[attendance].label}
                </span>
                <span className="col-span-2 truncate text-[0.8125rem] text-muted-foreground tabular-nums">
                  {meeting.durationMinutes} min
                  {meeting.detail ? <> · {meeting.detail}</> : null}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </DetailCard>
  );
}

/**
 * The event type's payment links, each a click from the clipboard, in the
 * cards' ruled idiom.
 */
export function PaymentLinksCard({
  paymentLinks,
}: {
  paymentLinks: Array<{ provider: string; label: string; url: string }>;
}) {
  const copy = async (url: string, label: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success(`${label} link copied`);
    } catch {
      toast.error("Couldn't copy the link. Select it and copy it instead.");
    }
  };

  return (
    <DetailCard
      title="Payment links"
      meta={<span className="tabular-nums">{paymentLinks.length}</span>}
    >
      <ul>
        {paymentLinks.map((link, index) => (
          <li
            key={`${link.url}-${index}`}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2.5 border-t px-4 py-2.5 first:border-t-0"
          >
            <div className="min-w-0">
              <p className="truncate font-semibold">{link.label}</p>
              <p className="truncate text-[0.8125rem] text-muted-foreground" translate="no">
                {link.url}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label={`Copy the ${link.label} link`}
              title={`Copy the ${link.label} link`}
              onClick={() => copy(link.url, link.label)}
            >
              <CopyIcon aria-hidden />
            </Button>
          </li>
        ))}
      </ul>
      <p className="border-t px-4 py-2 text-[0.8125rem] text-muted-foreground">
        Send a link to pay, then record the win with Won · log payment.
      </p>
    </DetailCard>
  );
}
