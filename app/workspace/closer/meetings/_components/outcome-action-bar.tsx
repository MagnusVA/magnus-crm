"use client";

import { useState, useEffect, useCallback } from "react";
import dynamic from "next/dynamic";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { PlayIcon, InfoIcon, ClockIcon } from "lucide-react";
import { toast } from "sonner";
import type { Doc } from "@/convex/_generated/dataModel";
import posthog from "posthog-js";

// Lazy-load dialog components that are only shown on user interaction
const MarkLostDialog = dynamic(() =>
  import("./mark-lost-dialog").then((m) => ({ default: m.MarkLostDialog })),
);
const PaymentFormDialog = dynamic(() =>
  import("./payment-form-dialog").then((m) => ({ default: m.PaymentFormDialog })),
);
const FollowUpDialog = dynamic(() =>
  import("./follow-up-dialog").then((m) => ({ default: m.FollowUpDialog })),
);

type OutcomeActionBarProps = {
  meeting: Doc<"meetings">;
  opportunity: Doc<"opportunities">;
  payments: Doc<"paymentRecords">[];
  onStatusChanged?: () => Promise<void>;
};

const EARLY_JOIN_MINUTES = 5;
const TICK_INTERVAL_MS = 15_000; // re-check every 15 seconds

/**
 * Returns whether the current time falls within the meeting's start window:
 * from 5 minutes before `scheduledAt` until `scheduledAt + durationMinutes`.
 */
function useMeetingStartWindow(meeting: Doc<"meetings">) {
  const computeState = useCallback(() => {
    const now = Date.now();
    const windowOpen = meeting.scheduledAt - EARLY_JOIN_MINUTES * 60 * 1000;
    const windowClose =
      meeting.scheduledAt + meeting.durationMinutes * 60 * 1000;

    if (now < windowOpen) {
      return { canStart: false, reason: "too_early" as const, windowOpen };
    }
    if (now > windowClose) {
      return { canStart: false, reason: "too_late" as const, windowClose };
    }
    return { canStart: true, reason: null, windowOpen };
  }, [meeting.scheduledAt, meeting.durationMinutes]);

  const [state, setState] = useState(computeState);

  useEffect(() => {
    // Recalculate immediately in case deps changed
    setState(computeState());

    const interval = setInterval(() => setState(computeState()), TICK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [computeState]);

  return state;
}

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Outcome Action Bar — contextual action buttons on the meeting detail page.
 *
 * Renders buttons based on meeting/opportunity status:
 * - "Start Meeting" — when scheduled (opens Zoom, transitions to in_progress)
 * - "Log Payment" — when in_progress (opens payment form dialog)
 * - "Schedule Follow-up" — when in_progress, canceled, or no_show
 * - "Mark as Lost" — when in_progress (opens confirmation dialog)
 *
 * Returns null for terminal statuses where no actions are available
 * (payment_received, lost, follow_up_scheduled).
 */
export function OutcomeActionBar({
  meeting,
  opportunity,
  onStatusChanged,
}: OutcomeActionBarProps) {
  const startMeeting = useMutation(api.closer.meetingActions.startMeeting);
  const [isStarting, setIsStarting] = useState(false);
  const { canStart, reason, windowOpen } = useMeetingStartWindow(meeting);

  const isScheduled = meeting.status === "scheduled";
  const isInProgress = opportunity.status === "in_progress";

  const handleStartMeeting = async () => {
    setIsStarting(true);
    try {
      const result = await startMeeting({ meetingId: meeting._id });
      if (result.zoomJoinUrl) {
        window.open(result.zoomJoinUrl, "_blank", "noopener,noreferrer");
      }
      await onStatusChanged?.();
      toast.success("Meeting started");
      posthog.capture("meeting_started", {
        meeting_id: meeting._id,
        opportunity_id: opportunity._id,
        has_zoom_url: Boolean(result.zoomJoinUrl),
        scheduled_at: meeting.scheduledAt,
        duration_minutes: meeting.durationMinutes,
      });
    } catch (error) {
      posthog.captureException(error);
      toast.error(
        error instanceof Error ? error.message : "Failed to start meeting",
      );
    } finally {
      setIsStarting(false);
    }
  };

  const isCanceledOrNoShow =
    opportunity.status === "canceled" || opportunity.status === "no_show";

  // No actions for terminal statuses (payment_received, lost, follow_up_scheduled)
  if (!isScheduled && !isInProgress && !isCanceledOrNoShow) return null;

  return (
    <div className="flex flex-col gap-3 border-t pt-4">
      <div className="flex flex-wrap items-center gap-3">
        {/* Start Meeting — only when scheduled & within the start window */}
        {isScheduled && (
          <Button
            onClick={handleStartMeeting}
            disabled={isStarting || !canStart}
            size="lg"
          >
            {isStarting ? (
              <>
                <Spinner data-icon="inline-start" />
                Starting…
              </>
            ) : (
              <>
                <PlayIcon data-icon="inline-start" />
                Start Meeting
              </>
            )}
          </Button>
        )}

        {/* Log Payment — Phase 7D */}
        {isInProgress && (
          <PaymentFormDialog
            opportunityId={opportunity._id}
            meetingId={meeting._id}
            onSuccess={onStatusChanged}
          />
        )}

        {/* Schedule Follow-up — Phase 7E */}
        {isInProgress && (
          <FollowUpDialog
            opportunityId={opportunity._id}
            onSuccess={onStatusChanged}
          />
        )}

        {/* Schedule Follow-up for canceled/no-show opportunities */}
        {isCanceledOrNoShow && (
          <FollowUpDialog
            opportunityId={opportunity._id}
            onSuccess={onStatusChanged}
          />
        )}

        {/* Mark as Lost — when in_progress */}
        {isInProgress && (
          <MarkLostDialog
            opportunityId={opportunity._id}
            onSuccess={onStatusChanged}
          />
        )}
      </div>

      {/* Contextual help */}
      {isScheduled && canStart && (
        <Alert>
          <InfoIcon />
          <AlertDescription>
            Click &ldquo;Start Meeting&rdquo; to open Zoom and mark the call as
            in progress.
          </AlertDescription>
        </Alert>
      )}

      {isScheduled && reason === "too_early" && (
        <Alert>
          <ClockIcon />
          <AlertDescription>
            This meeting can be started at {formatTime(windowOpen!)}, 5 minutes
            before the scheduled time. The button will enable automatically.
          </AlertDescription>
        </Alert>
      )}

      {isScheduled && reason === "too_late" && (
        <Alert variant="destructive">
          <ClockIcon />
          <AlertDescription>
            The scheduled time for this meeting has passed. The meeting can no
            longer be started.
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
