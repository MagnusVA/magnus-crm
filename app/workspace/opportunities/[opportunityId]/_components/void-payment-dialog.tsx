"use client";

import { useId, useState } from "react";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { useMutation } from "convex/react";
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
import { formatCash } from "@/lib/closer-pipeline";
import { getErrorMessage } from "@/lib/errors";
import {
  ACTION_DIALOG,
  ACTION_FORM,
  ActionDialogFooter,
  ActionDialogHeader,
  CancelButton,
  FormRow,
  FormRows,
  RecordFact,
  RecordFacts,
  SubmitButton,
  SubmitError,
  WhatHappens,
} from "@/app/workspace/_components/action-dialog";
import { PAYMENT_TYPE_LABELS } from "@/app/workspace/_components/payment-dialog-form";
import type { DealPayment } from "./opportunity-payments-list";

const voidPaymentSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, "Reason is required")
    .max(500, "Reason must be under 500 characters"),
});

type VoidPaymentValues = z.infer<typeof voidPaymentSchema>;

/** What Void does, in the order the server does it. */
const STEPS = [
  "Marks the payment disputed, so it leaves revenue reports and the deal’s paid total.",
  "Closes the side deal as lost, with your reason.",
  "Removes the enrollment it held. A person left with no payment is no longer a customer.",
];

/**
 * An admin voids a side deal's payment from its row in the deal modal: the
 * payment named in the title, what voiding does, a reason, then the danger
 * button (`sideDeals.voidPayment`).
 */
export function VoidPaymentDialog({
  paymentId,
  payment,
  dateLabel,
}: {
  paymentId: Id<"paymentRecords">;
  /** The payment's facts, so the dialog names what it voids. */
  payment?: Pick<DealPayment, "amountMinor" | "currency" | "programName" | "paymentType">;
  /** The day it was recorded, as the row shows it ("Nov 3"). */
  dateLabel?: string;
}) {
  const ids = useId();
  const [open, setOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const voidPayment = useMutation(api.sideDeals.voidPayment.voidPayment);

  const form = useForm({
    resolver: standardSchemaResolver(voidPaymentSchema),
    defaultValues: { reason: "" },
  });

  const onSubmit = async (values: VoidPaymentValues) => {
    setIsSubmitting(true);
    setSubmitError(null);

    try {
      await voidPayment({ paymentId, reason: values.reason.trim() });
      posthog.capture("side_deal_payment_voided", {
        payment_id: paymentId,
      });
      toast.success("Payment voided");
      form.reset();
      setOpen(false);
    } catch (error) {
      reportClientError(error, { flow: "payment_void" });
      const message =
        getErrorMessage(error, "Couldn't void the payment");
      setSubmitError(message);
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const amount = payment ? formatCash(payment.amountMinor, payment.currency) : null;
  const title = amount
    ? dateLabel
      ? `Void the ${amount} payment from ${dateLabel}?`
      : `Void the ${amount} payment?`
    : "Void this side-deal payment?";

  return (
    <Dialog
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
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          className="text-danger-ink hover:text-danger-ink"
          aria-label="Void this payment"
        >
          Void
        </Button>
      </DialogTrigger>
      <DialogContent className={ACTION_DIALOG} showCloseButton={!isSubmitting}>
        <ActionDialogHeader title={title} description="Voiding a side deal’s payment can’t be undone." tone="danger" />

        <form className={ACTION_FORM} onSubmit={form.handleSubmit(onSubmit)} noValidate>
          <SubmitError>{submitError}</SubmitError>
          {payment ? (
            <RecordFacts>
              <RecordFact label="Program">
                <span translate="no">{payment.programName}</span>
              </RecordFact>
              <RecordFact label="Payment type">{PAYMENT_TYPE_LABELS[payment.paymentType]}</RecordFact>
            </RecordFacts>
          ) : null}
          <WhatHappens steps={STEPS} />
          <FormRows>
            <Controller
              control={form.control}
              name="reason"
              render={({ field, fieldState }) => (
                <FormRow
                  label="Reason"
                  htmlFor={`${ids}-reason`}
                  invalid={fieldState.invalid}
                  error={fieldState.error}
                >
                  <Textarea
                    {...field}
                    id={`${ids}-reason`}
                    rows={3}
                    className="resize-none"
                    placeholder="Duplicate entry from yesterday…"
                    autoComplete="off"
                    aria-invalid={fieldState.invalid}
                    aria-required
                    disabled={isSubmitting}
                  />
                </FormRow>
              )}
            />
          </FormRows>

          <ActionDialogFooter>
            <CancelButton
              onClick={() => {
                setOpen(false);
                form.reset();
                setSubmitError(null);
              }}
              disabled={isSubmitting}
            />
            <SubmitButton pending={isSubmitting} pendingLabel="Voiding…" danger>
              Void payment
            </SubmitButton>
          </ActionDialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
