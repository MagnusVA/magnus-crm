"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { MarkLostDialog } from "./mark-lost-dialog";
import {
  PlayIcon,
  BanknoteIcon,
  CalendarPlusIcon,
  InfoIcon,
} from "lucide-react";
import { toast } from "sonner";
import type { Doc } from "@/convex/_generated/dataModel";

type OutcomeActionBarProps = {
  meeting: Doc<"meetings">;
  opportunity: Doc<"opportunities">;
  payments: Doc<"paymentRecords">[];
};

/**
 * Outcome Action Bar — contextual action buttons on the meeting detail page.
 *
 * Renders buttons based on meeting/opportunity status:
 * - "Start Meeting" — when scheduled (opens Zoom, transitions to in_progress)
 * - "Log Payment" — when in_progress (Phase 7 placeholder)
 * - "Schedule Follow-up" — when in_progress (Phase 7 placeholder)
 * - "Mark as Lost" — when in_progress (opens confirmation dialog)
 *
 * Returns null for terminal statuses where no actions are available.
 */
export function OutcomeActionBar({
  meeting,
  opportunity,
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
      toast.success("Meeting started");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to start meeting",
      );
    } finally {
      setIsStarting(false);
    }
  };

  // No actions for terminal statuses
  if (!isScheduled && !isInProgress) return null;

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

        {/* Log Payment — Phase 7 placeholder */}
        {isInProgress && (
          <Button
            variant="outline"
            size="lg"
            disabled
            title="Coming in Phase 7"
          >
            <BanknoteIcon data-icon="inline-start" />
            Log Payment
          </Button>
        )}

        {/* Schedule Follow-up — Phase 7 placeholder */}
        {isInProgress && (
          <Button
            variant="outline"
            size="lg"
            disabled
            title="Coming in Phase 7"
          >
            <CalendarPlusIcon data-icon="inline-start" />
            Schedule Follow-up
          </Button>
        )}

        {/* Mark as Lost — when in_progress */}
        {isInProgress && <MarkLostDialog opportunityId={opportunity._id} />}
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
