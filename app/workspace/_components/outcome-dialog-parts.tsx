"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  ReadingChangedNotice,
  withFromCall,
  type LostSuggestion,
} from "@/components/call-insights/suggestion-context";
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
} from "./action-dialog";

// The lost confirm that the meeting page, the task page and the deal modal
// share: one schema, so lost reasons read the same from every entry point,
// and one body. Each dialog keeps its own mutation, toast, event and errors.

const lostReasonSchema = z.object({
  reason: z.string().max(500, "Reason must be under 500 characters").optional(),
});

/**
 * "Close {name}'s deal as lost?": what happens, an optional reason, then the
 * danger "Close as lost". The form lives inside the content, so it starts
 * empty each time the dialog opens. `onConfirm` gets the trimmed reason.
 */
export function LostDealDialog({
  open,
  onOpenChange,
  pending,
  leadName,
  consequence,
  steps,
  placeholder,
  trigger,
  onConfirm,
  suggestion,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  leadName?: string | null;
  /** The header's danger line: the one consequence, or what can't be undone above `steps`. */
  consequence: ReactNode;
  /** What the server does, in its order, when it changes more than the deal. */
  steps?: ReactNode[];
  placeholder: string;
  /** A button that opens the dialog, for the dialogs that render their own. */
  trigger?: ReactNode;
  onConfirm: (reason: string | undefined) => Promise<void>;
  /** Opened from a suggested loss: the reason starts as the category's fixed label. */
  suggestion?: LostSuggestion;
}) {
  const fromCall = suggestion !== undefined;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Esc mid-submit would drop the reason under the running mutation.
        if (!pending) onOpenChange(next);
      }}
    >
      {trigger ? <DialogTrigger asChild>{trigger}</DialogTrigger> : null}
      <DialogContent className={cn(ACTION_DIALOG, fromCall && "ph-no-capture")} showCloseButton={!pending}>
        <ActionDialogHeader
          title={withFromCall(
            leadName ? (
              <>
                Close <span translate="no">{leadName}</span>&rsquo;s deal as lost?
              </>
            ) : (
              "Close the deal as lost?"
            ),
            fromCall,
          )}
          description={consequence}
          tone="danger"
        />
        {suggestion?.changed ? (
          <ReadingChangedNotice onUseNew={suggestion.onUseNew} onKeep={suggestion.onKeep} disabled={pending} />
        ) : null}
        <LostReasonForm
          prefill={suggestion?.reason ?? null}
          steps={steps}
          placeholder={placeholder}
          pending={pending}
          onCancel={() => onOpenChange(false)}
          onConfirm={onConfirm}
        />
      </DialogContent>
    </Dialog>
  );
}

function LostReasonForm({
  prefill,
  steps,
  placeholder,
  pending,
  onCancel,
  onConfirm,
}: {
  /** A suggested loss category's label, taken again when its key changes. */
  prefill: { key: string; text: string } | null;
  steps?: ReactNode[];
  placeholder: string;
  pending: boolean;
  onCancel: () => void;
  onConfirm: (reason: string | undefined) => Promise<void>;
}) {
  const reasonId = useId();
  const form = useForm({
    resolver: standardSchemaResolver(lostReasonSchema),
    defaultValues: { reason: prefill?.text ?? "" },
  });
  const appliedKey = useRef(prefill?.key ?? null);
  useEffect(() => {
    if (!prefill || prefill.key === appliedKey.current) return;
    appliedKey.current = prefill.key;
    form.setValue("reason", prefill.text);
  }, [prefill, form]);

  return (
    <form
      className={ACTION_FORM}
      onSubmit={form.handleSubmit((values) => onConfirm(values.reason?.trim() || undefined))}
    >
      {steps ? <WhatHappens steps={steps} /> : null}
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
              description={
                prefill
                  ? "Only the label is filled. The prospect's words are never saved as the reason."
                  : "Optional. It shows on the deal."
              }
            >
              <Textarea
                {...field}
                id={reasonId}
                aria-invalid={fieldState.invalid}
                placeholder={placeholder}
                className="max-h-48 min-h-24 resize-none text-sm"
                autoComplete="off"
                disabled={pending}
              />
            </FormRow>
          )}
        />
      </FormRows>
      <ActionDialogFooter>
        <CancelButton onClick={onCancel} disabled={pending} />
        <SubmitButton pending={pending} pendingLabel="Closing…" danger>
          Close as lost
        </SubmitButton>
      </ActionDialogFooter>
    </form>
  );
}
