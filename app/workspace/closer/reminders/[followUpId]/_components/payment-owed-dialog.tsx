"use client";

import { useId, useState } from "react";
import { useMutation } from "convex/react";
import { Controller, useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { format } from "date-fns";
import { z } from "zod";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { toAmountMinor } from "@/convex/lib/formatMoney";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
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
import { DayDefinition } from "@/app/workspace/_components/day-definition";
import { NoteRow, ReachByRow, WhenRow } from "@/app/workspace/_components/follow-up-dialog-parts";
import { businessDayRange, type BusinessDaySetting } from "@/lib/businessDay";
import posthog from "@/lib/posthog-browser";
import { reportClientError } from "@/lib/observability/report-client-error";
import { getErrorMessage } from "@/lib/errors";

const paymentOwedSchema = z
  .object({
    contactMethod: z.enum(["call", "text"], { error: "Pick call or text" }),
    date: z.string().min(1, "Date is required"),
    time: z.string().min(1, "Time is required"),
    amount: z.string().trim(),
    currency: z.string().trim(),
    promisedBy: z.union([z.literal(""), z.iso.date()], { error: "Pick a valid date" }),
    note: z.string().max(500, "Keep it under 500 characters").optional(),
  })
  .superRefine((values, ctx) => {
    if (values.amount) {
      const minor = Math.round(Number(values.amount) * 100);
      if (!/^\d*(?:\.\d{0,2})?$/.test(values.amount) || !Number.isSafeInteger(minor) || minor <= 0) {
        ctx.addIssue({ code: "custom", path: ["amount"], message: "Enter a positive amount with up to 2 decimal places" });
      }
      if (!values.currency) {
        ctx.addIssue({ code: "custom", path: ["currency"], message: "Enter a currency for this amount" });
      }
    }
    if (values.currency) {
      if (!/^[A-Za-z]{3}$/.test(values.currency)) {
        ctx.addIssue({ code: "custom", path: ["currency"], message: "Enter a 3-letter currency code" });
      }
      if (!values.amount) {
        ctx.addIssue({ code: "custom", path: ["amount"], message: "Enter an amount for this currency" });
      }
    }
    if (!values.date || !values.time) return;
    const scheduled = new Date(`${values.date}T${values.time}`).getTime();
    if (Number.isNaN(scheduled) || scheduled <= Date.now()) {
      ctx.addIssue({ code: "custom", path: ["time"], message: "Pick a time in the future" });
    }
  });
type PaymentOwedFormValues = z.infer<typeof paymentOwedSchema>;

/** Tomorrow at 10:00 by call, in the browser's time zone. */
function defaults(): PaymentOwedFormValues {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return {
    contactMethod: "call", date: format(tomorrow, "yyyy-MM-dd"), time: "10:00",
    amount: "", currency: "", promisedBy: "", note: "",
  };
}

type PaymentOwedDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  opportunityId: Id<"opportunities">;
  /** The call, while it still has no result: saving marks it held. */
  meetingId?: Id<"meetings">;
  personName: string | null;
  setting: BusinessDaySetting;
};

/**
 * After the closer answers "Not paid yet" to a paid-on-call alert: an offer
 * to set a reminder to check on the payment, through the same manual
 * reminder the meeting page's follow-up dialog creates. Nothing is created
 * unless the closer saves; closing the dialog skips it.
 */
