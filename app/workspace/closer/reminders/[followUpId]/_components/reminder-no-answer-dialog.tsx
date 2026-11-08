"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  ACTION_DIALOG,
  ACTION_FORM,
  ActionDialogFooter,
  ActionDialogHeader,
  CancelButton,
  FormRows,
  SubmitButton,
  WhatHappens,
} from "@/app/workspace/_components/action-dialog";
import { NoteRow } from "@/app/workspace/_components/follow-up-dialog-parts";
import { toast } from "sonner";
import posthog from "@/lib/posthog-browser";
import { reportClientError } from "@/lib/observability/report-client-error";
import { getErrorMessage } from "@/lib/errors";

const noAnswerSchema = z.object({
  note: z.string().max(500, "Keep it under 500 characters").optional(),
});
type NoAnswerFormValues = z.infer<typeof noAnswerSchema>;

/** The two No-answer choices that need only a confirm: close the task, or the deal as lost. */
export type NoAnswerStep = "close_only" | "give_up";

type Props = {
  followUpId: Id<"followUps">;
  nextStep: NoAnswerStep;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
  firstName: string;
  /** Named in the lost title so the closer knows whose deal closes. */
  leadName: string | null;
  /** The deal's stage today, which "Close this task only" leaves alone. */
  dealStageLabel: string;
};

/**
 * No answer, then close the task only or mark the deal lost: one confirm
 * step each over `markReminderNoResponse`. Closing only leaves the deal
 * where it is; marking it lost writes the reason, or "No response to
 * outreach" when there's none.
 */
export function ReminderNoAnswerDialog({
  followUpId,
  nextStep,
  open,
  onOpenChange,
  onSuccess,
  firstName,
  leadName,
  dealStageLabel,
}: Props) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const markNoResponse = useMutation(api.closer.reminderOutcomes.markReminderNoResponse);
  const givingUp = nextStep === "give_up";

  const form = useForm({
    resolver: standardSchemaResolver(noAnswerSchema),
    defaultValues: { note: "" },
  });

  const onSubmit = async (values: NoAnswerFormValues) => {
    setIsSubmitting(true);
    try {
      const note = values.note?.trim() || undefined;
      await markNoResponse({ followUpId, nextStep, note });

      posthog.capture("reminder_outcome_no_response", {
        follow_up_id: followUpId,
        next_step: nextStep,
        has_note: Boolean(note),
        has_new_reminder_note: false,
        new_contact_method: null,
      });

      toast.success(givingUp ? "Deal closed as lost" : "Task closed");
      onOpenChange(false);
      form.reset();
      onSuccess();
    } catch (err) {
      reportClientError(err, { flow: "reminder_no_response" });
      toast.error(getErrorMessage(err, "Failed to save"));
    } finally {
      setIsSubmitting(false);
    }
  };

  const close = (value: boolean) => {
    if (isSubmitting) return; // don't dismiss mid-submit
    onOpenChange(value);
    if (!value) form.reset();
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className={ACTION_DIALOG} showCloseButton={!isSubmitting}>
        {givingUp ? (
          <ActionDialogHeader
            title={leadName ? `Close ${leadName}’s deal as lost?` : "Close the deal as lost?"}
            description={`No answer from ${firstName}.`}
          />
        ) : (
          <ActionDialogHeader
            title="Close this task only?"
            description={`No answer from ${firstName}. This task closes, the deal stays at ${dealStageLabel}, and nothing new is scheduled.`}
          />
        )}

        <form onSubmit={form.handleSubmit(onSubmit)} className={ACTION_FORM} noValidate>
          {givingUp ? (
            <WhatHappens
              steps={[
                "The deal closes as lost, with the reason below, or “No response to outreach” without one.",
                "This task closes.",
              ]}
            />
          ) : null}
          <FormRows>
            <NoteRow
              label={givingUp ? "Reason (optional)" : "Note (optional)"}
              placeholder={
                givingUp
                  ? "Why is this deal over? (e.g., stopped replying after the call)"
                  : "Anything to remember about this attempt"
              }
              rows={3}
              disabled={isSubmitting}
              error={form.formState.errors.note}
              field={form.register("note")}
            />
          </FormRows>

          <ActionDialogFooter>
            <CancelButton disabled={isSubmitting} onClick={() => close(false)} />
            <SubmitButton pending={isSubmitting} pendingLabel="Saving…" danger={givingUp}>
              {givingUp ? "Close as lost" : "Close task"}
            </SubmitButton>
          </ActionDialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
