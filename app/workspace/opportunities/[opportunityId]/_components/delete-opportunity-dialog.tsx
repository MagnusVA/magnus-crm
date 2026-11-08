"use client";

import { useId, useState } from "react";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { useMutation } from "convex/react";
import { Trash2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import posthog from "@/lib/posthog-browser";
import { reportClientError } from "@/lib/observability/report-client-error";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { getErrorMessage } from "@/lib/errors";
import {
  ACTION_DIALOG,
  ACTION_FORM,
  ActionDialogFooter,
  ActionDialogHeader,
  CancelButton,
  FormRow,
  FormRows,
  SubmitButton,
  SubmitError,
} from "@/app/workspace/_components/action-dialog";

const deleteOpportunitySchema = z.object({
  reason: z
    .string()
    .max(500, "Reason must be under 500 characters")
    .optional()
    .or(z.literal("")),
});

type DeleteOpportunityValues = z.infer<typeof deleteOpportunitySchema>;

/**
 * Deletes an empty side deal for good (`sideDeals.deleteEmptyOpportunity`).
 * The deal modal shows it only while the deal has no payment, call or task.
 */
export function DeleteOpportunityDialog({
  opportunityId,
  onDeleted,
  leadName,
}: {
  opportunityId: Id<"opportunities">;
  /** Runs after the delete, such as closing the deal modal; else the page leaves for the deals list. */
  onDeleted?: () => void;
  /** Named in the title so the reader knows whose deal goes. */
  leadName?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!isSubmitting) setOpen(value);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Trash2Icon aria-hidden="true" data-icon="inline-start" />
          Delete
        </Button>
      </DialogTrigger>
      <DialogContent className={ACTION_DIALOG} showCloseButton={!isSubmitting}>
        <ActionDialogHeader
          title={
            leadName ? (
              <>
                Delete <span translate="no">{leadName}</span>&rsquo;s side deal?
              </>
            ) : (
              "Delete this side deal?"
            )
          }
          description={"The empty side deal is removed for good. This can’t be undone."}
          tone="danger"
        />
        {/* Inside the content, so the reason and any error clear each time the dialog opens. */}
        <DeleteOpportunityForm
          opportunityId={opportunityId}
          onDeleted={onDeleted}
          isSubmitting={isSubmitting}
          setIsSubmitting={setIsSubmitting}
          setOpen={setOpen}
        />
      </DialogContent>
    </Dialog>
  );
}

function DeleteOpportunityForm({
  opportunityId,
  onDeleted,
  isSubmitting,
  setIsSubmitting,
  setOpen,
}: {
  opportunityId: Id<"opportunities">;
  onDeleted?: () => void;
  isSubmitting: boolean;
  setIsSubmitting: (submitting: boolean) => void;
  setOpen: (open: boolean) => void;
}) {
  const router = useRouter();
  const reasonId = useId();
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
    <form onSubmit={form.handleSubmit(onSubmit)} className={ACTION_FORM}>
      <SubmitError>{submitError}</SubmitError>
      <FormRows>
        <Controller
          control={form.control}
          name="reason"
          render={({ field, fieldState }) => (
            <FormRow
              label="Reason"
              htmlFor={reasonId}
              invalid={fieldState.invalid}
              error={fieldState.error}
              description="Optional."
            >
              <Textarea
                {...field}
                id={reasonId}
                aria-invalid={fieldState.invalid}
                rows={3}
                className="max-h-48 resize-none"
                placeholder="Created by mistake…"
                autoComplete="off"
                disabled={isSubmitting}
              />
            </FormRow>
          )}
        />
      </FormRows>
      <ActionDialogFooter>
        <CancelButton onClick={() => setOpen(false)} disabled={isSubmitting} />
        <SubmitButton pending={isSubmitting} pendingLabel="Deleting…" danger>
          Delete side deal
        </SubmitButton>
      </ActionDialogFooter>
    </form>
  );
}