export function PaymentOwedDialog({
  open,
  onOpenChange,
  opportunityId,
  meetingId,
  personName,
  setting,
}: PaymentOwedDialogProps) {
  const ids = useId();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const createReminder = useMutation(api.closer.followUpMutations.createManualReminderFollowUpPublic);

  const form = useForm({
    resolver: standardSchemaResolver(paymentOwedSchema),
    defaultValues: defaults(),
  });
  const reset = () => {
    form.reset(defaults());
    setSubmitError(null);
  };

  const onSubmit = async (values: PaymentOwedFormValues) => {
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const reminderNote = values.note?.trim() || undefined;
      await createReminder({
        opportunityId,
        meetingId,
        contactMethod: values.contactMethod,
        reminderScheduledAt: new Date(`${values.date}T${values.time}`).getTime(),
        reminderNote,
        paymentOwed: {
          expectedAmountMinor: values.amount ? toAmountMinor(Number(values.amount)) : undefined,
          expectedCurrency: values.currency || undefined,
          promisedPaymentAt: values.promisedBy ? businessDayRange(values.promisedBy, setting).end - 1 : undefined,
        },
      });
      posthog.capture("follow_up_reminder_created", {
        opportunity_id: opportunityId,
        meeting_id: meetingId ?? null,
        contact_method: values.contactMethod,
        from_paid_on_call_alert: true,
      });
      toast.success("Reminder set");
      onOpenChange(false);
      reset();
    } catch (err) {
      reportClientError(err, { flow: "payment_owed_reminder" });
      setSubmitError(getErrorMessage(err, "The reminder wasn't set. Please try again."));
    } finally {
      setIsSubmitting(false);
    }
  };

  const possessive = personName ? `${personName}’s` : "the";
  const moves = meetingId
    ? `Saving marks the call held and moves ${possessive} deal to Follow-up. Nothing is set unless you save.`
    : `Saving moves ${possessive} deal to Follow-up. Nothing is set unless you save.`;
  const { errors } = form.formState;

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (isSubmitting) return; // don't dismiss mid-submit
        onOpenChange(value);
        if (!value) reset();
      }}
    >
      <DialogContent className={ACTION_DIALOG} showCloseButton={!isSubmitting}>
        <ActionDialogHeader title="Set payment-owed reminder" description={moves} />

        <form onSubmit={form.handleSubmit(onSubmit)} className={ACTION_FORM} noValidate>
          <SubmitError>{submitError}</SubmitError>
          <FormRows>
            <Controller
              control={form.control}
              name="contactMethod"
              render={({ field, fieldState }) => (
                <ReachByRow
                  value={field.value}
                  onChange={field.onChange}
                  disabled={isSubmitting}
                  error={fieldState.error}
                />
              )}
            />
            <WhenRow
              date={form.register("date")}
              time={form.register("time")}
              min={format(new Date(), "yyyy-MM-dd")}
              disabled={isSubmitting}
              dateError={errors.date}
              timeError={errors.time}
            />
            <Controller
              control={form.control}
              name="amount"
              render={({ field, fieldState: { error } }) => (
                <FormRow label="Amount (optional)" htmlFor={`${ids}-amount`} invalid={Boolean(error)} error={error}>
                  <Input
                    id={`${ids}-amount`}
                    inputMode="decimal"
                    aria-invalid={Boolean(error) || undefined}
                    disabled={isSubmitting}
                    className="font-condensed text-[15px] tabular-nums"
                    {...field}
                  />
                </FormRow>
              )}
            />
            <Controller
              control={form.control}
              name="currency"
              render={({ field, fieldState: { error } }) => (
                <FormRow label="Currency (optional)" htmlFor={`${ids}-currency`} invalid={Boolean(error)} error={error}>
                  <Input
                    id={`${ids}-currency`}
                    placeholder="USD"
                    autoCapitalize="characters"
                    spellCheck={false}
                    aria-invalid={Boolean(error) || undefined}
                    disabled={isSubmitting}
                    {...field}
                  />
                </FormRow>
              )}
            />
            <Controller
              control={form.control}
              name="promisedBy"
              render={({ field, fieldState: { error } }) => (
                <FormRow label="Promised by (optional)" htmlFor={`${ids}-promised-by`} invalid={Boolean(error)} error={error}>
                  <Input
                    id={`${ids}-promised-by`}
                    type="date"
                    aria-invalid={Boolean(error) || undefined}
                    disabled={isSubmitting}
                    className="font-condensed text-[15px] tabular-nums"
                    {...field}
                  />
                  <DayDefinition />
                </FormRow>
              )}
            />
            <NoteRow
              label="Note (optional)"
              placeholder="e.g., They want to pay by bank transfer"
              disabled={isSubmitting}
              error={errors.note}
              field={form.register("note")}
            />
          </FormRows>

          <ActionDialogFooter>
            <CancelButton
              disabled={isSubmitting}
              onClick={() => {
                onOpenChange(false);
                reset();
              }}
            >
              Skip
            </CancelButton>
            <SubmitButton pending={isSubmitting} pendingLabel="Setting…">
              Set payment-owed reminder
            </SubmitButton>
          </ActionDialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
