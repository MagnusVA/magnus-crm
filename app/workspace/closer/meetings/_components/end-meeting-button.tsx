"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { Square } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

const FLASH_DURATION_MS = 2800; // 3 × 900ms keyframe iterations + small buffer

type EndMeetingButtonProps = {
  meetingId: Id<"meetings">;
  meetingStatus: Doc<"meetings">["status"];
  onStopped?: () => Promise<void> | void;
  /**
   * Increment to briefly pulse the button and scroll it into view —
   * used when the closer attempted to navigate away without ending the
   * meeting first and we want to point them at this button.
   */
  flashKey?: number;
};

export function EndMeetingButton({
  meetingId,
  meetingStatus,
  onStopped,
  flashKey,
}: EndMeetingButtonProps) {
  const stopMeeting = useMutation(api.closer.meetingActions.stopMeeting);
  const [isStopping, setIsStopping] = useState(false);
  const [isFlashing, setIsFlashing] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Flash effect — keyed off the parent's counter so each dismissal of
  // the warning dialog re-triggers the animation. `!flashKey` skips the
  // initial mount (undefined or 0) so the button is inert on first paint.
  useEffect(() => {
    if (!flashKey) return;
    buttonRef.current?.scrollIntoView({
      block: "nearest",
      behavior: "smooth",
    });
    setIsFlashing(true);
    const timer = window.setTimeout(() => {
      setIsFlashing(false);
    }, FLASH_DURATION_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [flashKey]);

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
      ref={buttonRef}
      variant="outline"
      size="sm"
      onClick={handleClick}
      disabled={isStopping}
      aria-label="End meeting"
      className={cn(
        "w-full",
        isFlashing && "animate-attention-pulse-ring",
      )}
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
