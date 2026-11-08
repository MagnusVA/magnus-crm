"use client";

import { useId, useState } from "react";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { useMutation } from "convex/react";
import { BanIcon } from "lucide-react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
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
  WhatHappens,
} from "@/app/workspace/_components/action-dialog";

const voidSubmissionSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(3, "Enter a reason before voiding this submission.")
    .max(1000, "Reason must be 1000 characters or fewer."),
});

type VoidSubmissionFormValues = z.infer<typeof voidSubmissionSchema>;

/** What Void does, in the order `leadGen.corrections.voidSubmission` does it. */
const STEPS = [
  "Takes it out of Lead Gen counts and reports.",
  "Marks it voided, with your reason.",
  "Adds the void to the person’s timeline, if they’re in Magnus.",
];

export function VoidSubmissionDialog({
  submissionId,
  prospectLabel,
  compactTrigger = false,
}: {
  submissionId: Id<"leadGenSubmissions">;
  prospectLabel?: string;
  compactTrigger?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isSubmitting) setOpen(nextOpen);
      }}
    >
      <DialogTrigger asChild>
        <Button
          aria-label={`Void submission${prospectLabel ? ` for ${prospectLabel}` : ""}`}
          size={compactTrigger ? "icon-sm" : "sm"}
          variant={compactTrigger ? "ghost" : "destructive"}
          className={compactTrigger ? "text-danger-ink hover:bg-destructive/10 hover:text-danger-ink" : undefined}
          title={compactTrigger ? "Void submission" : undefined}
        >
          <BanIcon aria-hidden="true" data-icon="inline-start" />
          {compactTrigger ? null : "Void"}
        </Button>
      </DialogTrigger>
      <DialogContent className={ACTION_DIALOG} showCloseButton={!isSubmitting}>
        <ActionDialogHeader
          title={
            prospectLabel ? (
              <>
                Void the submission for <span translate="no">{prospectLabel}</span>?
              </>
            ) : (
              "Void this submission?"
            )
          }
          description="The raw record and its history stay. Nothing is deleted."
        />
        {/* Inside the content, so the reason clears each time the dialog opens. */}
        <VoidSubmissionForm
          submissionId={submissionId}
          onSubmittingChange={setIsSubmitting}
          onDone={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function VoidSubmissionForm({
  submissionId,
  onSubmittingChange,
  onDone,
}: {
  submissionId: Id<"leadGenSubmissions">;
  onSubmittingChange: (submitting: boolean) => void;
  onDone: () => void;
}) {
  const reasonId = useId();
  const voidSubmission = useMutation(api.leadGen.corrections.voidSubmission);
  const form = useForm({
    resolver: standardSchemaResolver(voidSubmissionSchema),
    defaultValues: { reason: "" },
    mode: "onChange",
  });
  const isSubmitting = form.formState.isSubmitting;
  const reason = useWatch({ control: form.control, name: "reason" }) ?? "";
  const trimmedReasonLength = reason.trim().length;
  const canSubmit =
    trimmedReasonLength >= 3 && trimmedReasonLength <= 1000 && !isSubmitting;

  async function onSubmit(values: VoidSubmissionFormValues) {
    onSubmittingChange(true);
    try {
      const result = await voidSubmission({
        submissionId,
        reason: values.reason,
      });
      toast.success(
        result.alreadyVoided
          ? "Submission was already voided"
          : "Submission voided",
      );
      onSubmittingChange(false);
      onDone();
    } catch (error) {
      onSubmittingChange(false);
      toast.error(
        getErrorMessage(error, "Failed to void submission"),
      );
    }
  }

  return (
    <form className={ACTION_FORM} onSubmit={form.handleSubmit(onSubmit)}>
      <WhatHappens steps={STEPS} />
      <FormRows>
        <Controller
          control={form.control}
          name="reason"
          render={({ field, fieldState }) => (
            <FormRow label="Reason" htmlFor={reasonId} invalid={fieldState.invalid} error={fieldState.error}>
              <Textarea
                {...field}
                id={reasonId}
                aria-invalid={fieldState.invalid}
                autoComplete="off"
                disabled={isSubmitting}
                maxLength={1000}
                placeholder="Explain why this submission should be voided…"
                rows={3}
                className="max-h-48 resize-none"
              />
            </FormRow>
          )}
        />
      </FormRows>
      <ActionDialogFooter>
        <CancelButton onClick={onDone} disabled={isSubmitting} />
        <SubmitButton pending={isSubmitting} pendingLabel="Voiding…" danger disabled={!canSubmit}>
          Void submission
        </SubmitButton>
      </ActionDialogFooter>
    </form>
  );
}
