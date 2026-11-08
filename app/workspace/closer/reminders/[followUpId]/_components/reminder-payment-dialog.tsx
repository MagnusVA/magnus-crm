"use client";

import { useEffect, useState } from "react";
import { FormProvider, useForm, useWatch } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { toast } from "sonner";
import posthog from "@/lib/posthog-browser";
import { reportClientError } from "@/lib/observability/report-client-error";
import { getErrorMessage } from "@/lib/errors";
import { ACTION_DIALOG, ActionDialogHeader } from "@/app/workspace/_components/action-dialog";
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

// ---------------------------------------------------------------------------
// Zod schema — single source of truth for form validation.
// ---------------------------------------------------------------------------

const paymentFormSchema = z.object({
  amount: z
    .string()
    .min(1, "Amount is required")
    .refine(
      (val) => {
        const num = parseFloat(val);
        return !Number.isNaN(num) && num > 0;
      },
      { message: "Amount must be greater than 0" },
    ),
  currency: z.enum(CURRENCIES),
  programId: z.string().min(1, "Please select a program"),
  paymentType: z.enum(PAYMENT_TYPES, {
    error: "Please select a payment type",
  }),
  proofFile: z
    .instanceof(File)
    .optional()
    .refine((file) => !file || file.size <= MAX_PROOF_FILE_SIZE, "File size must be less than 10 MB")
    .refine(
      (file) => !file || PROOF_FILE_TYPES.includes(file.type),
      "Only images (JPEG, PNG, GIF) and PDFs are allowed",
    ),
});

type PaymentFormValues = z.infer<typeof paymentFormSchema>;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type Props = {
  followUpId: Id<"followUps">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
  /** Named in the title so the closer knows whose deal closes. */
  leadName: string | null;
  /** The deal's booked program, preselected when it is an active program. */
  defaultProgramId: Id<"tenantPrograms"> | null;
  /** On the admin twin, the closer the payment is credited to. */
  actingFor?: string | null;
};

/**
 * Won · log payment, from a task. The meeting page's payment dialog, wired
 * to `logReminderPayment`: the backend finds the call from the task, closes
 * the deal as won and completes the task. An admin's payment is credited to
 * the task's closer. The form validates, then a confirm step records.
 */
