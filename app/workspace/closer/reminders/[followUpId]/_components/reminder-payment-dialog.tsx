"use client";

import { useEffect, useRef, useState } from "react";
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
import type { PaymentLinkValues } from "@/lib/paymentLink";
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
import {
  WhopConfirmForm,
  type WhopConfirmChoice,
  type WhopConfirmPrefill,
} from "@/app/workspace/closer/meetings/_components/whop-payment-ask";

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
  /** Values from a payment link, filled in when the dialog opens. */
  prefill?: PaymentLinkValues;
  /**
   * Opened from a Whop payment waiting for confirmation: the form is filled
   * from Whop, has no proof field, and saves with the confirm intent.
   */
  whopConfirm?: WhopConfirmPrefill | null;
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
  prefill,
  whopConfirm,
}: Props) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Closers must attach proof; the payment mutations refuse a payment without it.
  const proofRequired = useProofRequired();
  const [confirming, setConfirming] = useConfirmStep<PaymentFormValues>(open);
  // Whop already reporting this person's payment adds a step before the save.
  const whopCheck = useWhopPaymentCheck(open && !whopConfirm ? { kind: "reminder", followUpId } : null);
  const whop = useWhopStepState<PaymentFormValues>(open);

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
    whop.reset();
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

  // A payment link's values (lib/paymentLink.ts) fill the form once each time
  // it opens, after the programs load, so a link's program can be checked.
  const prefilled = useRef(false);
  useEffect(() => {
    if (!open) {
      prefilled.current = false;
      return;
    }
    if (!prefill || prefilled.current || programs === undefined) return;
    prefilled.current = true;
    if (prefill.amount !== undefined) form.setValue("amount", String(prefill.amount));
    const currency = CURRENCIES.find((code) => code === prefill.currency);
    if (currency) form.setValue("currency", currency);
    if (prefill.paymentType) form.setValue("paymentType", prefill.paymentType);
    const program = programs.find((item) => item._id === prefill.programId);
    if (program) form.setValue("programId", program._id);
  }, [open, prefill, programs, form]);

  const generateUploadUrl = useMutation(api.closer.payments.generateUploadUrl);
  const logReminderPayment = useMutation(api.closer.reminderOutcomes.logReminderPayment);

  const onSubmit = async (values: PaymentFormValues, answer: WhopAnswer | null = null) => {
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
        ...(answer ? { provider: answer.intent } : {}),
      });

      const attached = answer
        ? whopSuccessMessage(answer, { marksAttendance: false, proofAttached: Boolean(proofFileId) })
        : null;
      if (attached) {
        // No new payment and the task stays as it is, so the page doesn't move on.
        toast.success(attached);
        onOpenChange(false);
        resetForm();
        return;
      }

      posthog.capture("reminder_outcome_payment", {
        follow_up_id: followUpId,
        payment_id: paymentId,
        amount_minor: Math.round(parsedAmount * 100),
        currency: values.currency,
        program_id: values.programId,
        program_name: selectedProgram?.name ?? null,
        payment_type: values.paymentType,
        has_proof: Boolean(proofFileId),
        ...(answer ? { whop_answer: answer.kind } : {}),
      });

      toast.success("Payment logged. The deal is won.");
      onOpenChange(false);
      resetForm();
      onSuccess();
    } catch (err: unknown) {
      // Whop reports a payment the step must ask about, or the deal is full.
      if (whop.refused(err, values)) {
        setConfirming(null);
        return;
      }
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
  const typedAmount = useWatch({ control: form.control, name: "amount" });
  const proofFile = useWatch({ control: form.control, name: "proofFile" });
  const offer = whopAmountOffer(whopCheck);
  // The Whop payment, confirmed: it wins the deal and completes the task.
  const saveWhopConfirm = async (choice: WhopConfirmChoice) => {
    if (!whopConfirm) return;
    await logReminderPayment({
      followUpId,
      amount: whopConfirm.amountMinor / 100,
      currency: whopConfirm.currency,
      programId: choice.programId,
      paymentType: choice.paymentType,
      provider: whopConfirm.intent,
    });
    toast.success("Payment recorded from Whop. The deal is won.");
    onOpenChange(false);
    onSuccess();
  };
  const offerCurrency = CURRENCIES.find((code) => code === offer?.currency);
  const showOffer = Boolean(offer && offerCurrency) && typedAmount === "" && !form.formState.isDirty;
  const whopValues = whop.shown?.values;
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
        {whopConfirm ? (
          <WhopConfirmForm
            prefill={whopConfirm}
            leadName={leadName}
            steps={[
              actingFor
                ? `Records the Whop payment, credited to ${actingFor}.`
                : "Records the Whop payment, credited to the deal’s closer.",
              "Closes the deal as won.",
              "Completes this task.",
            ]}
            save={saveWhopConfirm}
            onClose={() => onOpenChange(false)}
          />
        ) : whop.capacityHeld ? (
          <WhopCapacityHold
            onClose={() => {
              onOpenChange(false);
              resetForm();
            }}
          />
        ) : whop.shown && whopValues ? (
          <WhopPaymentFoundStep
            conflicts={whop.shown.conflicts}
            typed={{
              amountMinor: Math.round(parseFloat(whopValues.amount) * 100),
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
              title={leadName ? `Record ${leadName}’s ${amountLabel} payment?` : `Record a ${amountLabel} payment?`}
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
                actingFor
                  ? `Adds the payment to Billing’s Needs review, credited to ${actingFor}.`
                  : "Adds the payment to Billing’s Needs review, credited to the task’s closer.",
                ...(whop.answer ? [whopConfirmLine(whop.answer)] : []),
                actingFor ? `Closes the deal as won, with ${actingFor} as its closer.` : "Closes the deal as won.",
                "Completes this task.",
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
              title={leadName ? `Record a payment for ${leadName}` : "Record a payment"}
              description={
                actingFor
                  ? `Recording it closes the deal as won, credits ${actingFor}, and closes this task.`
                  : "Recording it closes the deal as won and closes this task."
              }
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
                proofRequired={proofRequired}
              />
            </FormProvider>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
