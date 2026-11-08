"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { toast } from "sonner";
import posthog from "@/lib/posthog-browser";
import { reportClientError } from "@/lib/observability/report-client-error";
import { getErrorMessage } from "@/lib/errors";
import { LostDealDialog } from "@/app/workspace/_components/outcome-dialog-parts";

type Props = {
  followUpId: Id<"followUps">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
  /** Named in the title so the closer knows whose deal closes. */
  leadName: string | null;
};

/**
 * Lost, after the closer reached the person: `markReminderLost` closes the
 * deal as lost with the reason, then completes the task.
 */
export function ReminderMarkLostDialog({
  followUpId,
  open,
  onOpenChange,
  onSuccess,
  leadName,
}: Props) {
  const [isLoading, setIsLoading] = useState(false);
  const markReminderLost = useMutation(api.closer.reminderOutcomes.markReminderLost);

  const onConfirm = async (trimmedReason: string | undefined) => {
    setIsLoading(true);
    try {
      await markReminderLost({ followUpId, reason: trimmedReason });

      posthog.capture("reminder_outcome_lost", {
        follow_up_id: followUpId,
        has_reason: Boolean(trimmedReason),
      });
      toast.success("Deal closed as lost");
      onOpenChange(false);
      onSuccess();
    } catch (err) {
      reportClientError(err, { flow: "reminder_mark_lost" });
      toast.error(getErrorMessage(err, "Failed to mark as lost"));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <LostDealDialog
      open={open}
      onOpenChange={onOpenChange}
      pending={isLoading}
      leadName={leadName}
      consequence={"This can’t be undone here."}
      steps={["Closes the deal as lost, with your reason.", "Completes this task."]}
      placeholder="Why did this deal fall through? (e.g., budget constraints, chose competitor…)"
      onConfirm={onConfirm}
    />
  );
}
