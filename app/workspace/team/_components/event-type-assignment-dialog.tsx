"use client";

import { useState, useEffect, useId } from "react";
import { useMutation } from "convex/react";
import { Controller, useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import type { MemberAvatarIdentity } from "@/app/workspace/_components/member-avatar";
import { getErrorMessage } from "@/lib/errors";
import { reportClientError } from "@/lib/observability/report-client-error";
import {
  ACTION_DIALOG,
  ACTION_FORM,
  ActionDialogFooter,
  ActionDialogHeader,
  CancelButton,
  FormRow,
  FormRows,
  SubmitButton,
  SubmitError,
} from "@/app/workspace/_components/action-dialog";
import { firstName } from "./team-ui";

const eventTypeSchema = z.object({
  personalEventTypeUri: z
    .string()
    .min(1, "Event type URL is required")
    .url("Must be a valid URL")
    .refine(
      (url) => url.includes("calendly.com/"),
      "Must be a Calendly booking page URL (e.g., https://calendly.com/your-name/30min)"
    ),
});
type EventTypeFormValues = z.infer<typeof eventTypeSchema>;

type EventTypeAssignmentDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: Id<"users">;
  userName: string;
  /** Kept for callers; the title names the person. */
  userIdentity?: MemberAvatarIdentity;
  currentUri?: string;
};

export function EventTypeAssignmentDialog({
  open,
  onOpenChange,
  userId,
  userName,
  currentUri,
}: EventTypeAssignmentDialogProps) {
  const ids = useId();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const assignEventType = useMutation(
    api.users.assignPersonalEventType.assignPersonalEventType
  );

  const form = useForm({
    resolver: standardSchemaResolver(eventTypeSchema),
    defaultValues: {
      personalEventTypeUri: currentUri ?? "",
    },
  });

  // Clear any previous error each time the dialog opens.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setSubmitError(null);
  }

  // Reset form when dialog opens with new data (externally controlled pattern)
  useEffect(() => {
    if (open) {
      form.reset({ personalEventTypeUri: currentUri ?? "" });
    }
  }, [open, currentUri, form]);

  const onSubmit = async (values: EventTypeFormValues) => {
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const { previousPersonalEventTypeUri } = await assignEventType({
        userId,
        personalEventTypeUri: values.personalEventTypeUri,
      });
      toast.success(`Event type assigned to ${userName}`, {
        action: {
          label: "Undo",
          // Puts back the event type they had before, or clears it if they had none.
          onClick: () => {
            assignEventType({ userId, personalEventTypeUri: previousPersonalEventTypeUri }).then(
              () => toast.success(previousPersonalEventTypeUri ? `${userName}'s event type is back` : `${userName} has no event type again`),
              (error: unknown) => {
                reportClientError(error, { flow: "team_event_type_undo" });
                toast.error(getErrorMessage(error, "Couldn’t undo the event type change."));
              },
            );
          },
        },
      });
      onOpenChange(false);
    } catch (err) {
      setSubmitError(
        getErrorMessage(err, "Failed to assign event type.")
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!isSubmitting) onOpenChange(next);
      }}
    >
      <DialogContent className={ACTION_DIALOG} showCloseButton={!isSubmitting}>
        <ActionDialogHeader
          title={`${currentUri ? "Change" : "Set"} ${userName}'s personal event type`}
          description={`Follow-up scheduling links for ${firstName(userName)} book on this Calendly page.`}
        />

        <form onSubmit={form.handleSubmit(onSubmit)} className={ACTION_FORM}>
          <SubmitError>{submitError}</SubmitError>
          <FormRows>
            <Controller
              control={form.control}
              name="personalEventTypeUri"
              render={({ field, fieldState }) => (
                <FormRow label="Booking page" htmlFor={`${ids}-uri`} invalid={fieldState.invalid} error={fieldState.error}>
                  <Input
                    {...field}
                    id={`${ids}-uri`}
                    inputMode="url"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="https://calendly.com/name/30min"
                    className="text-[13px]"
                    aria-invalid={fieldState.invalid}
                    disabled={isSubmitting}
                  />
                </FormRow>
              )}
            />
          </FormRows>

          <ActionDialogFooter>
            <CancelButton onClick={() => onOpenChange(false)} disabled={isSubmitting} />
            <SubmitButton pending={isSubmitting} pendingLabel="Saving…">
              {currentUri ? "Change event type" : "Set event type"}
            </SubmitButton>
          </ActionDialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
