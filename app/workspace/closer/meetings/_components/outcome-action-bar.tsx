"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { PlayIcon, InfoIcon } from "lucide-react";
import { toast } from "sonner";
import type { Doc } from "@/convex/_generated/dataModel";

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
    } catch (error) {
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
        {/* Start Meeting — only when scheduled */}
        {isScheduled && (
          <Button
            onClick={handleStartMeeting}
            disabled={isStarting}
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
      {isScheduled && (
        <Alert>
          <InfoIcon />
          <AlertDescription>
            Click &ldquo;Start Meeting&rdquo; to open Zoom and mark the call as
            in progress.
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
