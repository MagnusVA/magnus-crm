"use client";

import { useNow } from "@/hooks/use-now";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  VideoIcon,
  CalendarDaysIcon,
  ClockIcon,
  LinkIcon,
  CopyIcon,
  TagIcon,
  UserIcon,
} from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  meetingStatusConfig,
  meetingAttendanceDisplay,
} from "@/lib/status-config";
import type { Doc } from "@/convex/_generated/dataModel";
import { MemberIdentity } from "@/app/workspace/_components/member-identity";
import type { MemberAvatarIdentity } from "@/app/workspace/_components/member-avatar";

type MeetingInfoPanelProps = {
  meeting: Doc<"meetings">;
  eventTypeName: string | null;
  assignedCloser: { fullName?: string; email: string } | null;
  assignedCloserIdentity?: MemberAvatarIdentity | null;
};

/**
 * Meeting Info Panel — right column on the meeting detail page.
 *
 * Displays meeting date/time, duration, event type, assigned closer (useful
 * for admin view), meeting status badge, and a prominent meeting join link with
 * copy‑to‑clipboard via sonner toast.
 */
export function MeetingInfoPanel({
  meeting,
  eventTypeName,
  assignedCloser,
  assignedCloserIdentity,
}: MeetingInfoPanelProps) {
  const statusKey = meetingAttendanceDisplay(meeting, useNow());
  const statusCfg = meetingStatusConfig[statusKey];

  const meetingJoinUrl = meeting.meetingJoinUrl ?? meeting.zoomJoinUrl;

  const handleCopyMeetingLink = () => {
    if (meetingJoinUrl) {
      navigator.clipboard.writeText(meetingJoinUrl);
      toast.success("Meeting link copied to clipboard");
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-base">Meeting Details</CardTitle>
          <div className="flex items-center gap-2">
            <Badge
              variant="secondary"
              className={cn(statusCfg.badgeClass)}
            >
              {statusCfg?.label ?? meeting.status}
            </Badge>
            {/* Inline join button for quick access */}
            {meetingJoinUrl && (
              <div className="flex gap-1.5">
                <Button asChild size="sm">
                  <a href={meetingJoinUrl} target="_blank" rel="noopener noreferrer">
                    <VideoIcon data-icon="inline-start" />
                    Join
                  </a>
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="size-8"
                  onClick={handleCopyMeetingLink}
                  aria-label="Copy meeting link"
                >
                  <CopyIcon className="size-3.5" />
                </Button>
              </div>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="pt-0">
        {/* Compact grid of details */}
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2.5 sm:grid-cols-3">
          <CompactField icon={<CalendarDaysIcon />} label="Date & Time">
            <p className="text-sm font-medium leading-snug">
              {format(meeting.scheduledAt, "MMM d, yyyy")}
            </p>
            <p className="text-xs text-muted-foreground">
              {format(meeting.scheduledAt, "h:mm a")}
            </p>
          </CompactField>

          <CompactField icon={<ClockIcon />} label="Duration">
            <p className="text-sm font-medium">{meeting.durationMinutes} min</p>
          </CompactField>

          {eventTypeName && (
            <CompactField icon={<TagIcon />} label="Event Type">
              <p className="truncate text-sm font-medium" title={eventTypeName}>
                {eventTypeName}
              </p>
            </CompactField>
          )}

          {assignedCloser && (
            <CompactField icon={<UserIcon />} label="Assigned Closer">
              {assignedCloserIdentity ? (
                <MemberIdentity identity={assignedCloserIdentity} />
              ) : (
                <p className="truncate text-sm font-medium">
                  {assignedCloser.fullName ?? assignedCloser.email}
                </p>
              )}
            </CompactField>
          )}
        </dl>

        {!meetingJoinUrl && (
          <div className="mt-3 flex items-center gap-2 rounded-lg bg-amber-500/10 p-2.5">
            <LinkIcon className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <p className="text-sm text-amber-700 dark:text-amber-400">
              No meeting link available
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Internal ────────────────────────────────────────────────────────────────

function CompactField({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        <span className="[&>svg]:size-3">{icon}</span>
        {label}
      </dt>
      <dd>{children}</dd>
    </div>
  );
}
