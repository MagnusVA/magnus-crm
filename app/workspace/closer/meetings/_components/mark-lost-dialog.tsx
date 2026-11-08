"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { XCircleIcon } from "lucide-react";
import { toast } from "sonner";
import posthog from "@/lib/posthog-browser";
import { reportClientError } from "@/lib/observability/report-client-error";
import { getErrorMessage } from "@/lib/errors";
import { LostDealDialog } from "@/app/workspace/_components/outcome-dialog-parts";

type MarkLostDialogProps = {
  opportunityId: Id<"opportunities">;
  meetingId?: Id<"meetings">;
  onSuccess?: () => Promise<void>;
  compact?: boolean;
  /** Controlled open state. When set, the dialog renders no trigger button. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Named in the dialog so the closer knows whose deal closes. */
  leadName?: string | null;
};

/**
 * The closer closes their deal as lost (`closer.meetingActions.markAsLost`).
 * From a meeting, the server closes the deal first, then marks the call held.
 */
export function MarkLostDialog({
  opportunityId,
  meetingId,
  onSuccess,
  compact,
  open: controlledOpen,
  onOpenChange,
  leadName,
}: MarkLostDialogProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = controlledOpen ?? internalOpen;
  const setOpen = (value: boolean) => {
    if (!isControlled) setInternalOpen(value);
    onOpenChange?.(value);
  };
  const [isLoading, setIsLoading] = useState(false);
  const markAsLost = useMutation(api.closer.meetingActions.markAsLost);

  const onConfirm = async (trimmedReason: string | undefined) => {
    setIsLoading(true);
    try {
      await markAsLost({
        opportunityId,
        meetingId,
        reason: trimmedReason,
      });
      await onSuccess?.();
      posthog.capture("opportunity_marked_lost", {
        opportunity_id: opportunityId,
        meeting_id: meetingId ?? null,
        has_reason: Boolean(trimmedReason),
      });
      toast.success("Deal closed as lost");
      setOpen(false);
    } catch (error) {
      reportClientError(error, { flow: "meeting_mark_lost" });
      toast.error(getErrorMessage(error, "Failed to mark as lost"));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <LostDealDialog
      open={open}
      onOpenChange={setOpen}
      pending={isLoading}
      leadName={leadName}
      consequence={
        meetingId ? "This can’t be undone here." : "The deal closes as lost, with your reason on it."
      }
      steps={meetingId ? ["Closes the deal as lost, with your reason.", "Marks the call held."] : undefined}
      placeholder="Why did this deal fall through? (e.g., budget constraints, chose competitor…)"
      trigger={
        isControlled ? undefined : (
          <Button variant="destructive" size={compact ? "sm" : "lg"} className="text-danger-ink">
            <XCircleIcon data-icon="inline-start" />
            Mark as Lost
          </Button>
        )
      }
      onConfirm={onConfirm}
    />
  );
}
