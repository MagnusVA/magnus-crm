"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Field, FieldLabel } from "@/components/ui/field";
import { AlertTriangleIcon, XCircleIcon } from "lucide-react";
import { toast } from "sonner";

type MarkLostDialogProps = {
  opportunityId: Id<"opportunities">;
  onSuccess?: () => Promise<void>;
};

/**
 * Mark Lost Dialog — confirmation dialog for marking an opportunity as lost.
 *
 * - Modal confirmation to prevent accidental destructive action
 * - Optional reason textarea to capture CRM context
 * - Uses `Button` (not `AlertDialogAction`) to prevent auto-close before
 *   the async mutation completes — the dialog closes only on success
 * - Loading state + error toast during mutation
 */
export function MarkLostDialog({
  opportunityId,
  onSuccess,
}: MarkLostDialogProps) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const markAsLost = useMutation(api.closer.meetingActions.markAsLost);

  const handleMarkAsLost = async () => {
    setIsLoading(true);
    try {
      await markAsLost({
        opportunityId,
        reason: reason.trim() || undefined,
      });
      await onSuccess?.();
      toast.success("Opportunity marked as lost");
      setOpen(false);
      setReason("");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to mark as lost",
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <>
      <Button variant="destructive" size="lg" onClick={() => setOpen(true)}>
        <XCircleIcon data-icon="inline-start" />
        Mark as Lost
      </Button>

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <div className="flex items-start gap-3">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-destructive/10">
                <AlertTriangleIcon className="size-4 text-destructive" />
              </div>
              <div className="flex-1">
                <AlertDialogTitle>Mark as Lost?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will mark the opportunity as lost. This action is
                  permanent and cannot be undone.
                </AlertDialogDescription>
              </div>
            </div>
          </AlertDialogHeader>

          <Field>
            <FieldLabel htmlFor="lost-reason">Reason (optional)</FieldLabel>
            <Textarea
              id="lost-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why did this deal fall through? (e.g., budget constraints, chose competitor…)"
              className="min-h-[100px] resize-none text-sm"
              disabled={isLoading}
            />
          </Field>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={isLoading}>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={handleMarkAsLost}
              disabled={isLoading}
            >
              {isLoading ? (
                <>
                  <Spinner data-icon="inline-start" />
                  Marking…
                </>
              ) : (
                "Mark as Lost"
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
