"use client";

import { useState } from "react";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { useMutation } from "convex/react";
import { AlertTriangleIcon, XCircleIcon } from "lucide-react";
import posthog from "posthog-js";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
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
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

const markLostSchema = z.object({
  reason: z
    .string()
    .max(500, "Reason must be under 500 characters")
    .optional(),
});

type MarkLostValues = z.infer<typeof markLostSchema>;

export function MarkSideDealLostDialog({
  opportunityId,
}: {
  opportunityId: Id<"opportunities">;
}) {
  const [open, setOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const markLost = useMutation(api.sideDeals.markLost.markLost);

  const form = useForm({
    resolver: standardSchemaResolver(markLostSchema),
    defaultValues: { reason: "" },
  });

  const onSubmit = async (values: MarkLostValues) => {
    setIsSubmitting(true);
    setSubmitError(null);

    try {
      const reason = values.reason?.trim() || undefined;
      await markLost({ opportunityId, reason });
      posthog.capture("side_deal_marked_lost", {
        opportunity_id: opportunityId,
        has_reason: Boolean(reason),
      });
      toast.success("Opportunity marked lost");
      form.reset();
      setOpen(false);
    } catch (error) {
      posthog.captureException(error);
      const message =
        error instanceof Error ? error.message : "Failed to mark lost";
      setSubmitError(message);
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(value) => {
        if (!isSubmitting) {
          setOpen(value);
          if (!value) {
            form.reset();
            setSubmitError(null);
          }
        }
      }}
    >
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm">
          <XCircleIcon aria-hidden="true" data-icon="inline-start" />
          Mark lost
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia>
            <AlertTriangleIcon aria-hidden="true" />
          </AlertDialogMedia>
          <AlertDialogTitle>Mark this opportunity lost?</AlertDialogTitle>
          <AlertDialogDescription>
            This closes the side-deal opportunity without recording payment.
          </AlertDialogDescription>
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
                      rows={3}
                      className="resize-none"
                      placeholder="Why did this opportunity fall through?…"
                      autoComplete="off"
                      disabled={isSubmitting}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {submitError ? (
              <Alert variant="destructive" className="mt-4">
                <AlertDescription>{submitError}</AlertDescription>
              </Alert>
            ) : null}

            <AlertDialogFooter className="mt-5">
              <AlertDialogCancel disabled={isSubmitting}>
                Cancel
              </AlertDialogCancel>
              <Button
                type="submit"
                variant="destructive"
                disabled={isSubmitting}
              >
                {isSubmitting ? (
                  <>
                    <Spinner data-icon="inline-start" />
                    Marking…
                  </>
                ) : (
                  "Mark lost"
                )}
              </Button>
            </AlertDialogFooter>
          </form>
        </Form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
