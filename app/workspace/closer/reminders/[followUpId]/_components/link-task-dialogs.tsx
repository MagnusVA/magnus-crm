"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { useMutation } from "convex/react";
import { AlertTriangleIcon, Link2OffIcon } from "lucide-react";
import { toast } from "sonner";
import posthog from "posthog-js";
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
import { FieldGroup } from "@/components/ui/field";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { getErrorMessage } from "@/lib/errors";
import { reportClientError } from "@/lib/observability/report-client-error";

type DialogProps = {
  followUpId: Id<"followUps">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
  firstName: string;
};

/**
 * "Cancel the link": `cancelLinkTask` closes the task and leaves the deal at
 * its stage. The confirm button sits outside `AlertDialogAction`, which would
 * close the dialog before the mutation runs.
 */
export function LinkCancelDialog({
  followUpId,
  open,
  onOpenChange,
  onSuccess,
  firstName,
  dealStageLabel,
}: DialogProps & {
  /** The deal's stage today, which cancelling leaves alone. */
  dealStageLabel: string;
}) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const cancelLinkTask = useMutation(api.closer.linkTaskOutcomes.cancelLinkTask);

  const confirm = async () => {
    setIsSubmitting(true);
    try {
      await cancelLinkTask({ followUpId });
      posthog.capture("link_task_canceled", { follow_up_id: followUpId });
      toast.success("Link canceled");
      onOpenChange(false);
      onSuccess();
    } catch (err) {
      reportClientError(err, { flow: "link_task_cancel" });
      toast.error(getErrorMessage(err, "Couldn't cancel the link"));
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
      }}
    >
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <div className="flex items-start gap-3">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <Link2OffIcon className="size-4" aria-hidden />
            </div>
            <div className="flex-1">
              <AlertDialogTitle>Cancel the link for {firstName}?</AlertDialogTitle>
              <AlertDialogDescription>
                This task closes and stops waiting for a booking. The deal stays at{" "}
                {dealStageLabel}, with no next step until one is set from the deal.
              </AlertDialogDescription>
            </div>
          </div>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isSubmitting}>Keep waiting</AlertDialogCancel>
          <Button type="button" onClick={() => void confirm()} disabled={isSubmitting}>
            {isSubmitting ? (
              <>
                <Spinner data-icon="inline-start" />
                Canceling…
              </>
            ) : (
              "Cancel the link"
            )}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// The meeting page's MarkLostDialog schema, so lost reasons read the same
// from every entry point.
const markLostSchema = z.object({
  reason: z.string().max(500, "Reason must be under 500 characters").optional(),
});
type MarkLostFormValues = z.infer<typeof markLostSchema>;

/**
 * "Mark the deal lost": `markLinkTaskLost` closes the link and the deal as
 * lost, with the optional reason on both.
 */
export function LinkLostDialog({
  followUpId,
  open,
  onOpenChange,
  onSuccess,
  firstName,
  leadName,
}: DialogProps & {
  /** Named in the title so the closer knows whose deal closes. */
  leadName: string | null;
}) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const markLinkTaskLost = useMutation(api.closer.linkTaskOutcomes.markLinkTaskLost);

  const form = useForm({
    resolver: standardSchemaResolver(markLostSchema),
    defaultValues: { reason: "" },
  });

  const onSubmit = async (values: MarkLostFormValues) => {
    setIsSubmitting(true);
    try {
      const reason = values.reason?.trim() || undefined;
      await markLinkTaskLost({ followUpId, reason });
      posthog.capture("link_task_lost", {
        follow_up_id: followUpId,
        has_reason: Boolean(reason),
      });
      toast.success("Deal closed as lost");
      onOpenChange(false);
      form.reset();
      onSuccess();
    } catch (err) {
      reportClientError(err, { flow: "link_task_lost" });
      toast.error(getErrorMessage(err, "Couldn't mark the deal lost"));
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
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-destructive/10 text-danger-ink">
              <AlertTriangleIcon className="size-4" aria-hidden />
            </div>
            <div className="flex-1">
              <AlertDialogTitle>
                {leadName ? `Close ${leadName}’s deal as lost?` : "Close the deal as lost?"}
              </AlertDialogTitle>
              <AlertDialogDescription>
                No booking from {firstName}. The link and this task close, and the deal closes
                as lost, with the reason when one is given.
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
                        rows={3}
                        placeholder="Why is this deal over? (e.g., stopped replying after the link)"
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
              <AlertDialogCancel disabled={isSubmitting}>Keep waiting</AlertDialogCancel>
              <Button
                type="submit"
                variant="destructive"
                className="text-danger-ink"
                disabled={isSubmitting}
              >
                {isSubmitting ? (
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
