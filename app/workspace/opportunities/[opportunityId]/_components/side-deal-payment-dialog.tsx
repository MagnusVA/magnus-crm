"use client";

import { useState } from "react";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { useMutation, useQuery } from "convex/react";
import { BanknoteIcon } from "lucide-react";
import posthog from "@/lib/posthog-browser";
import { reportClientError } from "@/lib/observability/report-client-error";
import { FormProvider, useForm, useWatch } from "react-hook-form";
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
import { PROOF_REQUIRED_MESSAGE } from "@/lib/paymentProof";
import { useProofRequired } from "@/hooks/use-proof-required";
import { formatAmountMinor } from "@/lib/format-currency";
import {
  useWhopPaymentCheck,
  useWhopStepState,
  whopAmountOffer,
  whopConfirmLine,
  whopSuccessMessage,
  type WhopAnswer,
} from "@/app/workspace/_components/payments/whop-payment-check";
import {
  WhopAmountOffer,
  WhopAnswerFact,
  WhopCapacityHold,
  WhopPaymentFoundStep,
} from "@/app/workspace/_components/payments/whop-payment-found-step";

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
  // Closers must attach proof; the payment mutations refuse a payment without it.
  const proofRequired = useProofRequired();
  const [confirming, setConfirming] = useConfirmStep<PaymentValues>(open);
  // Whop already reporting this person's payment adds a step before the save.
  const whopCheck = useWhopPaymentCheck(open ? { kind: "deal", opportunityId } : null);
  const whop = useWhopStepState<PaymentValues>(open);
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

  const onSubmit = async (values: PaymentValues, answer: WhopAnswer | null = null) => {
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
        ...(answer ? { provider: answer.intent } : {}),
      });

      const attached = answer
        ? whopSuccessMessage(answer, { marksAttendance: false, proofAttached: Boolean(proofFileId) })
        : null;
      if (!attached) {
        posthog.capture("side_deal_payment_logged", {
          opportunity_id: opportunityId,
          payment_id: result.paymentId,
          has_proof_file: Boolean(proofFileId),
          ...(answer ? { whop_answer: answer.kind } : {}),
        });
      }
      toast.success(attached ?? "Payment recorded");
      whop.reset();
      form.reset();
      setOpen(false);
    } catch (error) {
      // Whop reports a payment the step must ask about, or the deal is full.
      if (whop.refused(error, values)) {
        setConfirming(null);
        return;
      }
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
  const typedAmount = useWatch({ control: form.control, name: "amount" });
  const proofFile = useWatch({ control: form.control, name: "proofFile" });
  const offer = whopAmountOffer(whopCheck);
  const offerCurrency = CURRENCIES.find((code) => code === offer?.currency);
  const showOffer = Boolean(offer && offerCurrency) && typedAmount === "" && !form.formState.isDirty;
  const whopValues = whop.shown?.values;
  const closeAndReset = () => {
    setOpen(false);
    form.reset();
    whop.reset();
    setSubmitError(null);
  };
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
            whop.reset();
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
          {whop.capacityHeld ? (
            <WhopCapacityHold onClose={closeAndReset} />
          ) : whop.shown && whopValues ? (
            <WhopPaymentFoundStep
              conflicts={whop.shown.conflicts}
              typed={{
                amountMinor: Math.round(Number(whopValues.amount) * 100),
                currency: whopValues.currency,
                paymentType: whopValues.paymentType,
                programName: programs?.find((program) => program._id === whopValues.programId)?.name ?? null,
              }}
              personName={leadName}
              proofRules={{ newMoney: proofRequired, roleNeedsProof: proofRequired }}
              proof={{ file: proofFile, onChange: (file) => form.setValue("proofFile", file) }}
              notice={whop.shown.notice}
              error={whop.shown.error ?? submitError}
              pending={isSubmitting}
              onBack={() => {
                setSubmitError(null);
                whop.back();
              }}
              onAnswer={(answer) => {
                setSubmitError(null);
                const values = { ...whopValues, proofFile: form.getValues("proofFile") };
                // Already recorded here: nothing new to confirm, the step saves.
                if (answer.kind === "same_money" && answer.existing) {
                  void onSubmit(values, answer);
                  return;
                }
                whop.choose(answer);
                setConfirming(values);
              }}
            />
          ) : confirming ? (
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
                extraFacts={<WhopAnswerFact answer={whop.answer} hasProofFile={Boolean(confirming.proofFile)} />}
                steps={[
                  "Adds the payment to Billing’s Needs review, credited to the deal’s closer.",
                  ...(whop.answer ? [whopConfirmLine(whop.answer)] : []),
                  "Closes the side deal as won.",
                  programName ? `Makes ${firstName} a customer of ${programName}.` : `Makes ${firstName} a customer.`,
                ]}
                submitError={submitError}
                pending={isSubmitting}
                onBack={() => {
                  setSubmitError(null);
                  whop.backFromConfirm(confirming);
                  setConfirming(null);
                }}
                onConfirm={() => void onSubmit(confirming, whop.answer)}
              />
            </>
          ) : (
            <>
              <ActionDialogHeader
                title={leadName ? `Record the payment for ${leadName}’s side deal` : "Record the side-deal payment"}
                description="The payment is logged and the side deal closes as won."
              />
              {showOffer && offer && offerCurrency ? (
                <WhopAmountOffer
                  amountLabel={formatAmountMinor(Math.round(offer.amount * 100), offerCurrency)}
                  onUse={() => {
                    form.setValue("amount", String(offer.amount));
                    form.setValue("currency", offerCurrency);
                    form.setFocus("amount");
                  }}
                />
              ) : null}
              <FormProvider {...form}>
                <PaymentFormStep
                  onSubmit={form.handleSubmit((values) => {
                    // The step asks for proof once it knows whether Whop's payment stands in for it.
                    if (whopCheck.status === "found") {
                      setSubmitError(null);
                      whop.show(values, whopCheck.conflicts);
                      return;
                    }
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
                  program={{ kind: "choose", description: "The program this payment is for." }}
                  proofRequired={proofRequired}
                />
              </FormProvider>
            </>
          )}
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
