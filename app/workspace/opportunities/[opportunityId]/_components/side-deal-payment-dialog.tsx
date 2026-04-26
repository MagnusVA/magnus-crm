"use client";

import { useState } from "react";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { useMutation } from "convex/react";
import { BanknoteIcon, UploadIcon } from "lucide-react";
import posthog from "posthog-js";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { ProgramSelect } from "@/app/workspace/closer/_components/program-select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { FieldGroup } from "@/components/ui/field";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

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
      (file) => !file || file.size <= MAX_FILE_SIZE,
      "File size must be less than 10 MB",
    )
    .refine(
      (file) => !file || VALID_FILE_TYPES.includes(file.type),
      "Only images (JPEG, PNG, GIF) and PDFs are allowed",
    ),
});

type PaymentValues = z.infer<typeof paymentSchema>;

export function SideDealPaymentDialog({
  opportunityId,
}: {
  opportunityId: Id<"opportunities">;
}) {
  const [open, setOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const generateUploadUrl = useMutation(api.closer.payments.generateUploadUrl);
  const logPayment = useMutation(api.sideDeals.logPayment.logPayment);

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
      posthog.captureException(error);
      const message =
        error instanceof Error ? error.message : "Failed to record payment";
      setSubmitError(message);
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  };

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
        <Button size="sm">
          <BanknoteIcon aria-hidden="true" data-icon="inline-start" />
          Record payment
        </Button>
      </DialogTrigger>
      {open ? (
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Record Side-Deal Payment</DialogTitle>
            <DialogDescription>
              Log a payment and close this manual opportunity as won.
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
                          min="0"
                          placeholder="299.99"
                          autoComplete="off"
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
                            {CURRENCIES.map((currency) => (
                              <SelectItem key={currency} value={currency}>
                                {currency}
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
                          disabled={isSubmitting}
                        />
                      </FormControl>
                      <FormDescription>
                        Attribute this payment to the correct tenant program.
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
                        Payment Type{" "}
                        <span className="text-destructive">*</span>
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
                  render={({ field: { value, onChange, ...fieldProps } }) => (
                    <FormItem>
                      <FormLabel>Proof File</FormLabel>
                      <FormControl>
                        <Input
                          type="file"
                          accept="image/jpeg,image/png,image/gif,application/pdf"
                          disabled={isSubmitting}
                          onChange={(event) => {
                            onChange(event.target.files?.[0]);
                          }}
                          {...fieldProps}
                        />
                      </FormControl>
                      {value ? (
                        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <UploadIcon
                            aria-hidden="true"
                            className="size-3 shrink-0"
                          />
                          <span className="truncate">
                            {value.name} ({(value.size / 1024).toFixed(1)} KB)
                          </span>
                        </div>
                      ) : null}
                      <FormDescription>
                        Max 10 MB. Allowed: PNG, JPEG, GIF, PDF.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </FieldGroup>

              {submitError ? (
                <Alert variant="destructive" className="mt-4">
                  <AlertDescription>{submitError}</AlertDescription>
                </Alert>
              ) : null}

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
                      Recording…
                    </>
                  ) : (
                    "Record payment"
                  )}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
