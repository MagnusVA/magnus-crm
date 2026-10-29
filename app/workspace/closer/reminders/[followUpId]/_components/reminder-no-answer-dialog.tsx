"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
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
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { FieldGroup } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import { AlertTriangleIcon, CheckIcon } from "lucide-react";
import { toast } from "sonner";
import posthog from "posthog-js";
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

  return (
    <AlertDialog
      open={open}
      onOpenChange={(value) => {
        if (isSubmitting) return; // don't dismiss mid-submit
        onOpenChange(value);
        if (!value) form.reset();
      }}
    >
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <div className="flex items-start gap-3">
            <div
              className={
                givingUp
                  ? "flex size-8 shrink-0 items-center justify-center rounded-lg bg-destructive/10 text-danger-ink"
                  : "flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
              }
            >
              {givingUp ? (
                <AlertTriangleIcon className="size-4" aria-hidden />
              ) : (
                <CheckIcon className="size-4" aria-hidden />
              )}
            </div>
            <div className="flex-1">
              <AlertDialogTitle>
                {givingUp
                  ? leadName
                    ? `Close ${leadName}’s deal as lost?`
                    : "Close the deal as lost?"
                  : "Close this task only?"}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {givingUp
                  ? `No answer from ${firstName}. The deal closes as lost and this task closes. Without a reason, the deal records “No response to outreach”.`
                  : `No answer from ${firstName}. This task closes, the deal stays at ${dealStageLabel}, and nothing new is scheduled.`}
              </AlertDialogDescription>
            </div>
          </div>
        </AlertDialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)}>
            <FieldGroup>
              <FormField
                control={form.control}
                name="note"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{givingUp ? "Reason (optional)" : "Note (optional)"}</FormLabel>
                    <FormControl>
                      <Textarea
                        rows={3}
                        placeholder={
                          givingUp
                            ? "Why is this deal over? (e.g., stopped replying after the call)"
                            : "Anything to remember about this attempt"
                        }
                        className="resize-none text-sm"
                        disabled={isSubmitting}
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </FieldGroup>

            <AlertDialogFooter className="mt-4">
              <AlertDialogCancel disabled={isSubmitting}>Cancel</AlertDialogCancel>
              <Button
                type="submit"
                variant={givingUp ? "destructive" : "default"}
                className={givingUp ? "text-danger-ink" : undefined}
                disabled={isSubmitting}
              >
                {isSubmitting ? (
                  <>
                    <Spinner data-icon="inline-start" />
                    Saving…
                  </>
                ) : givingUp ? (
                  "Close as lost"
                ) : (
                  "Close task"
                )}
              </Button>
            </AlertDialogFooter>
          </form>
        </Form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
