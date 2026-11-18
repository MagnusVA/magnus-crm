"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import posthog from "@/lib/posthog-browser";
import { getErrorMessage } from "@/lib/errors";

/**
 * Confirms undoing a no-show: the lead showed up after all. The call goes
 * back to awaiting its result and the deal reopens at Booked.
 */
export function UndoNoShowDialog({
  meetingId,
  firstName,
  open,
  onOpenChange,
  returnFocusRef,
}: {
  meetingId: Id<"meetings">;
  firstName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The button that opened the dialog: it mounts outside the dialog, so Radix can't find it. */
  returnFocusRef?: React.RefObject<HTMLButtonElement | null>;
}) {
  const undoNoShow = useMutation(api.closer.noShowActions.undoNoShow);
  const [isSaving, setIsSaving] = useState(false);

  const handleUndo = async (event: React.MouseEvent) => {
    // Keep the dialog open until the save settles.
    event.preventDefault();
    setIsSaving(true);
    try {
      await undoNoShow({ meetingId });
      posthog.capture("meeting_no_show_undone", { meeting_id: meetingId, via: "card" });
      toast.success("No-show undone. Record what happened on the call.");
      onOpenChange(false);
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to undo the no-show"));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        onCloseAutoFocus={(event) => {
          if (!returnFocusRef?.current) return;
          event.preventDefault();
          returnFocusRef.current.focus();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Did {firstName} show up after all?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the no-show and reopens the deal at Booked. Then
            record what happened on the call: a payment, a follow-up or a loss.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isSaving}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleUndo} disabled={isSaving}>
            {isSaving ? "Undoing…" : "Undo no-show"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
