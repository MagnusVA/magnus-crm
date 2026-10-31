"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { AlertTriangleIcon, CalendarXIcon } from "lucide-react";
import posthog from "posthog-js";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { getErrorMessage } from "@/lib/errors";
import { reportClientError } from "@/lib/observability/report-client-error";

/**
 * An admin cancels a deal's open task (a call-back, text-back or scheduling
 * link) from the deal modal. The task expires and the deal stays open with
 * no next step, so someone sets the next one (`admin.dealActions.adminCancelTask`).
 */
export function CancelTaskDialog({
  followUpId,
  leadName,
}: {
  followUpId: Id<"followUps">;
  leadName?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const cancelTask = useMutation(api.admin.dealActions.adminCancelTask);

  const onConfirm = async () => {
    setIsSubmitting(true);
    try {
      await cancelTask({ followUpId });
      posthog.capture("admin_task_canceled", { follow_up_id: followUpId });
      toast.success("Task canceled");
      setOpen(false);
    } catch (error) {
      reportClientError(error, { flow: "admin_task_cancel" });
      toast.error(getErrorMessage(error, "Couldn't cancel the task"));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(value) => {
        if (!isSubmitting) setOpen(value);
      }}
    >
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm">
          <CalendarXIcon aria-hidden="true" data-icon="inline-start" />
          Cancel task
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <div className="flex items-start gap-3">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-destructive/10">
              <AlertTriangleIcon className="size-4 text-danger-ink" aria-hidden />
            </div>
            <div className="flex-1">
              <AlertDialogTitle>
                {leadName ? `Cancel the open task on ${leadName}’s deal?` : "Cancel the deal’s open task?"}
              </AlertDialogTitle>
              <AlertDialogDescription>
                The task closes and the deal stays open with no next step, so
                someone can set the next one. A canceled link no longer moves
                the deal when it is booked.
              </AlertDialogDescription>
            </div>
          </div>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isSubmitting}>Keep task</AlertDialogCancel>
          <Button
            type="button"
            variant="destructive"
            className="text-danger-ink"
            disabled={isSubmitting}
            onClick={onConfirm}
          >
            {isSubmitting ? (
              <>
                <Spinner data-icon="inline-start" />
                Canceling…
              </>
            ) : (
              "Cancel task"
            )}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
