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
};

export function RescheduleChainBanner({
  rescheduledFromMeeting,
}: RescheduleChainBannerProps) {
  const router = useRouter();
  const status = meetingStatusConfig[
    meetingAttendanceDisplay(rescheduledFromMeeting, useNow())
  ];

  return (
    <Alert className="mb-0">
      <RefreshCwIcon className="size-4" />
      <AlertDescription className="flex items-center justify-between">
        <span>
          This is a reschedule of the{" "}
          {format(
            new Date(rescheduledFromMeeting.scheduledAt),
            "MMM d, h:mm a",
          )}{" "}
          meeting ({status.label})
        </span>
        <Button
          variant="link"
          size="sm"
          className="gap-1 px-0"
          onClick={() =>
            router.push(
              `/workspace/closer/meetings/${rescheduledFromMeeting._id}`,
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
