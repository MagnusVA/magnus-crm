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
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";

interface RemoveUserDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: Id<"users">;
  userName: string;
  onSuccess?: () => void;
}

export function RemoveUserDialog({
  open,
  onOpenChange,
  userId,
  userName,
  onSuccess,
}: RemoveUserDialogProps) {
  const router = useRouter();
  const [isRemoving, setIsRemoving] = useState(false);
  const removeUser = useAction(api.workos.userManagement.removeUser);

  const handleRemove = async () => {
    setIsRemoving(true);
    try {
      await removeUser({ userId });
      toast.success(`${userName} has been removed from the team`);
      onOpenChange(false);
      onSuccess?.();
      // Re-run server components so the team list and nav reflect the removal
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to remove user",
      );
    } finally {
      setIsRemoving(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove team member?</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to remove <strong>{userName}</strong> from the
            team? This action cannot be undone. Their WorkOS account and
            Calendly link will also be removed.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex justify-end gap-2">
          <AlertDialogCancel disabled={isRemoving}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleRemove}
            disabled={isRemoving}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {isRemoving && <Spinner data-icon="inline-start" />}
            {isRemoving ? "Removing..." : "Remove"}
          </AlertDialogAction>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
