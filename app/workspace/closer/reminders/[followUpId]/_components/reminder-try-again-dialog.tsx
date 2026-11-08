"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { Controller, useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { format } from "date-fns";
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
  SubmitError,
} from "@/app/workspace/_components/action-dialog";
import { NoteRow, ReachByRow, WhenRow } from "@/app/workspace/_components/follow-up-dialog-parts";
import { toast } from "sonner";
import posthog from "@/lib/posthog-browser";
import { reportClientError } from "@/lib/observability/report-client-error";
import { getErrorMessage } from "@/lib/errors";

const tryAgainSchema = z
  .object({
    contactMethod: z.enum(["call", "text"], { error: "Pick call or text" }),
    date: z.string().min(1, "Date is required"),
    time: z.string().min(1, "Time is required"),
    note: z.string().max(500, "Keep it under 500 characters").optional(),
  })
  .superRefine((values, ctx) => {
    if (!values.date || !values.time) return;
    const scheduled = new Date(`${values.date}T${values.time}`).getTime();
    if (Number.isNaN(scheduled) || scheduled <= Date.now()) {
      ctx.addIssue({ code: "custom", path: ["time"], message: "Pick a time in the future" });
    }
  });
type TryAgainFormValues = z.infer<typeof tryAgainSchema>;

/** Tomorrow at the task's own time of day, in the browser's time zone. */
function defaultsFor(method: "call" | "text", dueAt: number | null): TryAgainFormValues {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return {
    contactMethod: method,
    date: format(tomorrow, "yyyy-MM-dd"),
    time: dueAt ? format(dueAt, "HH:mm") : "10:00",
    note: "",
  };
}

type Props = {
  followUpId: Id<"followUps">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
  firstName: string;
  /** The task's own method and due time, which the new task starts from. */
  method: "call" | "text";
  dueAt: number | null;
};

/**
 * No answer · Try again: `markReminderNoResponse` with `schedule_new`
 * closes this task and sets a new one for the time picked. The deal stays
 * where it is.
 */
export function ReminderTryAgainDialog({
  followUpId,
  open,
  onOpenChange,
  onSuccess,
  firstName,
  method,
  dueAt,
}: Props) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const markNoResponse = useMutation(api.closer.reminderOutcomes.markReminderNoResponse);

  const form = useForm({
    resolver: standardSchemaResolver(tryAgainSchema),
    defaultValues: defaultsFor(method, dueAt),
  });

  const reset = () => {
    form.reset(defaultsFor(method, dueAt));
    setSubmitError(null);
  };

  const onSubmit = async (values: TryAgainFormValues) => {
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const reminderNote = values.note?.trim() || undefined;
      await markNoResponse({
        followUpId,
        nextStep: "schedule_new",
        newReminder: {
          contactMethod: values.contactMethod,
          reminderScheduledAt: new Date(`${values.date}T${values.time}`).getTime(),
          reminderNote,
        },
      });

      posthog.capture("reminder_outcome_no_response", {
        follow_up_id: followUpId,
        next_step: "schedule_new",
        has_note: false,
        has_new_reminder_note: Boolean(reminderNote),
        new_contact_method: values.contactMethod,
      });

      toast.success("New task set");
      onOpenChange(false);
      reset();
      onSuccess();
    } catch (err) {
      reportClientError(err, { flow: "reminder_no_response" });
      const message = getErrorMessage(err, "Failed to set the new task");
      setSubmitError(message);
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Keeps the date picker from offering past days; the schema is the real guard.
  const todayIso = format(new Date(), "yyyy-MM-dd");

  const { errors } = form.formState;

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (isSubmitting) return; // don't dismiss mid-submit
        onOpenChange(value);
        if (!value) reset();
      }}
    >
      <DialogContent className={ACTION_DIALOG} showCloseButton={!isSubmitting}>
        <ActionDialogHeader
          title={`Try ${firstName} again`}
          description="This task closes and a new one is set for when you pick. The deal stays as it is."
        />

        <form onSubmit={form.handleSubmit(onSubmit)} className={ACTION_FORM} noValidate>
          <SubmitError>{submitError}</SubmitError>
          <FormRows>
            <Controller
              control={form.control}
              name="contactMethod"
              render={({ field, fieldState }) => (
                <ReachByRow
                  value={field.value}
                  onChange={field.onChange}
                  disabled={isSubmitting}
                  error={fieldState.error}
                />
              )}
            />
            <WhenRow
              date={form.register("date")}
              time={form.register("time")}
              min={todayIso}
              disabled={isSubmitting}
              dateError={errors.date}
              timeError={errors.time}
            />
            <NoteRow
              label="Note for next time"
              placeholder="Optional: what to try or mention on the next attempt"
              disabled={isSubmitting}
              error={errors.note}
              field={form.register("note")}
            />
          </FormRows>

          <ActionDialogFooter>
            <CancelButton
              disabled={isSubmitting}
              onClick={() => {
                onOpenChange(false);
                reset();
              }}
            />
            <SubmitButton pending={isSubmitting} pendingLabel="Saving…">
              Close task, set new one
            </SubmitButton>
          </ActionDialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
