"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import posthog from "@/lib/posthog-browser";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  ACTION_DIALOG,
  ACTION_FORM,
  ActionDialogFooter,
  ActionDialogHeader,
  CancelButton,
  FormRows,
  SubmitButton,
  WhatHappens,
} from "@/app/workspace/_components/action-dialog";
import { NoteRow } from "@/app/workspace/_components/follow-up-dialog-parts";
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
 * its stage.
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

  const close = (value: boolean) => {
    if (isSubmitting) return; // don't dismiss mid-submit
    onOpenChange(value);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className={ACTION_DIALOG} showCloseButton={!isSubmitting}>
        <ActionDialogHeader
          title={`Cancel the link for ${firstName}?`}
          description={`This task closes and stops waiting for a booking. The deal stays at ${dealStageLabel}, with no next step until one is set from the deal.`}
        />
        <ActionDialogFooter>
          <CancelButton disabled={isSubmitting} onClick={() => close(false)}>
            Keep waiting
          </CancelButton>
          <SubmitButton type="button" pending={isSubmitting} pendingLabel="Canceling…" onClick={() => void confirm()}>
            Cancel the link
          </SubmitButton>
        </ActionDialogFooter>
      </DialogContent>
    </Dialog>
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

  const close = (value: boolean) => {
    if (isSubmitting) return; // don't dismiss mid-submit
    onOpenChange(value);
    if (!value) form.reset();
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className={ACTION_DIALOG} showCloseButton={!isSubmitting}>
        <ActionDialogHeader
          title={leadName ? `Close ${leadName}’s deal as lost?` : "Close the deal as lost?"}
          description={`No booking from ${firstName}.`}
        />

        <form onSubmit={form.handleSubmit(onSubmit)} className={ACTION_FORM} noValidate>
          <WhatHappens
            steps={[
              "The link and this task close.",
              "The deal closes as lost, with the reason when one is given.",
            ]}
          />
          <FormRows>
            <NoteRow
              label="Reason (optional)"
              placeholder="Why is this deal over? (e.g., stopped replying after the link)"
              rows={3}
              disabled={isSubmitting}
              error={form.formState.errors.reason}
              field={form.register("reason")}
            />
          </FormRows>

          <ActionDialogFooter>
            <CancelButton disabled={isSubmitting} onClick={() => close(false)}>
              Keep waiting
            </CancelButton>
            <SubmitButton pending={isSubmitting} pendingLabel="Closing…" danger>
              Close as lost
            </SubmitButton>
          </ActionDialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
