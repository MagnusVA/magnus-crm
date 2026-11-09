"use client";

import { useState } from "react";
import { toast } from "sonner";
import { getErrorMessage } from "@/lib/errors";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";

export default function AccessConfirmDialog({
  title,
  description,
  action,
  onConfirm,
  onClose,
}: {
  title: string;
  description: string;
  action: string;
  onConfirm: () => Promise<unknown>;
  onClose: () => void;
}) {
  const [pending, setPending] = useState(false);
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={pending}
            onClick={async (event) => {
              event.preventDefault();
              setPending(true);
              try {
                await onConfirm();
                onClose();
              } catch (error) {
                toast.error(
                  getErrorMessage(
                    error,
                    "Couldn't change AI assistant access.",
                  ),
                );
              } finally {
                setPending(false);
              }
            }}
          >
            {pending ? "Saving…" : action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
