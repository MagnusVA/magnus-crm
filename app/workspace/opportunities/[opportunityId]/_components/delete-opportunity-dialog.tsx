"use client";

import { useState } from "react";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { useMutation } from "convex/react";
import { Trash2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import posthog from "posthog-js";
import { reportClientError } from "@/lib/observability/report-client-error";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { FieldGroup } from "@/components/ui/field";
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

const deleteOpportunitySchema = z.object({
  reason: z
    .string()
    .max(500, "Reason must be under 500 characters")
    .optional()
    .or(z.literal("")),
});

type DeleteOpportunityValues = z.infer<typeof deleteOpportunitySchema>;

export function DeleteOpportunityDialog({
  opportunityId,
  onDeleted,
}: {
  opportunityId: Id<"opportunities">;
  /** Runs after the delete, such as closing the deal modal; else the page leaves for the deals list. */
  onDeleted?: () => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const deleteOpportunity = useMutation(
    api.sideDeals.deleteEmptyOpportunity.deleteEmptyOpportunity,
  );

  const form = useForm({
    resolver: standardSchemaResolver(deleteOpportunitySchema),
    defaultValues: { reason: "" },
  });

  const onSubmit = async (values: DeleteOpportunityValues) => {
    setIsSubmitting(true);
    setSubmitError(null);

    try {
      const reason = values.reason?.trim() || undefined;
      await deleteOpportunity({ opportunityId, reason });
      posthog.capture("opportunity_deleted", {
        opportunity_id: opportunityId,
        has_reason: Boolean(reason),
      });
      toast.success("Side deal deleted");
      if (onDeleted) {
        setIsSubmitting(false);
        setOpen(false);
        onDeleted();
      } else {
        router.push("/workspace/opportunities");
      }
    } catch (error) {
      reportClientError(error, { flow: "opportunity_delete" });
      const message =
        getErrorMessage(error, "Couldn't delete the side deal");
      setSubmitError(message);
      toast.error(message);
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
          <Trash2Icon aria-hidden="true" data-icon="inline-start" />
          Delete
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <div className="flex items-start gap-3">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-destructive/10">
              <Trash2Icon className="size-4 text-danger-ink" aria-hidden="true" />
            </div>
            <div className="flex-1">
              <AlertDialogTitle>Delete this side deal?</AlertDialogTitle>
              <AlertDialogDescription>
                The empty side deal is removed for good. Once it has a payment,
                a call or a task, mark it lost instead.
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
                      className="resize-none"
                      placeholder="Created by mistake…"
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

            {submitError ? (
              <Alert variant="destructive" className="mt-4">
                <AlertDescription>{submitError}</AlertDescription>
              </Alert>
            ) : null}

            <AlertDialogFooter className="mt-4">
              <AlertDialogCancel disabled={isSubmitting}>
                Cancel
              </AlertDialogCancel>
              <Button
                type="submit"
                variant="destructive"
                className="text-danger-ink"
                disabled={isSubmitting}
              >
                {isSubmitting ? (
                  <>
                    <Spinner data-icon="inline-start" />
                    Deleting…
                  </>
                ) : (
                  "Delete side deal"
                )}
              </Button>
            </AlertDialogFooter>
          </form>
        </Form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
