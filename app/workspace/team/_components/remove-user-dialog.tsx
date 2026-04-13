"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { AlertCircleIcon } from "lucide-react";
import { toast } from "sonner";
import posthog from "posthog-js";

interface RemoveUserDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: Id<"users">;
  userName: string;
  hasActiveAssignments?: boolean;
  onSuccess?: () => void;
}

export function RemoveUserDialog({
  open,
  onOpenChange,
  userId,
  userName,
  hasActiveAssignments = false,
  onSuccess,
}: RemoveUserDialogProps) {
  const router = useRouter();
  const [isRemoving, setIsRemoving] = useState(false);
  const removeUser = useAction(api.workos.userManagement.removeUser);

  const handleRemove = async () => {
    setIsRemoving(true);
    try {
      await removeUser({ userId });
      posthog.capture("team_member_deactivated", {
        deactivated_user_id: userId,
      });
      toast.success(`${userName} has been deactivated`);
      onOpenChange(false);
      onSuccess?.();
      // Re-run server components so the team list and nav reflect the deactivation
      router.refresh();
    } catch (error) {
      posthog.captureException(error);
      toast.error(
        error instanceof Error ? error.message : "Failed to deactivate user",
      );
    } finally {
      setIsRemoving(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Deactivate team member?</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to deactivate <strong>{userName}</strong>?
            They will lose access to the workspace. Their historical data
            (meetings, payments, opportunities) will be preserved.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {hasActiveAssignments && (
          <Alert variant="destructive">
            <AlertCircleIcon />
            <AlertDescription>
              This user has active opportunity assignments. Reassign them
              before deactivating.
            </AlertDescription>
          </Alert>
        )}

        <div className="flex justify-end gap-2">
          <AlertDialogCancel disabled={isRemoving}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleRemove}
            disabled={isRemoving || hasActiveAssignments}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {isRemoving && <Spinner data-icon="inline-start" />}
            {isRemoving ? "Deactivating..." : "Deactivate"}
          </AlertDialogAction>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
