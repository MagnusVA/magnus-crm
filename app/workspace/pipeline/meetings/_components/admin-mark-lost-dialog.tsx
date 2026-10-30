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
import { reportClientError } from "@/lib/observability/report-client-error";
import { getErrorMessage } from "@/lib/errors";

const markLostSchema = z.object({
  reason: z
    .string()
    .max(500, "Reason must be under 500 characters")
    .optional(),
});

type MarkLostFormValues = z.infer<typeof markLostSchema>;

type AdminMarkLostDialogProps = {
  opportunityId: Id<"opportunities">;
  meetingId?: Id<"meetings">;
  onSuccess?: () => Promise<void>;
  /** Controlled open state. When set, the dialog renders no trigger button. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Named in the dialog so the closer knows whose deal closes. */
  leadName?: string | null;
};

/**
 * Admin Mark Lost Dialog — confirmation dialog for marking an opportunity as lost
 * on behalf of a closer. Calls the admin-specific mutation.
 */
export function AdminMarkLostDialog({
  opportunityId,
  meetingId,
  onSuccess,
  open: controlledOpen,
  onOpenChange,
  leadName,
}: AdminMarkLostDialogProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = controlledOpen ?? internalOpen;
  const setOpen = (value: boolean) => {
    if (!isControlled) setInternalOpen(value);
    onOpenChange?.(value);
  };
  const [isLoading, setIsLoading] = useState(false);
  const markAsLost = useMutation(api.admin.meetingActions.adminMarkAsLost);

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
        meetingId,
        reason: trimmedReason,
      });
      await onSuccess?.();
      posthog.capture("admin_opportunity_marked_lost", {
        opportunity_id: opportunityId,
        meeting_id: meetingId ?? null,
        has_reason: Boolean(trimmedReason),
      });
      toast.success("Deal closed as lost");
      setOpen(false);
      form.reset();
    } catch (error) {
      reportClientError(error, { flow: "admin_mark_lost" });
      toast.error(
        getErrorMessage(error, "Failed to mark as lost"),
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <>
      {isControlled ? null : (
        <Button
          variant="destructive"
          size="sm"
          className="text-danger-ink"
          onClick={() => setOpen(true)}
        >
          <XCircleIcon data-icon="inline-start" />
          Mark as Lost
        </Button>
      )}

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
                <AlertTriangleIcon className="size-4 text-danger-ink" />
              </div>
              <div className="flex-1">
                <AlertDialogTitle>
                  {leadName
                    ? `Close ${leadName}\u2019s deal as lost?`
                    : "Close the deal as lost?"}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {meetingId
                    ? "On behalf of the assigned closer: the call is marked held and the deal closes as lost. This can\u2019t be undone here."
                    : "On behalf of the assigned closer: the deal closes as lost. This can\u2019t be undone here."}
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
                        placeholder="Why did this deal fall through?"
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
                  className="text-danger-ink"
                  disabled={isLoading}
                >
                  {isLoading ? (
                    <>
                      <Spinner data-icon="inline-start" />
                      Marking…
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
    </>
  );
}
