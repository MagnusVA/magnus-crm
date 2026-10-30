"use client";

import { useNow } from "@/hooks/use-now";
import { meetingAttendanceDisplay, meetingStatusConfig, type MeetingStatus } from "@/lib/status-config";

import { useRouter } from "next/navigation";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { RefreshCwIcon, ArrowRightIcon } from "lucide-react";
import { format } from "date-fns";

type RescheduleChainBannerProps = {
  rescheduledFromMeeting: {
    _id: string;
    scheduledAt: number;
    status: MeetingStatus;
    durationMinutes: number;
  };
  /** Where meeting pages live for this viewer, closer or admin. */
  meetingDetailBasePath?: string;
};

export function RescheduleChainBanner({
  rescheduledFromMeeting,
  meetingDetailBasePath = "/workspace/closer/meetings",
}: RescheduleChainBannerProps) {
  const router = useRouter();
  const status = meetingStatusConfig[
    meetingAttendanceDisplay(rescheduledFromMeeting, useNow())
  ];

  return (
    <Alert className="mb-0">
      <RefreshCwIcon className="size-4" />
      <AlertDescription className="flex flex-wrap items-center justify-between gap-x-3">
        <span>
          This is a reschedule of the{" "}
          {format(
            new Date(rescheduledFromMeeting.scheduledAt),
            "MMM d, h:mm a",
          )}{" "}
          call ({status.label})
        </span>
        <Button
          variant="link"
          size="sm"
          className="gap-1 px-0"
          onClick={() =>
            router.push(
              `${meetingDetailBasePath}/${rescheduledFromMeeting._id}`,
            )
          }
        >
          View original
          <ArrowRightIcon className="size-3" />
        </Button>
      </AlertDescription>
    </Alert>
  );
}
