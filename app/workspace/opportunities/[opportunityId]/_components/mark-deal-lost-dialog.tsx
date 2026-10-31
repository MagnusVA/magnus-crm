"use client";

import { useState } from "react";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { useMutation } from "convex/react";
import { AlertTriangleIcon, XCircleIcon } from "lucide-react";
import posthog from "posthog-js";
import { reportClientError } from "@/lib/observability/report-client-error";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
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
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { getErrorMessage } from "@/lib/errors";

// The meeting and task pages' lost schema, so lost reasons read the same
// from every entry point.
const markLostSchema = z.object({
  reason: z.string().max(500, "Reason must be under 500 characters").optional(),
});

type MarkLostValues = z.infer<typeof markLostSchema>;

/**
 * Closes a deal as lost with an optional reason, from the deal modal.
 * `side_deal`: the closer (or an admin) closes an open side deal without a
 * payment (`sideDeals.markLost`). `admin`: an admin fixes any deal that can
 * close (`admin.meetingActions.adminMarkAsLost`, no call needed).
 *
 * The submit button sits inside the form rather than in
 * `AlertDialogAction`, which would close the dialog before the mutation runs.
 */
export function MarkDealLostDialog({
  opportunityId,
  mode,
  leadName,
}: {
  opportunityId: Id<"opportunities">;
  mode: "side_deal" | "admin";
  /** Named in the title so the reader knows whose deal closes. */
  leadName?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const markSideDealLost = useMutation(api.sideDeals.markLost.markLost);
  const adminMarkAsLost = useMutation(api.admin.meetingActions.adminMarkAsLost);

  const form = useForm({
    resolver: standardSchemaResolver(markLostSchema),
    defaultValues: { reason: "" },
  });

  const onSubmit = async (values: MarkLostValues) => {
    setIsSubmitting(true);
    try {
      const reason = values.reason?.trim() || undefined;
      if (mode === "admin") {
        await adminMarkAsLost({ opportunityId, reason });
        posthog.capture("admin_deal_marked_lost", {
          opportunity_id: opportunityId,
          has_reason: Boolean(reason),
        });
      } else {
        await markSideDealLost({ opportunityId, reason });
        posthog.capture("side_deal_marked_lost", {
          opportunity_id: opportunityId,
          has_reason: Boolean(reason),
        });
      }
      toast.success("Deal closed as lost");
      form.reset();
      setOpen(false);
    } catch (error) {
      reportClientError(error, {
        flow: mode === "admin" ? "admin_deal_mark_lost" : "side_deal_mark_lost",
      });
      toast.error(getErrorMessage(error, "Couldn't close the deal as lost"));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(value) => {
        if (isSubmitting) return; // don't dismiss mid-submit
        setOpen(value);
        if (!value) form.reset();
      }}
    >
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm">
          <XCircleIcon aria-hidden="true" data-icon="inline-start" />
          Mark lost
        </Button>
      </AlertDialogTrigger>
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
                {mode === "admin"
                  ? "The deal closes as lost for its closer, with your reason on it."
                  : "The side deal closes as lost without a payment, with your reason on it."}
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
                        placeholder="Why did this deal fall through? (e.g., budget, chose another program…)"
                        className="min-h-[100px] resize-none text-sm"
                        autoComplete="off"
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
