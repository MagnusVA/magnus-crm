"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { useMutation } from "convex/react";
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
import { BanknoteIcon, AlertCircleIcon, UploadIcon } from "lucide-react";
import { toast } from "sonner";
import posthog from "posthog-js";

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
const PROVIDERS = [
  "Stripe",
  "PayPal",
  "Square",
  "Cash",
  "Bank Transfer",
  "Other",
] as const;

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
  provider: z.enum(PROVIDERS, { error: "Please select a payment provider" }),
  referenceCode: z.string().optional(),
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
};

/**
 * Payment Form Dialog
 *
 * Allows a closer to log a payment for an opportunity:
 * - Amount (required, > 0)
 * - Currency (required, defaults to USD)
 * - Provider (required)
 * - Reference Code (optional)
 * - Proof File (optional, image or PDF up to 10 MB)
 *
 * Two-step file upload:
 * 1. Client calls `generateUploadUrl()` mutation to get a Convex storage URL
 * 2. Client uploads the file directly to that URL
 * 3. Convex returns a storageId
 * 4. Client passes storageId to `logPayment()` mutation
 *
 * On success:
 * - Payment record is created
 * - Opportunity transitions to "payment_received" (terminal state)
 * - Dialog closes and form resets
 *
 * Form state is managed by React Hook Form + Zod resolver.
 * Inline field-level errors are rendered via FormMessage.
 * Submission-level errors (network, Convex) use an Alert.
 */
export function PaymentFormDialog({
  opportunityId,
  meetingId,
  onSuccess,
}: PaymentFormDialogProps) {
  // Dialog open/close state — kept outside RHF (not a form field)
  const [open, setOpen] = useState(false);
  // Submission loading flag — controls button spinner & disabled states
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Submission-level errors (network/Convex failures, NOT validation errors)
  const [submitError, setSubmitError] = useState<string | null>(null);

  // React Hook Form — single hook replaces 5 field-level useState hooks
  const form = useForm({
    resolver: standardSchemaResolver(paymentFormSchema),
    defaultValues: {
      amount: "",
      currency: "USD",
      provider: undefined,
      referenceCode: "",
      proofFile: undefined,
    },
  });

  // Convex mutations (unchanged from original)
  const generateUploadUrl = useMutation(api.closer.payments.generateUploadUrl);
  const logPayment = useMutation(api.closer.payments.logPayment);

  // ---------------------------------------------------------------------------
  // Submission handler — only called when Zod validation passes
  // ---------------------------------------------------------------------------

  const onSubmit = async (values: PaymentFormValues) => {
    setIsSubmitting(true);
    setSubmitError(null);

    try {
      // Upload proof file if provided (two-step Convex storage flow)
      let proofFileId: Id<"_storage"> | undefined;
      if (values.proofFile) {
        const uploadUrl = await generateUploadUrl();
        const uploadResponse = await fetch(uploadUrl, {
          method: "POST",
          headers: { "Content-Type": values.proofFile.type },
          body: values.proofFile,
        });

        if (!uploadResponse.ok) {
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

      // Log the payment via Convex mutation
      const parsedAmount = parseFloat(values.amount);
      const amountMinor = Math.round(parsedAmount * 100);
      await logPayment({
        opportunityId,
        meetingId,
        amount: parsedAmount,
        currency: values.currency,
        provider: values.provider,
        referenceCode: values.referenceCode || undefined,
        proofFileId,
      });

      // Success path (identical to previous implementation)
      await onSuccess?.();
      posthog.capture("payment_logged", {
        opportunity_id: opportunityId,
        meeting_id: meetingId,
        amount_minor: amountMinor,
        currency: values.currency,
        provider: values.provider,
        has_reference_code: Boolean(values.referenceCode),
        has_proof_file: Boolean(proofFileId),
      });
      toast.success("Payment logged successfully");
      setOpen(false);
      form.reset();
    } catch (err: unknown) {
      posthog.captureException(err);
      const message =
        err instanceof Error
          ? err.message
          : "Failed to log payment. Please try again.";
      setSubmitError(message);
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        // Prevent closing during submission
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
        <Button variant="outline" size="lg">
          <BanknoteIcon data-icon="inline-start" />
          Log Payment
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Log Payment</DialogTitle>
          <DialogDescription>
            Record a payment to close this opportunity.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)}>
            <FieldGroup>
              {/* Amount */}
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
                        step="0.01"
                        placeholder="299.99"
                        min="0"
                        disabled={isSubmitting}
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Currency */}
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

              {/* Provider */}
              <FormField
                control={form.control}
                name="provider"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Provider <span className="text-destructive">*</span>
                    </FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      value={field.value}
                      disabled={isSubmitting}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select provider" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectGroup>
                          {PROVIDERS.map((prov) => (
                            <SelectItem key={prov} value={prov}>
                              {prov}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Fathom Link */}
              <FormField
                control={form.control}
                name="referenceCode"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Fathom Link</FormLabel>
                    <FormControl>
                      <Input
                        type="url"
                        placeholder="https://app.fathom.video/share/..."
                        disabled={isSubmitting}
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>
                      Link to the Fathom call recording
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Proof File */}
              <FormField
                control={form.control}
                name="proofFile"
                render={({ field: { value, onChange, ...fieldProps } }) => (
                  <FormItem>
                    <FormLabel>Proof File</FormLabel>
                    <FormControl>
                      <Input
                        type="file"
                        accept="image/jpeg,image/png,image/gif,application/pdf"
                        disabled={isSubmitting}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          onChange(file);
                        }}
                        {...fieldProps}
                      />
                    </FormControl>
                    {value && (
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <UploadIcon className="size-3 shrink-0" />
                        <span className="truncate">
                          {value.name} ({(value.size / 1024).toFixed(1)} KB)
                        </span>
                      </div>
                    )}
                    <FormDescription>
                      Max 10 MB. Allowed: PNG, JPEG, GIF, PDF
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </FieldGroup>

            {/* Submission-level error (network/Convex failures only) */}
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
                  form.reset();
                  setSubmitError(null);
                }}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? (
                  <>
                    <Spinner data-icon="inline-start" />
                    Logging...
                  </>
                ) : (
                  "Log Payment"
                )}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
