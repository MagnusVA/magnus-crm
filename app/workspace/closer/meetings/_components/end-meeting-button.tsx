"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { Square } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

type EndMeetingButtonProps = {
  meetingId: Id<"meetings">;
  meetingStatus: Doc<"meetings">["status"];
  onStopped?: () => Promise<void> | void;
};

export function EndMeetingButton({
  meetingId,
  meetingStatus,
  onStopped,
}: EndMeetingButtonProps) {
  const stopMeeting = useMutation(api.closer.meetingActions.stopMeeting);
  const [isStopping, setIsStopping] = useState(false);

  if (meetingStatus !== "in_progress") {
    return null;
  }

  const handleClick = async () => {
    setIsStopping(true);
    try {
      const { exceededScheduledDuration, exceededScheduledDurationMs } =
        await stopMeeting({ meetingId });

      await onStopped?.();

      if (exceededScheduledDuration) {
        const minutesOver = Math.max(
          1,
          Math.round(exceededScheduledDurationMs / 60_000),
        );
        toast.success(`Meeting ended — ran ${minutesOver} min over schedule`);
      } else {
        toast.success("Meeting ended");
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not end meeting";
      toast.error(message);
      console.error("[EndMeetingButton] stopMeeting failed", error);
    } finally {
      setIsStopping(false);
    }
  };

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleClick}
      disabled={isStopping}
      aria-label="End meeting"
      className="w-full"
    >
      {isStopping ? (
        <>
          <Spinner data-icon="inline-start" />
          Ending...
        </>
      ) : (
        <>
          <Square data-icon="inline-start" />
          End Meeting
        </>
      )}
    </Button>
  );
}
