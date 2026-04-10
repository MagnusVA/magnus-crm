"use client";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
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
  type MeetingStatus,
} from "@/lib/status-config";
import type { Doc } from "@/convex/_generated/dataModel";

/**
 * Badge styling per meeting status — mirrors the centralised colour palette
 * used across the closer dashboard surfaces.
 */
const MEETING_BADGE_CLASS: Record<string, string> = {
  scheduled:
    "bg-blue-500/10 text-blue-700 border-blue-200 dark:text-blue-400 dark:border-blue-900",
  in_progress:
    "bg-amber-500/10 text-amber-700 border-amber-200 dark:text-amber-400 dark:border-amber-900",
  completed:
    "bg-emerald-500/10 text-emerald-700 border-emerald-200 dark:text-emerald-400 dark:border-emerald-900",
  canceled: "bg-muted text-muted-foreground border-border",
  no_show:
    "bg-orange-500/10 text-orange-700 border-orange-200 dark:text-orange-400 dark:border-orange-900",
};

type MeetingInfoPanelProps = {
  meeting: Doc<"meetings">;
  eventTypeName: string | null;
  assignedCloser: { fullName?: string; email: string } | null;
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
}: MeetingInfoPanelProps) {
  const statusKey = meeting.status as MeetingStatus;
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
      <CardHeader>
        <div className="flex items-start justify-between">
          <CardTitle className="text-base">Meeting Details</CardTitle>
          <Badge
            variant="secondary"
            className={cn(MEETING_BADGE_CLASS[meeting.status])}
          >
            {statusCfg?.label ?? meeting.status}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {/* Date & Time */}
        <InfoRow icon={<CalendarDaysIcon />} label="Date & Time">
          <p className="text-sm font-medium">
            {format(meeting.scheduledAt, "EEEE, MMMM d, yyyy")}
          </p>
          <p className="text-xs text-muted-foreground">
            {format(meeting.scheduledAt, "h:mm a")}
          </p>
        </InfoRow>

        {/* Duration */}
        <InfoRow icon={<ClockIcon />} label="Duration">
          <p className="text-sm font-medium">
            {meeting.durationMinutes} minutes
          </p>
        </InfoRow>

        {/* Event Type */}
        {eventTypeName && (
          <InfoRow icon={<TagIcon />} label="Event Type">
            <p className="text-sm font-medium">{eventTypeName}</p>
          </InfoRow>
        )}

        {/* Assigned Closer — visible context for all users */}
        {assignedCloser && (
          <InfoRow icon={<UserIcon />} label="Assigned Closer">
            <p className="text-sm font-medium">
              {assignedCloser.fullName ?? assignedCloser.email}
            </p>
            {assignedCloser.fullName && (
              <p className="text-xs text-muted-foreground">
                {assignedCloser.email}
              </p>
            )}
          </InfoRow>
        )}

        <Separator />

        {/* Meeting Link */}
        {meetingJoinUrl ? (
          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Meeting Link
            </p>
            <div className="flex gap-2">
              <Button asChild className="flex-1">
                <a
                  href={meetingJoinUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <VideoIcon data-icon="inline-start" />
                  Join Meeting
                </a>
              </Button>
              <Button
                variant="outline"
                size="icon"
                onClick={handleCopyMeetingLink}
                aria-label="Copy meeting link"
              >
                <CopyIcon />
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2 rounded-lg bg-amber-500/10 p-3">
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

function InfoRow({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 text-muted-foreground [&>svg]:size-4">{icon}</div>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
        {children}
      </div>
    </div>
  );
}
