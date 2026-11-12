"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import posthog from "@/lib/posthog-browser";
import { getErrorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { changedFields } from "@/lib/callInsights/display";
import type { FromSuggestion } from "@/convex/callInsights/validators";
import { Button } from "@/components/ui/button";
import {
  ReadingChangedNotice,
  useSuggestionRef,
  withFromCall,
  type DialogSuggestion,
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
} from "@/app/workspace/_components/action-dialog";

const NO_SHOW_REASONS = [
  { value: "no_response", label: "Lead didn't show up (no communication)" },
  { value: "late_cancel", label: "Lead messaged — can't make it" },
  {
    value: "technical_issues",
    label: "Technical issues prevented meeting",
  },
  { value: "other", label: "Other reason" },
] as const;

const markNoShowSchema = z.object({
  reason: z.enum([
    "no_response",
    "late_cancel",
    "technical_issues",
    "other",
  ], { error: "Pick a reason" }),
  note: z.string().max(500, "Note must be under 500 characters").optional(),
});

type MarkNoShowValues = z.infer<typeof markNoShowSchema>;

type MarkNoShowDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  meetingId: Id<"meetings">;
  mode?: "closer" | "admin";
  onSuccess?: () => Promise<void>;
  /** Named in the dialog so the closer knows whose call this records. */
  leadName?: string | null;
  /**
   * Opened from a suggested no-show: the reason starts as the one heard, and
   * a certain no-show opens as the one-step form (reason and Save).
   */
  suggestion?: DialogSuggestion;
};

type ReasonPrefill = { key: string; reason: MarkNoShowValues["reason"] };

/**
 * The person missed the call: the server closes the deal as lost, then marks
 * the call no-show with the reason (`closer.noShowActions.markNoShow`, or
 * `admin.meetingActions.adminMarkNoShow` for an admin).
 */
export function MarkNoShowDialog({
  open,
  onOpenChange,
  meetingId,
  mode = "closer",
  onSuccess,
  leadName,
  suggestion,
}: MarkNoShowDialogProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const reading = useSuggestionRef(suggestion);
  const fromCall = suggestion !== undefined;
  const compact = fromCall && suggestion.opened.compact === true;
  const applied = reading.applied;
  const prefill: ReasonPrefill | null =
    applied?.values.noShowReason !== undefined
      ? { key: `${applied.from.revision}:${applied.values.noShowReason}`, reason: applied.values.noShowReason }
      : null;
  const refFor = (reason: MarkNoShowValues["reason"]) =>
    reading.prefill
      ? reading.ref(
          changedFields({ noShowReason: reading.prefill.values.noShowReason }, { noShowReason: reason }),
        )
      : undefined;

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        // Esc mid-submit would drop the form under the running mutation.
        if (!isSubmitting) onOpenChange(value);
      }}
    >
      <DialogContent
        className={cn(ACTION_DIALOG, fromCall && "ph-no-capture")}
        showCloseButton={!isSubmitting}
      >
        <ActionDialogHeader
          title={withFromCall(
            leadName ? (
              <>
                Mark <span translate="no">{leadName}</span>&rsquo;s call as a no-show?
              </>
            ) : (
              "Mark the call as a no-show?"
            ),
            fromCall,
          )}
          description={
            compact
              ? "The deal closes as lost. You can send a reschedule link after."
              : mode === "admin"
                ? "You can send a reschedule link from this page after."
                : "You can send a reschedule link after."
          }
          tone={compact ? "danger" : "muted"}
        />
        {reading.changed ? (
          <ReadingChangedNotice
            onUseNew={reading.applyNew}
            onKeep={reading.keepMine}
            disabled={isSubmitting}
          />
        ) : null}
        {/* Inside the content, so the form starts empty each time the dialog opens. */}
        <NoShowForm
          meetingId={meetingId}
          mode={mode}
          onSuccess={onSuccess}
          onOpenChange={onOpenChange}
          isSubmitting={isSubmitting}
          setIsSubmitting={setIsSubmitting}
          prefill={prefill}
          compact={compact}
          refFor={fromCall ? refFor : undefined}
        />
      </DialogContent>
    </Dialog>
  );
}

