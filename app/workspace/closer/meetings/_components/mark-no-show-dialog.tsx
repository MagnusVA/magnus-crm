"use client";

import { useId, useState } from "react";
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
};

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
}: MarkNoShowDialogProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        // Esc mid-submit would drop the form under the running mutation.
        if (!isSubmitting) onOpenChange(value);
      }}
    >
      <DialogContent className={ACTION_DIALOG} showCloseButton={!isSubmitting}>
        <ActionDialogHeader
          title={
            leadName ? (
              <>
                Mark <span translate="no">{leadName}</span>&rsquo;s call as a no-show?
              </>
            ) : (
              "Mark the call as a no-show?"
            )
          }
          description={
            mode === "admin"
              ? "You can send a reschedule link from this page after."
              : "You can send a reschedule link after."
          }
        />
        {/* Inside the content, so the form starts empty each time the dialog opens. */}
        <NoShowForm
          meetingId={meetingId}
          mode={mode}
          onSuccess={onSuccess}
          onOpenChange={onOpenChange}
          isSubmitting={isSubmitting}
          setIsSubmitting={setIsSubmitting}
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
}: {
  meetingId: Id<"meetings">;
  mode: "closer" | "admin";
  onSuccess?: () => Promise<void>;
  onOpenChange: (open: boolean) => void;
  isSubmitting: boolean;
  setIsSubmitting: (submitting: boolean) => void;
}) {
  const ids = useId();
  const closerMarkNoShow = useMutation(api.closer.noShowActions.markNoShow);
  const adminMarkNoShow = useMutation(api.admin.meetingActions.adminMarkNoShow);

  // Do NOT pass an explicit generic to useForm — let the resolver infer types
  const form = useForm({
    resolver: standardSchemaResolver(markNoShowSchema),
    defaultValues: {
      reason: undefined as MarkNoShowValues["reason"] | undefined,
      note: "",
    },
  });

  const handleSubmit = async (values: MarkNoShowValues) => {
    setIsSubmitting(true);
    try {
      const markNoShow =
        mode === "admin" ? adminMarkNoShow : closerMarkNoShow;
      await markNoShow({
        meetingId,
        reason: values.reason,
        note: values.note || undefined, // Convert empty string to undefined
      });

      posthog.capture("meeting_marked_no_show", {
        meeting_id: meetingId,
        reason: values.reason,
        source: mode,
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
      <WhatHappens steps={["Closes the deal as lost.", "Marks the call no-show, with your reason and note."]} />
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
      </FormRows>
      <ActionDialogFooter>
        <CancelButton onClick={() => onOpenChange(false)} disabled={isSubmitting} />
        <SubmitButton pending={isSubmitting} pendingLabel="Marking…" danger>
          Mark no-show
        </SubmitButton>
      </ActionDialogFooter>
    </form>
  );
}
