"use client";

import { useId, useState } from "react";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { useMutation } from "convex/react";
import { Controller, useForm } from "react-hook-form";
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
} from "@/app/workspace/_components/action-dialog";

type FlagAction =
  | { kind: "flag"; submissionId: Id<"leadGenSubmissions"> }
  | { kind: "dismiss"; flagId: Id<"leadGenCaptureFlags"> };
type Props = FlagAction & { prospectLabel: string };
const schema = z.object({
  text: z
    .string()
    .trim()
    .min(3, "Enter at least 3 characters.")
    .max(500, "Use 500 characters or fewer."),
});

export function CaptureFlagDialog(props: Props) {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const action = props.kind === "flag" ? "Flag" : "Dismiss";
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!submitting) setOpen(value);
      }}
    >
      <DialogTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-label={`${action} capture for ${props.prospectLabel}`}
        >
          {action}
        </Button>
      </DialogTrigger>
      <DialogContent className={ACTION_DIALOG} showCloseButton={!submitting}>
        <ActionDialogHeader
          title={`${action} ${props.kind === "flag" ? "capture" : "flag"} for ${props.prospectLabel}?`}
          description={
            props.kind === "flag"
              ? "An admin will review your reason. This capture still counts until an admin voids it."
              : "The capture will keep counting. The lead generator can read your note."
          }
        />
        <FlagForm
          {...props}
          onSubmitting={setSubmitting}
          onDone={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function FlagForm({
  onSubmitting,
  onDone,
  ...props
}: Props & { onSubmitting: (value: boolean) => void; onDone: () => void }) {
  const textId = useId();
  const flag = useMutation(api.leadGen.captureFlags.flagCapture);
  const dismiss = useMutation(api.leadGen.captureFlags.dismiss);
  const form = useForm({
    resolver: standardSchemaResolver(schema),
    defaultValues: { text: "" },
    mode: "onChange",
  });
  const { isSubmitting, isValid } = form.formState;
  async function submit({ text }: z.infer<typeof schema>) {
    onSubmitting(true);
    try {
      if (props.kind === "flag") {
        const result = await flag({
          submissionId: props.submissionId,
          reason: text,
        });
        toast.success(
          result.alreadyFlagged
            ? "This capture was already flagged"
            : "Capture flagged for review",
        );
      } else {
        const result = await dismiss({ flagId: props.flagId, note: text });
        toast.success(
          result.state === "dismissed"
            ? "Flag dismissed"
            : "This flag was already closed",
        );
      }
      onDone();
    } catch (error) {
      toast.error(getErrorMessage(error, "Couldn't save. Try again."));
    } finally {
      onSubmitting(false);
    }
  }
  return (
    <form className={ACTION_FORM} onSubmit={form.handleSubmit(submit)}>
      <FormRows>
        <Controller
          control={form.control}
          name="text"
          render={({ field, fieldState }) => (
            <FormRow
              label={props.kind === "flag" ? "Reason" : "Note"}
              htmlFor={textId}
              invalid={fieldState.invalid}
              error={fieldState.error}
            >
              <Textarea
                {...field}
                id={textId}
                aria-invalid={fieldState.invalid}
                autoComplete="off"
                disabled={isSubmitting}
                maxLength={500}
                rows={3}
                className="max-h-48 resize-none"
              />
            </FormRow>
          )}
        />
      </FormRows>
      <ActionDialogFooter>
        <CancelButton onClick={onDone} disabled={isSubmitting} />
        <SubmitButton
          pending={isSubmitting}
          pendingLabel="Saving…"
          disabled={!isValid || isSubmitting}
        >
          {props.kind === "flag" ? "Flag capture" : "Dismiss flag"}
        </SubmitButton>
      </ActionDialogFooter>
    </form>
  );
}
