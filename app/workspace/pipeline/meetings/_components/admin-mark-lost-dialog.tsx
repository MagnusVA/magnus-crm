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

type AdminMarkLostDialogProps = {
  opportunityId: Id<"opportunities">;
  meetingId?: Id<"meetings">;
  onSuccess?: () => Promise<void>;
  /** Controlled open state. When set, the dialog renders no trigger button. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Named in the dialog so the admin knows whose deal closes. */
  leadName?: string | null;
};

/**
 * An admin closes a deal as lost on behalf of its closer
 * (`admin.meetingActions.adminMarkAsLost`). From a meeting, the server closes
 * the deal first, then marks the call held.
 */
export function AdminMarkLostDialog({
  opportunityId,
  meetingId,
  onSuccess,
  open: controlledOpen,
  onOpenChange,
  leadName,
}: AdminMarkLostDialogProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = controlledOpen ?? internalOpen;
  const setOpen = (value: boolean) => {
    if (!isControlled) setInternalOpen(value);
    onOpenChange?.(value);
  };
  const [isLoading, setIsLoading] = useState(false);
  const markAsLost = useMutation(api.admin.meetingActions.adminMarkAsLost);

  const onConfirm = async (trimmedReason: string | undefined) => {
    setIsLoading(true);
    try {
      await markAsLost({
        opportunityId,
        meetingId,
        reason: trimmedReason,
      });
      await onSuccess?.();
      posthog.capture("admin_opportunity_marked_lost", {
        opportunity_id: opportunityId,
        meeting_id: meetingId ?? null,
        has_reason: Boolean(trimmedReason),
      });
      toast.success("Deal closed as lost");
      setOpen(false);
    } catch (error) {
      reportClientError(error, { flow: "admin_mark_lost" });
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
        meetingId
          ? "This can’t be undone here."
          : "The deal closes as lost for the assigned closer. This can’t be undone here."
      }
      steps={
        meetingId
          ? ["Closes the deal as lost for the assigned closer, with your reason.", "Marks the call held."]
          : undefined
      }
      placeholder="Why did this deal fall through?"
      trigger={
        isControlled ? undefined : (
          <Button variant="destructive" size="sm" className="text-danger-ink">
            <XCircleIcon data-icon="inline-start" />
            Mark as Lost
          </Button>
        )
      }
      onConfirm={onConfirm}
    />
  );
}
