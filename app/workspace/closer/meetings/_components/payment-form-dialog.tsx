"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { FieldGroup } from "@/components/ui/field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { BanknoteIcon, AlertCircleIcon } from "lucide-react";
import { toast } from "sonner";
import posthog from "posthog-js";
import { reportClientError } from "@/lib/observability/report-client-error";
import { ProgramSelect } from "@/app/workspace/closer/_components/program-select";
import { ProofFileInput } from "./proof-file-input";
import { getErrorMessage } from "@/lib/errors";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max proof file size: 10 MB */
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const VALID_FILE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "application/pdf",
];

const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "JPY"] as const;
const PAYMENT_TYPES = ["monthly", "split", "pif", "deposit"] as const;
const PAYMENT_TYPE_LABELS: Record<(typeof PAYMENT_TYPES)[number], string> = {
  monthly: "Monthly",
  split: "Split",
  pif: "Paid in Full",
  deposit: "Deposit",
};

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
  currency: z.enum(CURRENCIES),
  programId: z.string().min(1, "Please select a program"),
  paymentType: z.enum(PAYMENT_TYPES, {
    error: "Please select a payment type",
  }),
  proofFile: z
    .instanceof(File)
    .optional()
    .refine(
      (file) => !file || file.size <= MAX_FILE_SIZE,
      "File size must be less than 10 MB",
    )
    .refine(
      (file) => !file || VALID_FILE_TYPES.includes(file.type),
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
};

/**
 * Payment Form Dialog
 *
 * Allows a closer to log a payment for an opportunity:
 * - Amount (required, > 0)
 * - Currency (required, defaults to USD)
 * - Program (required)
 * - Payment Type (required)
 * - Proof File (optional, image or PDF up to 10 MB)
 *
 * The program starts at the booked program when it is still active, with
 * that program's default currency.
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
  useEffect(() => {
    if (!bookedProgram || form.getValues("programId") !== "") return;
    form.setValue("programId", bookedProgram._id);
    if (bookedCurrency) form.setValue("currency", bookedCurrency);
  }, [bookedProgram, bookedCurrency, form]);

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

      await logPayment({
        opportunityId,
        meetingId,
        amount: parsedAmount,
        currency: values.currency,
        programId: values.programId as Id<"tenantPrograms">,
        paymentType: values.paymentType,
        proofFileId,
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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {leadName ? `Log ${leadName}\u2019s payment` : "Log payment"}
          </DialogTitle>
          <DialogDescription>
            Logging it closes the deal as won and marks the call held.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)}>
            <FieldGroup>
              <FormField
                control={form.control}
                name="amount"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Amount <span className="text-destructive">*</span>
                    </FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        inputMode="decimal"
                        step="0.01"
                        placeholder="299.99"
                        min="0"
                        className="[appearance:textfield] tabular-nums [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                        disabled={isSubmitting}
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="currency"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Currency <span className="text-destructive">*</span>
                    </FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      value={field.value}
                      disabled={isSubmitting}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectGroup>
                          {CURRENCIES.map((curr) => (
                            <SelectItem key={curr} value={curr}>
                              {curr}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="programId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Program <span className="text-destructive">*</span>
                    </FormLabel>
                    <FormControl>
                      <ProgramSelect
                        value={field.value || undefined}
                        onChange={field.onChange}
                        disabled={isSubmitDisabled}
                      />
                    </FormControl>
                    <FormDescription>
                      {bookedProgram && field.value === bookedProgram._id
                        ? "The program this call was booked for."
                        : "The program this payment is for."}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="paymentType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Payment type <span className="text-destructive">*</span>
                    </FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      value={field.value}
                      disabled={isSubmitting}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select payment type" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectGroup>
                          {PAYMENT_TYPES.map((paymentType) => (
                            <SelectItem key={paymentType} value={paymentType}>
                              {PAYMENT_TYPE_LABELS[paymentType]}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    <FormDescription>
                      Choose how the revenue should be classified.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="proofFile"
                render={({ field: { value, onChange, onBlur, name } }) => (
                  <FormItem>
                    <FormLabel>Proof file</FormLabel>
                    <FormControl>
                      <ProofFileInput
                        value={value}
                        onChange={onChange}
                        onBlur={onBlur}
                        name={name}
                        accept="image/jpeg,image/png,image/gif,application/pdf"
                        disabled={isSubmitting}
                      />
                    </FormControl>
                    <FormDescription>
                      Max 10 MB. Allowed: PNG, JPEG, GIF, PDF
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </FieldGroup>

            {!isProgramListLoading && !hasPrograms && (
              <Alert variant="destructive" className="mt-4">
                <AlertCircleIcon />
                <AlertDescription>
                  No active programs are available. Create one before logging a
                  payment.
                </AlertDescription>
              </Alert>
            )}

            {submitError && (
              <Alert variant="destructive" className="mt-4">
                <AlertCircleIcon />
                <AlertDescription>{submitError}</AlertDescription>
              </Alert>
            )}

            <DialogFooter className="mt-5">
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setOpen(false);
                  resetForm();
                  setSubmitError(null);
                }}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isSubmitDisabled}>
                {isSubmitting ? (
                  <>
                    <Spinner data-icon="inline-start" />
                    Logging...
                  </>
                ) : (
                  "Log payment and close as won"
                )}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
