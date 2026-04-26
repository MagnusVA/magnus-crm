"use client";

import { useState } from "react";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { useMutation } from "convex/react";
import { Trash2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
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
}: {
  opportunityId: Id<"opportunities">;
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
      toast.success("Opportunity deleted");
      router.push("/workspace/opportunities");
    } catch (error) {
      posthog.captureException(error);
      const message =
        error instanceof Error ? error.message : "Failed to delete opportunity";
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
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia>
            <Trash2Icon aria-hidden="true" />
          </AlertDialogMedia>
          <AlertDialogTitle>Delete this opportunity?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently removes an empty side-deal opportunity. If payment,
            meeting, or real follow-up work exists, mark it lost instead.
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
                    Deleting…
                  </>
                ) : (
                  "Delete opportunity"
                )}
              </Button>
            </AlertDialogFooter>
          </form>
        </Form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
