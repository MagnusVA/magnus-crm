"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { format } from "date-fns";
import { z } from "zod";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { DayDefinition } from "@/app/workspace/_components/day-definition";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { FieldGroup } from "@/components/ui/field";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertCircleIcon, MessageSquareIcon, PhoneIcon } from "lucide-react";
import { toast } from "sonner";
import posthog from "posthog-js";
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

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (isSubmitting) return; // don't dismiss mid-submit
        onOpenChange(value);
        if (!value) reset();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Try {firstName} again</DialogTitle>
          <DialogDescription>
            This task closes and a new one is set for when you pick. The deal stays as it is.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)}>
            <FieldGroup>
              <FormField
                control={form.control}
                name="contactMethod"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Reach by <span className="text-destructive">*</span>
                    </FormLabel>
                    <FormControl>
                      <ToggleGroup
                        type="single"
                        variant="outline"
                        value={field.value}
                        onValueChange={(value) => {
                          if (value) field.onChange(value);
                        }}
                        className="justify-start"
                        disabled={isSubmitting}
                      >
                        <ToggleGroupItem value="call" className="px-3">
                          <PhoneIcon data-icon="inline-start" aria-hidden />
                          Call
                        </ToggleGroupItem>
                        <ToggleGroupItem value="text" className="px-3">
                          <MessageSquareIcon data-icon="inline-start" aria-hidden />
                          Text
                        </ToggleGroupItem>
                      </ToggleGroup>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid grid-cols-2 gap-3">
                <FormField
                  control={form.control}
                  name="date"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        Date <span className="text-destructive">*</span>
                      </FormLabel>
                      <FormControl>
                        <Input type="date" min={todayIso} disabled={isSubmitting} {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="time"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        Time <span className="text-destructive">*</span>
                      </FormLabel>
                      <FormControl>
                        <Input type="time" disabled={isSubmitting} {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="col-span-2 -mt-1">
                  <DayDefinition browser />
                </div>
              </div>

              <FormField
                control={form.control}
                name="note"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Note for next time (optional)</FormLabel>
                    <FormControl>
                      <Textarea
                        rows={2}
                        placeholder="What to try or mention on the next attempt"
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

            {submitError && (
              <Alert variant="destructive" className="mt-4">
                <AlertCircleIcon />
                <AlertDescription>{submitError}</AlertDescription>
              </Alert>
            )}

            <DialogFooter className="mt-5">
              <Button
                type="button"
                variant="ghost"
                disabled={isSubmitting}
                onClick={() => {
                  onOpenChange(false);
                  reset();
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? (
                  <>
                    <Spinner data-icon="inline-start" />
                    Saving…
                  </>
                ) : (
                  "Close this task and set the new one"
                )}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