function NoShowForm({
  meetingId,
  mode,
  onSuccess,
  onOpenChange,
  isSubmitting,
  setIsSubmitting,
  prefill,
  compact,
  refFor,
}: {
  meetingId: Id<"meetings">;
  mode: "closer" | "admin";
  onSuccess?: () => Promise<void>;
  onOpenChange: (open: boolean) => void;
  isSubmitting: boolean;
  setIsSubmitting: (submitting: boolean) => void;
  /** A suggested reason, taken again when its key changes. The note always starts empty. */
  prefill: ReasonPrefill | null;
  /** The one-step form: reason and Save, with the note behind "Add a note". */
  compact: boolean;
  /** Builds the save's `fromSuggestion` when the dialog opened from a suggestion. */
  refFor?: (reason: MarkNoShowValues["reason"]) => FromSuggestion | undefined;
}) {
  const ids = useId();
  const [noteOpen, setNoteOpen] = useState(false);
  const closerMarkNoShow = useMutation(api.closer.noShowActions.markNoShow);
  const adminMarkNoShow = useMutation(api.admin.meetingActions.adminMarkNoShow);

  // Do NOT pass an explicit generic to useForm — let the resolver infer types
  const form = useForm({
    resolver: standardSchemaResolver(markNoShowSchema),
    defaultValues: {
      reason: prefill?.reason as MarkNoShowValues["reason"] | undefined,
      note: "",
    },
  });
  const appliedKey = useRef(prefill?.key ?? null);
  useEffect(() => {
    if (!prefill || prefill.key === appliedKey.current) return;
    appliedKey.current = prefill.key;
    form.setValue("reason", prefill.reason);
    form.clearErrors("reason");
  }, [prefill, form]);

  const handleSubmit = async (values: MarkNoShowValues) => {
    setIsSubmitting(true);
    try {
      const markNoShow =
        mode === "admin" ? adminMarkNoShow : closerMarkNoShow;
      const fromSuggestion = refFor?.(values.reason);
      await markNoShow({
        meetingId,
        reason: values.reason,
        note: values.note || undefined, // Convert empty string to undefined
        ...(fromSuggestion ? { fromSuggestion } : {}),
      });

      posthog.capture("meeting_marked_no_show", {
        meeting_id: meetingId,
        reason: values.reason,
        source: mode,
        ...(fromSuggestion ? { from_suggestion: true } : {}),
      });

      toast.success("No-show recorded. The deal is closed as lost.");
      await onSuccess?.();
      onOpenChange(false);
    } catch (error) {
      toast.error(
        getErrorMessage(error, "Failed to mark no-show"),
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={form.handleSubmit(handleSubmit)} className={ACTION_FORM}>
      {compact ? null : (
        <WhatHappens steps={["Closes the deal as lost.", "Marks the call no-show, with your reason and note."]} />
      )}
      <FormRows>
        <Controller
          control={form.control}
          name="reason"
          render={({ field, fieldState }) => (
            <FormRow label="Reason" htmlFor={`${ids}-reason`} invalid={fieldState.invalid} error={fieldState.error}>
              <Select onValueChange={field.onChange} value={field.value ?? ""} disabled={isSubmitting}>
                <SelectTrigger
                  id={`${ids}-reason`}
                  ref={field.ref}
                  onBlur={field.onBlur}
                  aria-invalid={fieldState.invalid}
                  className="w-full"
                >
                  <SelectValue placeholder="Pick a reason" />
                </SelectTrigger>
                <SelectContent>
                  {NO_SHOW_REASONS.map((r) => (
                    <SelectItem key={r.value} value={r.value}>
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormRow>
          )}
        />
        {compact && !noteOpen ? (
          <div className="px-4 py-2">
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto px-0"
              onClick={() => setNoteOpen(true)}
              disabled={isSubmitting}
            >
              Add a note
            </Button>
          </div>
        ) : (
        <Controller
          control={form.control}
          name="note"
          render={({ field, fieldState }) => (
            <FormRow
              label="Note"
              htmlFor={`${ids}-note`}
              invalid={fieldState.invalid}
              error={fieldState.error}
              description="Lead generators who first captured this person can read this note."
            >
              <Textarea
                {...field}
                id={`${ids}-note`}
                aria-invalid={fieldState.invalid}
                placeholder="Any additional context…"
                className="max-h-48 min-h-20 resize-none text-sm"
                disabled={isSubmitting}
              />
            </FormRow>
          )}
        />
        )}
      </FormRows>
      <ActionDialogFooter>
        <CancelButton onClick={() => onOpenChange(false)} disabled={isSubmitting} />
        <SubmitButton pending={isSubmitting} pendingLabel={compact ? "Saving…" : "Marking…"} danger>
          {compact ? "Save" : "Mark no-show"}
        </SubmitButton>
      </ActionDialogFooter>
    </form>
  );
}
