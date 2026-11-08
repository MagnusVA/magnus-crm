"use client";

import { useState } from "react";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { useMutation, useQuery } from "convex/react";
import { BanknoteIcon } from "lucide-react";
import posthog from "@/lib/posthog-browser";
import { reportClientError } from "@/lib/observability/report-client-error";
import { FormProvider, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
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

const paymentSchema = z.object({
  amount: z
    .string()
    .min(1, "Amount is required")
    .refine((value) => {
      const amount = Number(value);
      return Number.isFinite(amount) && amount > 0;
    }, "Amount must be greater than 0"),
  currency: z.enum(CURRENCIES),
  programId: z.string().min(1, "Please select a program"),
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
});

type PaymentValues = z.infer<typeof paymentSchema>;

/**
 * The side deal's payment, from the deal modal. The form validates, then a
 * confirm step records it with `sideDeals.logPayment`, which closes the side
 * deal as won.
 */
export function SideDealPaymentDialog({
  opportunityId,
  leadName,
  variant = "default",
}: {
  opportunityId: Id<"opportunities">;
  /** Named in the title so the payment lands on the right person's deal. */
  leadName?: string | null;
  /**
   * Lime ("default") when recording the payment is the deal's one next
   * action; "outline" when another lime button sits beside it.
   */
  variant?: "default" | "outline";
}) {
  const [open, setOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [confirming, setConfirming] = useConfirmStep<PaymentValues>(open);
  const generateUploadUrl = useMutation(api.closer.payments.generateUploadUrl);
  const logPayment = useMutation(api.sideDeals.logPayment.logPayment);
  // The confirm step names the chosen program; ProgramSelect reads the same list.
  const programs = useQuery(
    api.tenantPrograms.queries.listPrograms,
    open ? { includeArchived: false } : "skip",
  );

  const form = useForm({
    resolver: standardSchemaResolver(paymentSchema),
    defaultValues: {
      amount: "",
      currency: "USD",
      programId: "",
      paymentType: undefined,
      proofFile: undefined,
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

      const result = await logPayment({
        opportunityId,
        amount: Number(values.amount),
        currency: values.currency,
        programId: values.programId as Id<"tenantPrograms">,
        paymentType: values.paymentType,
        proofFileId,
      });

      posthog.capture("side_deal_payment_logged", {
        opportunity_id: opportunityId,
        payment_id: result.paymentId,
        has_proof_file: Boolean(proofFileId),
      });
      toast.success("Payment recorded");
      form.reset();
      setOpen(false);
    } catch (error) {
      reportClientError(error, { flow: "side_deal_payment_log", httpStatus: uploadHttpStatus });
      const message =
        getErrorMessage(error, "Failed to record payment");
      setSubmitError(message);
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const firstName = leadName?.trim().split(/\s+/)[0] || "the lead";
  const programName = confirming
    ? (programs?.find((program) => program._id === confirming.programId)?.name ?? null)
    : null;
  const amountLabel = confirming ? formatPaymentAmount(confirming.amount, confirming.currency) : "";

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
          Record payment
        </Button>
      </DialogTrigger>
      {open ? (
        <DialogContent className={ACTION_DIALOG} showCloseButton={!isSubmitting}>
          {confirming ? (
            <>
              <ActionDialogHeader
                title={
                  leadName
                    ? `Record ${amountLabel} on ${leadName}’s side deal?`
                    : `Record ${amountLabel} on this side deal?`
                }
                description="Check the payment before you record it."
              />
              <PaymentConfirmStep
                amount={confirming.amount}
                currency={confirming.currency}
                programName={programName}
                paymentType={confirming.paymentType}
                proofFile={confirming.proofFile}
                steps={[
                  "Adds the payment to Billing’s Needs review, credited to the deal’s closer.",
                  "Closes the side deal as won.",
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
                title={leadName ? `Record the payment for ${leadName}’s side deal` : "Record the side-deal payment"}
                description="The payment is logged and the side deal closes as won."
              />
              <FormProvider {...form}>
                <PaymentFormStep
                  onSubmit={form.handleSubmit((values) => {
                    setSubmitError(null);
                    setConfirming(values);
                  })}
                  onCancel={() => {
                    setOpen(false);
                    form.reset();
                    setSubmitError(null);
                  }}
                  program={{ kind: "choose", description: "The program this payment is for." }}
                />
              </FormProvider>
            </>
          )}
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