export function ReminderPaymentDialog({
  followUpId,
  open,
  onOpenChange,
  onSuccess,
  leadName,
  defaultProgramId,
  actingFor,
}: Props) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [confirming, setConfirming] = useConfirmStep<PaymentFormValues>(open);

  const programs = useQuery(api.tenantPrograms.queries.listPrograms, {
    includeArchived: false,
  });

  // The booked program, only while it is an active program.
  const bookedProgram = defaultProgramId
    ? programs?.find((program) => program._id === defaultProgramId)
    : undefined;
  const bookedCurrency = CURRENCIES.find(
    (currency) => currency === bookedProgram?.defaultCurrency?.toUpperCase(),
  );

  const form = useForm({
    resolver: standardSchemaResolver(paymentFormSchema),
    defaultValues: {
      amount: "",
      currency: "USD",
      programId: "",
      paymentType: undefined,
      proofFile: undefined,
    },
  });

  const resetForm = () => {
    form.reset({
      amount: "",
      currency: bookedCurrency ?? "USD",
      programId: bookedProgram?._id ?? "",
      paymentType: undefined,
      proofFile: undefined,
    });
    setSubmitError(null);
  };

  // Programs load after the form, so the booked program fills in once they do.
  useEffect(() => {
    if (!bookedProgram || form.getValues("programId") !== "") return;
    form.setValue("programId", bookedProgram._id);
    if (bookedCurrency) form.setValue("currency", bookedCurrency);
  }, [bookedProgram, bookedCurrency, form]);

  const generateUploadUrl = useMutation(api.closer.payments.generateUploadUrl);
  const logReminderPayment = useMutation(api.closer.reminderOutcomes.logReminderPayment);

  const onSubmit = async (values: PaymentFormValues) => {
    let uploadHttpStatus: number | undefined;
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      if (!programs || programs.length === 0) {
        throw new Error("Create an active program before logging a payment.");
      }

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
          throw new Error("Failed to upload proof file");
        }
        const uploadData = (await uploadResponse.json()) as { storageId?: string };
        if (!uploadData.storageId) {
          throw new Error("File upload returned invalid storage ID");
        }
        proofFileId = uploadData.storageId as Id<"_storage">;
      }

      const parsedAmount = parseFloat(values.amount);
      const selectedProgram = programs.find((program) => program._id === values.programId);
      const paymentId = await logReminderPayment({
        followUpId,
        amount: parsedAmount,
        currency: values.currency,
        programId: values.programId as Id<"tenantPrograms">,
        paymentType: values.paymentType,
        proofFileId,
      });

      posthog.capture("reminder_outcome_payment", {
        follow_up_id: followUpId,
        payment_id: paymentId,
        amount_minor: Math.round(parsedAmount * 100),
        currency: values.currency,
        program_id: values.programId,
        program_name: selectedProgram?.name ?? null,
        payment_type: values.paymentType,
        has_proof: Boolean(proofFileId),
      });

      toast.success("Payment logged. The deal is won.");
      onOpenChange(false);
      resetForm();
      onSuccess();
    } catch (err: unknown) {
      reportClientError(err, { flow: "reminder_payment_log", httpStatus: uploadHttpStatus });
      const message = getErrorMessage(err, "Failed to log payment. Please try again.");
      setSubmitError(message);
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const isProgramListLoading = programs === undefined;
  const hasPrograms = (programs?.length ?? 0) > 0;
  const isSubmitDisabled = isSubmitting || isProgramListLoading || !hasPrograms;

  const chosenProgramId = useWatch({ control: form.control, name: "programId" });
  const firstName = leadName?.trim().split(/\s+/)[0] || "the lead";
  const programName = confirming
    ? (programs?.find((program) => program._id === confirming.programId)?.name ?? null)
    : null;
  const amountLabel = confirming ? formatPaymentAmount(confirming.amount, confirming.currency) : "";

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (isSubmitting) return;
        onOpenChange(value);
        if (!value) resetForm();
      }}
    >
      <DialogContent className={ACTION_DIALOG} showCloseButton={!isSubmitting}>
        {confirming ? (
          <>
            <ActionDialogHeader
              title={leadName ? `Record ${leadName}’s ${amountLabel} payment?` : `Record a ${amountLabel} payment?`}
              description="Check the payment before you record it."
            />
            <PaymentConfirmStep
              amount={confirming.amount}
              currency={confirming.currency}
              programName={programName}
              paymentType={confirming.paymentType}
              proofFile={confirming.proofFile}
              steps={[
                actingFor
                  ? `Adds the payment to Billing’s Needs review, credited to ${actingFor}.`
                  : "Adds the payment to Billing’s Needs review, credited to the task’s closer.",
                actingFor ? `Closes the deal as won, with ${actingFor} as its closer.` : "Closes the deal as won.",
                "Completes this task.",
                programName ? `Makes ${firstName} a customer of ${programName}.` : `Makes ${firstName} a customer.`,
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
              title={leadName ? `Record a payment for ${leadName}` : "Record a payment"}
              description={
                actingFor
                  ? `Recording it closes the deal as won, credits ${actingFor}, and closes this task.`
                  : "Recording it closes the deal as won and closes this task."
              }
            />
            <FormProvider {...form}>
              <PaymentFormStep
                onSubmit={form.handleSubmit((values) => {
                  setSubmitError(null);
                  setConfirming(values);
                })}
                onCancel={() => {
                  onOpenChange(false);
                  resetForm();
                }}
                program={{
                  kind: "choose",
                  disabled: isSubmitDisabled,
                  // With no programs, the select says why in place of a description.
                  description: !hasPrograms
                    ? undefined
                    : bookedProgram && chosenProgramId === bookedProgram._id
                      ? "The program this deal was booked for."
                      : "The program this payment is for.",
                }}
                submitDisabled={isSubmitDisabled}
              />
            </FormProvider>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
