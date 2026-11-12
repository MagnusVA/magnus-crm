"use client";

import { useEffect, useRef, useState } from "react";
import { FormProvider, useForm, useWatch } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { BanknoteIcon } from "lucide-react";
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
import { changedFields, formatMinorPlain, minorToInput } from "@/lib/callInsights/display";
import { cn } from "@/lib/utils";
import {
  PrefillHint,
  ReadingChangedNotice,
  useSuggestionRef,
  withFromCall,
  type DialogSuggestion,
  type SuggestionPrefill,
} from "@/components/call-insights/suggestion-context";

// ---------------------------------------------------------------------------
// Zod Schema — single source of truth for form validation
// ---------------------------------------------------------------------------

const paymentFormSchema = z.object({
  amount: z
    .string()
    .min(1, "Amount is required")
    .refine(
      (val) => {
        const num = parseFloat(val);
        return !isNaN(num) && num > 0;
      },
      { message: "Amount must be greater than 0" },
    ),
  // Opened from a suggestion, the currency can start unselected.
  currency: z.enum(CURRENCIES, { error: "Pick the currency" }),
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

type PaymentFormValues = z.infer<typeof paymentFormSchema>;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type PaymentFormDialogProps = {
  opportunityId: Id<"opportunities">;
  meetingId: Id<"meetings">;
  onSuccess?: () => Promise<void>;
  compact?: boolean;
  /** Controlled open state. When set, the dialog renders no trigger button. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Named in the dialog so the closer knows whose deal closes. */
  leadName?: string | null;
  /** The booked program, preselected when it is an active program. */
  defaultProgramId?: Id<"tenantPrograms"> | null;
  /** Values from a payment link, filled in when the dialog opens. */
  prefill?: PaymentLinkValues;
  /**
   * Opened from the suggested result: its values fill the form in place of
   * the USD and booked-program defaults, and proof is optional.
   */
  suggestion?: DialogSuggestion;
};

/** The form values a suggestion fills: only what it heard, never a proof file. */
function suggestionFormValues(prefill: SuggestionPrefill, programIds: Set<string>) {
  const { values } = prefill;
  return {
    amount:
      prefill.amountPrefill && values.amountMinor !== undefined ? minorToInput(values.amountMinor) : "",
    // Unselected when the call named no currency the form offers.
    currency: (CURRENCIES.find((code) => code === values.currency) ?? "") as PaymentFormValues["currency"],
    programId: values.programId && programIds.has(values.programId) ? values.programId : "",
    paymentType: values.paymentType,
  };
}

/** The prefilled fields by name, for `changedFields`. */
function prefilledFields(prefill: SuggestionPrefill) {
  const { values } = prefill;
  return {
    amountMinor: prefill.amountPrefill ? values.amountMinor : undefined,
    currency: values.currency,
    paymentType: values.paymentType,
    programId: values.programId,
  };
}

/**
 * Won · log payment, from the meeting page. The form (amount, currency,
 * program, payment type, proof file, required for closers) validates, then a confirm step
 * shows the payment and what recording does; only its button calls
 * `logPayment`. The program starts at the booked program when it is still
 * active, with that program's default currency.
 */
export function PaymentFormDialog({
  opportunityId,
  meetingId,
  onSuccess,
  compact,
  open: controlledOpen,
  onOpenChange,
  leadName,
  defaultProgramId,
  prefill,
  suggestion,
}: PaymentFormDialogProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = controlledOpen ?? internalOpen;
  const setOpen = (value: boolean) => {
    if (!isControlled) setInternalOpen(value);
    onOpenChange?.(value);
  };
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Closers must attach proof; the payment mutations refuse a payment without it.
  const roleNeedsProof = useProofRequired();
  const fromCall = suggestion !== undefined;
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
  };

  // Programs load after the form, so the booked program fills in once they do.
  // Not from a suggestion: its program stays unselected unless the call named one.
  useEffect(() => {
    if (fromCall || !bookedProgram || form.getValues("programId") !== "") return;
    form.setValue("programId", bookedProgram._id);
    if (bookedCurrency) form.setValue("currency", bookedCurrency);
  }, [fromCall, bookedProgram, bookedCurrency, form]);

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

  // A suggestion's values fill the form once each time it opens from one,
  // after the programs load, so its program can be checked.
  const applySuggestion = (next: SuggestionPrefill) => {
    const programIds = new Set((programs ?? []).map((program) => String(program._id)));
    const values = suggestionFormValues(next, programIds);
    form.setValue("amount", values.amount);
    form.setValue("currency", values.currency);
    form.setValue("programId", values.programId);
    form.setValue("paymentType", values.paymentType as PaymentFormValues["paymentType"]);
    form.clearErrors();
  };
  const reading = useSuggestionRef(suggestion, (next) => {
    setConfirming(null);
    applySuggestion(next);
  });
  // From a live suggestion proof is optional for everyone; the server checks
  // the suggestion. If it ends while the form is open, the usual rule is back.
  const proofRequired = roleNeedsProof && !reading.prefill;
  const suggestionApplied = useRef(false);
  useEffect(() => {
    if (!open) {
      suggestionApplied.current = false;
      return;
    }
    if (!suggestion || suggestionApplied.current || programs === undefined) return;
    suggestionApplied.current = true;
    const programIds = new Set(programs.map((program) => String(program._id)));
    form.reset({ ...suggestionFormValues(suggestion.opened, programIds), proofFile: undefined });
  }, [open, suggestion, programs, form]);

  const generateUploadUrl = useMutation(api.closer.payments.generateUploadUrl);
  const logPayment = useMutation(api.closer.payments.logPayment);

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

        const uploadData = (await uploadResponse.json()) as {
          storageId?: string;
        };
        if (!uploadData.storageId) {
          throw new Error("File upload returned invalid storage ID");
        }
        proofFileId = uploadData.storageId as Id<"_storage">;
      }

      const parsedAmount = parseFloat(values.amount);
      const amountMinor = Math.round(parsedAmount * 100);
      const selectedProgram = programs.find(
        (program) => program._id === values.programId,
      );

      const fromSuggestion = reading.prefill
        ? reading.ref(
            changedFields(prefilledFields(reading.prefill), {
              amountMinor,
              currency: values.currency,
              paymentType: values.paymentType,
              programId: values.programId,
            }),
          )
        : undefined;
      await logPayment({
        opportunityId,
        meetingId,
        amount: parsedAmount,
        currency: values.currency,
        programId: values.programId as Id<"tenantPrograms">,
        paymentType: values.paymentType,
        proofFileId,
        ...(fromSuggestion ? { fromSuggestion } : {}),
      });

      await onSuccess?.();
      posthog.capture("payment_logged", {
        opportunity_id: opportunityId,
        meeting_id: meetingId,
        amount_minor: amountMinor,
        currency: values.currency,
        program_id: values.programId,
        program_name: selectedProgram?.name ?? null,
        payment_type: values.paymentType,
        has_proof_file: Boolean(proofFileId),
        ...(fromSuggestion ? { from_suggestion: true } : {}),
      });
      toast.success("Payment logged. The deal is won.");
      setOpen(false);
      resetForm();
    } catch (err: unknown) {
      reportClientError(err, { flow: "meeting_payment_log", httpStatus: uploadHttpStatus });
      const message =
        getErrorMessage(err, "Failed to log payment. Please try again.");
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

  const readingNotice = reading.changed ? (
    <ReadingChangedNotice
      onUseNew={reading.applyNew}
      onKeep={reading.keepMine}
      disabled={isSubmitting}
    />
  ) : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!isSubmitting) {
          setOpen(value);
          if (!value) {
            resetForm();
            setSubmitError(null);
          }
        }
      }}
    >
      {isControlled ? null : (
        <DialogTrigger asChild>
          <Button variant="outline" size={compact ? "sm" : "lg"}>
            <BanknoteIcon data-icon="inline-start" />
            Log Payment
          </Button>
        </DialogTrigger>
      )}
      <DialogContent
        className={cn(ACTION_DIALOG, fromCall && "ph-no-capture")}
        showCloseButton={!isSubmitting}
      >
        {confirming ? (
          <>
            <ActionDialogHeader
              title={withFromCall(
                leadName ? `Record ${leadName}’s ${amountLabel} payment?` : `Record a ${amountLabel} payment?`,
                fromCall,
              )}
              description="Check the payment before you record it."
            />
            {readingNotice}
            <PaymentConfirmStep
              amount={confirming.amount}
              currency={confirming.currency}
              programName={programName}
              paymentType={confirming.paymentType}
              proofFile={confirming.proofFile}
              steps={[
                "Adds the payment to Billing’s Needs review, credited to the deal’s closer.",
                "Closes the deal as won.",
                "Marks the call held.",
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
              title={withFromCall(
                leadName ? `Record a payment for ${leadName}` : "Record a payment",
                fromCall,
              )}
              description="Recording it closes the deal as won and marks the call held."
            />
            {readingNotice}
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
                  resetForm();
                  setSubmitError(null);
                }}
                program={{
                  kind: "choose",
                  disabled: isSubmitDisabled,
                  // With no programs, the select says why in place of a description.
                  description: !hasPrograms
                    ? undefined
                    : bookedProgram && chosenProgramId === bookedProgram._id
                      ? "The program this call was booked for."
                      : "The program this payment is for.",
                }}
                submitDisabled={isSubmitDisabled}
                proofRequired={proofRequired}
                suggested={
                  reading.prefill
                    ? {
                        amountHint:
                          !reading.prefill.amountPrefill && reading.prefill.amountHintMinor !== undefined ? (
                            <PrefillHint>
                              Heard on the call: {formatMinorPlain(reading.prefill.amountHintMinor)}
                            </PrefillHint>
                          ) : null,
                        currencyHint:
                          reading.prefill.values.currencyAssumed && reading.prefill.values.currency === "USD" ? (
                            <PrefillHint>USD (assumed): only &ldquo;dollars&rdquo; was said</PrefillHint>
                          ) : null,
                      }
                    : undefined
                }
              />
            </FormProvider>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
