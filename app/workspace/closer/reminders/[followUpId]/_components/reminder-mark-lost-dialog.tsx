"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { useMutation } from "convex/react";
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
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import { FieldGroup } from "@/components/ui/field";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { AlertTriangleIcon } from "lucide-react";
import { toast } from "sonner";
import posthog from "posthog-js";
import { reportClientError } from "@/lib/observability/report-client-error";
import { getErrorMessage } from "@/lib/errors";

// The meeting page's MarkLostDialog schema, so lost reasons read the same
// from both entry points.
const markLostSchema = z.object({
  reason: z.string().max(500, "Reason must be under 500 characters").optional(),
});
type MarkLostFormValues = z.infer<typeof markLostSchema>;

type Props = {
  followUpId: Id<"followUps">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
  /** Named in the title so the closer knows whose deal closes. */
  leadName: string | null;
};

/**
 * Lost, after the closer reached the person: `markReminderLost` closes the
 * deal as lost with the reason and completes the task. The submit button
 * sits inside the form rather than in `AlertDialogAction`, which would close
 * the dialog before the mutation runs.
 */
export function ReminderMarkLostDialog({
  followUpId,
  open,
  onOpenChange,
  onSuccess,
  leadName,
}: Props) {
  const [isLoading, setIsLoading] = useState(false);
  const markReminderLost = useMutation(api.closer.reminderOutcomes.markReminderLost);

  const form = useForm({
    resolver: standardSchemaResolver(markLostSchema),
    defaultValues: { reason: "" },
  });

  const onSubmit = async (values: MarkLostFormValues) => {
    setIsLoading(true);
    try {
      const trimmedReason = values.reason?.trim() || undefined;
      await markReminderLost({ followUpId, reason: trimmedReason });

      posthog.capture("reminder_outcome_lost", {
        follow_up_id: followUpId,
        has_reason: Boolean(trimmedReason),
      });
      toast.success("Deal closed as lost");
      onOpenChange(false);
      form.reset();
      onSuccess();
    } catch (err) {
      reportClientError(err, { flow: "reminder_mark_lost" });
      toast.error(getErrorMessage(err, "Failed to mark as lost"));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(value) => {
        if (isLoading) return; // don't dismiss mid-submit
        onOpenChange(value);
        if (!value) form.reset();
      }}
    >
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <div className="flex items-start gap-3">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-destructive/10">
              <AlertTriangleIcon className="size-4 text-danger-ink" aria-hidden />
            </div>
            <div className="flex-1">
              <AlertDialogTitle>
                {leadName ? `Close ${leadName}’s deal as lost?` : "Close the deal as lost?"}
              </AlertDialogTitle>
              <AlertDialogDescription>
                The deal closes as lost with your reason on it, and this task closes.
              </AlertDialogDescription>
            </div>
          </div>
        </AlertDialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)}>
            <FieldGroup>
              <FormField
                control={form.control}
                name="reason"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Reason (optional)</FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder="Why did this deal fall through? (e.g., budget constraints, chose competitor…)"
                        className="min-h-[100px] resize-none text-sm"
                        disabled={isLoading}
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </FieldGroup>

            <AlertDialogFooter className="mt-4">
              <AlertDialogCancel disabled={isLoading}>Cancel</AlertDialogCancel>
              <Button
                type="submit"
                variant="destructive"
                className="text-danger-ink"
                disabled={isLoading}
              >
                {isLoading ? (
                  <>
                    <Spinner data-icon="inline-start" />
                    Closing…
                  </>
                ) : (
                  "Close as lost"
                )}
              </Button>
            </AlertDialogFooter>
          </form>
        </Form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
