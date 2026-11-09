"use client";

import { useId, useState } from "react";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { useMutation } from "convex/react";
import { BanknoteIcon } from "lucide-react";
import posthog from "@/lib/posthog-browser";
import { reportClientError } from "@/lib/observability/report-client-error";
import { Controller, FormProvider, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { getErrorMessage } from "@/lib/errors";
import {
  ACTION_DIALOG,
  ActionDialogHeader,
  FormRow,
  RecordFact,
} from "@/app/workspace/_components/action-dialog";
import {
  CURRENCIES,
  MAX_PROOF_FILE_SIZE,
  PAYMENT_TYPES,
  PROOF_FILE_TYPES,
  PaymentConfirmStep,
  PaymentFormStep,
  formatPaymentAmount,
  useConfirmStep,
} from "@/app/workspace/_components/payment-dialog-form";
import { PROOF_REQUIRED_MESSAGE } from "@/lib/paymentProof";
import { useProofRequired } from "@/hooks/use-proof-required";

function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

const paymentSchema = z.object({
  amount: z
    .string()
    .min(1, "Amount is required")
    .refine((value) => {
      const amount = Number(value);
      return Number.isFinite(amount) && amount > 0;
    }, "Amount must be greater than 0"),
  currency: z.enum(CURRENCIES),
  paymentType: z.enum(PAYMENT_TYPES, {
    error: "Please select a payment type",
  }),
  proofFile: z
    .instanceof(File)
    .optional()
    .refine(
      (file) => !file || file.size <= MAX_PROOF_FILE_SIZE,
      "File size must be less than 10 MB",
    )
    .refine(
      (file) => !file || PROOF_FILE_TYPES.includes(file.type),
      "Only images (JPEG, PNG, GIF) and PDFs are allowed",
    ),
  fathomLink: z
    .string()
    .optional()
    .refine(
      (value) => !value || value.trim().length === 0 || isValidHttpUrl(value.trim()),
      "Enter a valid http(s) URL",
    ),
  note: z
    .string()
    .trim()
    .max(500, "Note must be 500 characters or fewer")
    .optional(),
});

type PaymentValues = z.infer<typeof paymentSchema>;

/**
 * Another payment on a won deal, from the deal modal. The program is the
 * deal's (read-only). The form validates, then a confirm step records it
 * with `recordAdditionalPayment`.
 */
export function AddOpportunityPaymentDialog({
  opportunityId,
  programName,
  leadName,
  variant = "outline",
}: {
  opportunityId: Id<"opportunities">;
  /** Outline by default: a won deal has no next action to mark in lime. */
  variant?: "default" | "outline";
  /**
   * The program the payment inherits (read-only): the sold program, or the
   * earliest payment's on a deal won without one.
   */
  programName: string | null;
  /** Named in the title so the payment lands on the right person's deal. */
  leadName?: string | null;
}) {
  const ids = useId();
  const [open, setOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Closers must attach proof; the payment mutations refuse a payment without it.
  const proofRequired = useProofRequired();
  const [confirming, setConfirming] = useConfirmStep<PaymentValues>(open);
  const generateUploadUrl = useMutation(api.closer.payments.generateUploadUrl);
  const recordAdditionalPayment = useMutation(
    api.closer.additionalPayment.recordAdditionalPayment,
  );

  const form = useForm({
    resolver: standardSchemaResolver(paymentSchema),
    defaultValues: {
      amount: "",
      currency: "USD",
      paymentType: undefined,
      proofFile: undefined,
      fathomLink: "",
      note: "",
    },
  });

  const onSubmit = async (values: PaymentValues) => {
    let uploadHttpStatus: number | undefined;
    setIsSubmitting(true);
    setSubmitError(null);

    try {
      let proofFileId: Id<"_storage"> | undefined;
      if (values.proofFile) {
        const uploadUrl = await generateUploadUrl();
        const uploadResponse = await fetch(uploadUrl, {
          method: "POST",
          headers: { "Content-Type": values.proofFile.type },
          body: values.proofFile,
        });

        if (!uploadResponse.ok) {
          uploadHttpStatus = uploadResponse.status;
          throw new Error("Failed to upload proof file.");
        }

        const uploadData = (await uploadResponse.json()) as {
          storageId?: string;
        };
        if (!uploadData.storageId) {
          throw new Error("File upload returned invalid storage ID.");
        }
        proofFileId = uploadData.storageId as Id<"_storage">;
      }

      const trimmedFathomLink = values.fathomLink?.trim();
      const trimmedNote = values.note?.trim();

      const result = await recordAdditionalPayment({
        opportunityId,
        amount: Number(values.amount),
        currency: values.currency,
        paymentType: values.paymentType,
        proofFileId,
        fathomLink: trimmedFathomLink || undefined,
        note: trimmedNote || undefined,
      });

      posthog.capture("additional_payment_recorded", {
        opportunity_id: opportunityId,
        payment_id: result.paymentId,
        has_proof_file: Boolean(proofFileId),
        has_fathom_link: Boolean(trimmedFathomLink),
      });
      toast.success("Payment recorded");
      form.reset();
      setOpen(false);
    } catch (error) {
      reportClientError(error, { flow: "additional_payment_record", httpStatus: uploadHttpStatus });
      const message =
        getErrorMessage(error, "Failed to record payment");
      setSubmitError(message);
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const amountLabel = confirming ? formatPaymentAmount(confirming.amount, confirming.currency) : "";
  const fathomLink = confirming?.fathomLink?.trim();
  const note = confirming?.note?.trim();

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
        <Button size="sm" variant={variant}>
          <BanknoteIcon aria-hidden="true" data-icon="inline-start" />
          Add payment
        </Button>
      </DialogTrigger>
      {open ? (
        <DialogContent className={ACTION_DIALOG} showCloseButton={!isSubmitting}>
          {confirming ? (
            <>
              <ActionDialogHeader
                title={leadName ? `Add ${amountLabel} to ${leadName}’s deal?` : `Add a ${amountLabel} payment to this deal?`}
                description="Check the payment before you record it."
              />
              <PaymentConfirmStep
                amount={confirming.amount}
                currency={confirming.currency}
                programName={programName}
                paymentType={confirming.paymentType}
                proofFile={confirming.proofFile}
                extraFacts={
                  <>
                    {fathomLink ? (
                      <RecordFact label="Fathom link">
                        <span className="break-all">{fathomLink}</span>
                      </RecordFact>
                    ) : null}
                    {note ? <RecordFact label="Note">{note}</RecordFact> : null}
                  </>
                }
                steps={[
                  "Adds the payment to Billing’s Needs review, credited to the deal’s closer.",
                  "Adds it to the deal’s paid total and revenue reports. The deal stays won.",
                ]}
                submitError={submitError}
                pending={isSubmitting}
                onBack={() => {
                  setSubmitError(null);
                  setConfirming(null);
                }}
                onConfirm={() => void onSubmit(confirming)}
              />
            </>
          ) : (
            <>
              <ActionDialogHeader
                title={leadName ? `Add a payment to ${leadName}’s deal` : "Add a payment"}
                description="Another payment on this won deal. It’s credited to the deal’s closer and counts in revenue reports."
              />
              <FormProvider {...form}>
                <PaymentFormStep
                  onSubmit={form.handleSubmit((values) => {
                    if (proofRequired && !values.proofFile) {
                      form.setError("proofFile", { message: PROOF_REQUIRED_MESSAGE });
                      return;
                    }
                    setSubmitError(null);
                    setConfirming(values);
                  })}
                  onCancel={() => {
                    setOpen(false);
                    form.reset();
                    setSubmitError(null);
                  }}
                  program={{
                    kind: "fixed",
                    name: programName,
                    description: "A payment takes the program the deal was won under.",
                  }}
                  proofRequired={proofRequired}
                >
                  <Controller
                    control={form.control}
                    name="fathomLink"
                    render={({ field, fieldState }) => (
                      <FormRow
                        label="Fathom link"
                        htmlFor={`${ids}-fathom`}
                        invalid={fieldState.invalid}
                        error={fieldState.error}
                        description="Optional. The call recording, as evidence."
                      >
                        <Input
                          {...field}
                          id={`${ids}-fathom`}
                          type="url"
                          inputMode="url"
                          placeholder="https://fathom.video/call/…"
                          autoComplete="off"
                          spellCheck={false}
                          aria-invalid={fieldState.invalid}
                        />
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
                        description="Optional. Up to 500 characters."
                      >
                        <Textarea
                          {...field}
                          id={`${ids}-note`}
                          rows={2}
                          placeholder="Context for this payment"
                          aria-invalid={fieldState.invalid}
                        />
                      </FormRow>
                    )}
                  />
                </PaymentFormStep>
              </FormProvider>
            </>
          )}
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
