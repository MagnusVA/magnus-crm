"use client";

import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FieldGroup, Field, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";

interface CalendlyLinkDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: Id<"users">;
  userName: string;
  onSuccess?: () => void;
}

export function CalendlyLinkDialog({
  open,
  onOpenChange,
  userId,
  userName,
  onSuccess,
}: CalendlyLinkDialogProps) {
  const [calendlyMemberId, setCalendlyMemberId] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const unmatchedMembers = useQuery(
    api.users.queries.listUnmatchedCalendlyMembers,
  );

  const linkCloserToCalendly = useMutation(
    api.users.linkCalendlyMember.linkCloserToCalendlyMember,
  );

  const handleLink = async () => {
    if (!calendlyMemberId) {
      toast.error("Please select a Calendly member");
      return;
    }

    setIsSubmitting(true);
    try {
      await linkCloserToCalendly({
        userId,
        calendlyMemberId: calendlyMemberId as Id<"calendlyOrgMembers">,
      });

      toast.success(`${userName} linked to Calendly`);
      onOpenChange(false);
      setCalendlyMemberId("");
      onSuccess?.();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to link Calendly",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Link Calendly Member</DialogTitle>
          <DialogDescription>
            Select a Calendly member to link with {userName}
          </DialogDescription>
        </DialogHeader>

        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="link-calendlyMember">
              Calendly Member
            </FieldLabel>
            <Select
              value={calendlyMemberId}
              onValueChange={setCalendlyMemberId}
            >
              <SelectTrigger
                id="link-calendlyMember"
                disabled={isSubmitting || !unmatchedMembers}
              >
                <SelectValue placeholder="Select a Calendly member" />
              </SelectTrigger>
              <SelectContent>
                {unmatchedMembers?.map((member) => (
                  <SelectItem key={member._id} value={member._id}>
                    {member.name ?? member.email} ({member.email})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </FieldGroup>

        <div className="flex justify-end gap-2 pt-4">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button
            onClick={handleLink}
            disabled={isSubmitting || !calendlyMemberId}
          >
            {isSubmitting && <Spinner data-icon="inline-start" />}
            {isSubmitting ? "Linking..." : "Link"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
