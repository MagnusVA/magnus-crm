"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
import type { Id } from "@/convex/_generated/dataModel";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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
// Schema — amount as string, parsed on submit (same pattern as payment-form-dialog)
// ---------------------------------------------------------------------------

const paymentSchema = z.object({
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

type PaymentFormValues = z.infer<typeof paymentSchema>;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface RecordPaymentDialogProps {
  customerId: Id<"customers">;
  onPaymentRecorded?: () => void;
}

export function RecordPaymentDialog({
  customerId,
  onPaymentRecorded,
}: RecordPaymentDialogProps) {
  const [open, setOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const generateUploadUrl = useMutation(api.closer.payments.generateUploadUrl);
  const recordPayment = useMutation(
    api.customers.mutations.recordCustomerPayment,
  );

  const form = useForm({
    resolver: standardSchemaResolver(paymentSchema),
    defaultValues: {
      amount: "",
      currency: "USD",
      provider: undefined,
      referenceCode: "",
      proofFile: undefined,
    },
  });

  const onSubmit = async (values: PaymentFormValues) => {
    setIsSubmitting(true);
    setSubmitError(null);

    try {
      // Upload proof file if provided
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

      await recordPayment({
        customerId,
        amount: parseFloat(values.amount),
        currency: values.currency,
        provider: values.provider,
        referenceCode: values.referenceCode || undefined,
        proofFileId,
      });

      toast.success("Payment recorded successfully");
      setOpen(false);
      form.reset();
      onPaymentRecorded?.();
    } catch (err: unknown) {
      const message =
        err instanceof Error
          ? err.message
          : "Failed to record payment. Please try again.";
      setSubmitError(message);
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <>
      <Button
        onClick={() => setOpen(true)}
        variant="outline"
        size="sm"
      >
        <BanknoteIcon data-icon="inline-start" />
        Record Payment
      </Button>

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
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Record Payment</DialogTitle>
            <DialogDescription>
              Record a post-conversion payment (installment, upsell, renewal).
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

                {/* Reference Code */}
                <FormField
                  control={form.control}
                  name="referenceCode"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Reference Code</FormLabel>
                      <FormControl>
                        <Input
                          type="text"
                          placeholder="e.g., pi_3abc123..."
                          disabled={isSubmitting}
                          {...field}
                        />
                      </FormControl>
                      <FormDescription>
                        Transaction ID from your payment provider
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
                      Recording...
                    </>
                  ) : (
                    "Record Payment"
                  )}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </>
  );
}
