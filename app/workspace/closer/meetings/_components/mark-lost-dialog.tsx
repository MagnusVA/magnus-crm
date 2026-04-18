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
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { AlertTriangleIcon, XCircleIcon } from "lucide-react";
import { toast } from "sonner";
import posthog from "posthog-js";

const markLostSchema = z.object({
  reason: z
    .string()
    .max(500, "Reason must be under 500 characters")
    .optional(),
});

type MarkLostFormValues = z.infer<typeof markLostSchema>;

type MarkLostDialogProps = {
  opportunityId: Id<"opportunities">;
  onSuccess?: () => Promise<void>;
};

/**
 * Mark Lost Dialog — confirmation dialog for marking an opportunity as lost.
 *
 * - Modal confirmation to prevent accidental destructive action
 * - Optional reason textarea with 500-character max validation via Zod
 * - Uses React Hook Form for form state management and validation
 * - Loading state + error toast during mutation
 */
export function MarkLostDialog({
  opportunityId,
  onSuccess,
}: MarkLostDialogProps) {
  const [open, setOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const markAsLost = useMutation(api.closer.meetingActions.markAsLost);

  const form = useForm({
    resolver: standardSchemaResolver(markLostSchema),
    defaultValues: {
      reason: "",
    },
  });

  const onSubmit = async (values: MarkLostFormValues) => {
    setIsLoading(true);
    try {
      const trimmedReason = values.reason?.trim() || undefined;
      await markAsLost({
        opportunityId,
        reason: trimmedReason,
      });
      await onSuccess?.();
      posthog.capture("opportunity_marked_lost", {
        opportunity_id: opportunityId,
        has_reason: Boolean(trimmedReason),
      });
      toast.success("Opportunity marked as lost");
      setOpen(false);
      form.reset();
    } catch (error) {
      posthog.captureException(error);
      toast.error(
        error instanceof Error ? error.message : "Failed to mark as lost",
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <>
      <Button variant="destructive" size="lg" onClick={() => setOpen(true)}>
        <XCircleIcon data-icon="inline-start" />
        Mark as Lost
      </Button>

      <AlertDialog
        open={open}
        onOpenChange={(value) => {
          if (!isLoading) {
            setOpen(value);
            if (!value) form.reset();
          }
        }}
      >
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <div className="flex items-start gap-3">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-destructive/10">
                <AlertTriangleIcon className="size-4 text-destructive" />
              </div>
              <div className="flex-1">
                <AlertDialogTitle>Mark as Lost?</AlertDialogTitle>
                <AlertDialogDescription>
                  This marks the opportunity as lost. If this meeting is
                  under overran review, an admin may still dispute the
                  outcome and revert the opportunity.
                </AlertDialogDescription>
              </div>
            </div>
          </AlertDialogHeader>

          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)}>
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

              <AlertDialogFooter className="mt-4">
                <AlertDialogCancel disabled={isLoading}>
                  Cancel
                </AlertDialogCancel>
                <Button
                  type="submit"
                  variant="destructive"
                  disabled={isLoading}
                >
                  {isLoading ? (
                    <>
                      <Spinner data-icon="inline-start" />
                      Marking…
                    </>
                  ) : (
                    "Mark as Lost"
                  )}
                </Button>
              </AlertDialogFooter>
            </form>
          </Form>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
