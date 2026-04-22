"use client";

import { useEffect, useState } from "react";
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
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { AlertCircleIcon, InfoIcon } from "lucide-react";
import { toast } from "sonner";
import posthog from "posthog-js";

import { ProgramSelect } from "@/app/workspace/closer/_components/program-select";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "JPY"] as const;
type Currency = (typeof CURRENCIES)[number];

const PAYMENT_TYPES = [
  { value: "pif", label: "PIF (Paid in Full)" },
  { value: "split", label: "Split Payment" },
  { value: "monthly", label: "Monthly" },
  { value: "deposit", label: "Deposit" },
] as const;

// ---------------------------------------------------------------------------
// Schema — non-commissionable post-conversion payment. Mirrors the
// commissionable dialogs' shape MINUS the proof file: non-commissionable
// rows are not attributed to any closer, so the admin attestation /
// proof-of-payment requirement does not apply.
// ---------------------------------------------------------------------------

const paymentSchema = z.object({
  amount: z
    .string()
    .min(1, "Amount is required")
    .refine((value) => {
      const parsed = parseFloat(value);
      return !Number.isNaN(parsed) && parsed > 0;
    }, "Amount must be greater than 0"),
  currency: z.enum(CURRENCIES),
  programId: z.string().min(1, "Program is required"),
  paymentType: z.enum(["pif", "split", "monthly", "deposit"], {
    error: "Please select a payment type",
  }),
  paidAt: z
    .string()
    .min(1, "Paid date is required")
    .refine((value) => {
      // `<input type="date">` emits `YYYY-MM-DD`; `Date.parse` accepts that
      // as a UTC midnight. Reject unparseable input to catch manual typing.
      const ms = Date.parse(value);
      return !Number.isNaN(ms);
    }, "Invalid date")
    .refine((value) => {
      const ms = Date.parse(value);
      // Compare against the start of tomorrow (local) so "today" is always
      // valid and we only reject truly-future dates.
      const startOfTomorrow = new Date();
      startOfTomorrow.setHours(0, 0, 0, 0);
      startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);
      return ms < startOfTomorrow.getTime();
    }, "Paid date cannot be in the future"),
  referenceCode: z.string().optional(),
  note: z
    .string()
    .trim()
    .max(500, "Note must be 500 characters or fewer")
    .optional(),
});

type PaymentFormValues = z.infer<typeof paymentSchema>;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function normalizeCurrency(value: string | undefined): Currency {
  if (!value) return "USD";
  const upper = value.toUpperCase();
  return (CURRENCIES as readonly string[]).includes(upper)
    ? (upper as Currency)
    : "USD";
}

/**
 * Returns today's date as `YYYY-MM-DD` in the viewer's local timezone. Used
 * as the default for the "Paid At" picker so the admin sees their own
 * calendar date, not UTC midnight.
 */
function todayLocalIso(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  const day = `${now.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

interface RecordPaymentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customer: {
    _id: Id<"customers">;
    programId?: Id<"tenantPrograms">;
    programName?: string;
    currency?: string;
  };
  onPaymentRecorded?: () => void;
}

export function RecordPaymentDialog({
  open,
  onOpenChange,
  customer,
  onPaymentRecorded,
}: RecordPaymentDialogProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const recordPayment = useMutation(
    api.customers.mutations.recordCustomerPayment,
  );

  const defaultCurrency = normalizeCurrency(customer.currency);
  const customerProgramIsActive =
    !!customer.programId && !!customer.programName;

  const form = useForm({
    resolver: standardSchemaResolver(paymentSchema),
    defaultValues: {
      amount: "",
      currency: defaultCurrency,
      programId: "",
      paymentType: undefined,
      paidAt: todayLocalIso(),
      referenceCode: "",
      note: "",
    },
  });

  // Reset form whenever the dialog opens. We re-seed here (rather than in
  // `defaultValues`) so the preselect reflects the latest `customer` prop
  // every time the admin reopens the dialog — the dialog is externally
  // controlled, so the parent may mutate `customer` between openings.
  useEffect(() => {
    if (!open) return;
    form.reset({
      amount: "",
      currency: normalizeCurrency(customer.currency),
      programId:
        customerProgramIsActive && customer.programId ? customer.programId : "",
      paymentType: undefined,
      paidAt: todayLocalIso(),
      referenceCode: "",
      note: "",
    });
    setSubmitError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, customer.programId, customer.programName, customer.currency]);

  const onSubmit = async (values: PaymentFormValues) => {
    setIsSubmitting(true);
    setSubmitError(null);

    try {
      const amountDollars = parseFloat(values.amount);
      // `paidAt` comes in as `YYYY-MM-DD` (UTC midnight per `<input type="date">`).
      // Convert to the user's *local* midnight so the reporting bucket lines
      // up with the calendar date the admin picked, no matter their TZ.
      const [yearStr, monthStr, dayStr] = values.paidAt.split("-");
      const paidAtLocal = new Date(
        Number(yearStr),
        Number(monthStr) - 1,
        Number(dayStr),
        0,
        0,
        0,
        0,
      );
      const paidAtMs = paidAtLocal.getTime();
      const trimmedNote = values.note?.trim();

      await recordPayment({
        customerId: customer._id,
        amount: amountDollars,
        currency: values.currency,
        programId: values.programId as Id<"tenantPrograms">,
        paymentType: values.paymentType,
        referenceCode: values.referenceCode?.trim() || undefined,
        paidAt: paidAtMs,
        note: trimmedNote || undefined,
      });

      posthog.capture("post_conversion_payment_recorded", {
        customer_id: customer._id,
        amount_minor: Math.round(amountDollars * 100),
        currency: values.currency,
        program_id: values.programId,
        payment_type: values.paymentType,
        has_reference: !!values.referenceCode?.trim(),
        has_note: !!trimmedNote,
        is_backdated: paidAtMs < Date.now() - 24 * 60 * 60 * 1000,
        preseeded_from_customer_program:
          customerProgramIsActive &&
          !!customer.programId &&
          customer.programId === values.programId,
      });

      toast.success("Payment recorded");
      onOpenChange(false);
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
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!isSubmitting) onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Record Payment</DialogTitle>
          <DialogDescription>
            Record a post-conversion payment (installment, upsell, renewal).
          </DialogDescription>
        </DialogHeader>

        {/* Persistent banner — this dialog is non-commissionable by design. */}
        <Alert className="mb-4" variant="default">
          <InfoIcon />
          <AlertTitle>Post-Conversion Revenue</AlertTitle>
          <AlertDescription>
            This payment is not attributed to any closer and will not affect
            commissionable revenue reports. Use this only for direct payments
            logged by admin after the deal has closed.
          </AlertDescription>
        </Alert>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)}>
            <FieldGroup>
              {/* Program */}
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
                        placeholder="Select program"
                      />
                    </FormControl>
                    <FormDescription>
                      {customerProgramIsActive
                        ? "Pre-seeded from this customer's program. Change only if this payment belongs to a different program."
                        : "This customer's original program is archived. Pick an active program for this payment."}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Payment Type */}
              <FormField
                control={form.control}
                name="paymentType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Payment Type <span className="text-destructive">*</span>
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
                          {PAYMENT_TYPES.map((pt) => (
                            <SelectItem key={pt.value} value={pt.value}>
                              {pt.label}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

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
                        min="0"
                        placeholder="299.99"
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

              {/* Paid At */}
              <FormField
                control={form.control}
                name="paidAt"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Paid At <span className="text-destructive">*</span>
                    </FormLabel>
                    <FormControl>
                      <Input
                        type="date"
                        max={todayLocalIso()}
                        disabled={isSubmitting}
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>
                      Defaults to today. Back-date when logging a payment you
                      received earlier so it lands in the correct reporting
                      period.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Reference */}
              <FormField
                control={form.control}
                name="referenceCode"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Reference</FormLabel>
                    <FormControl>
                      <Input
                        type="text"
                        placeholder="e.g., pi_3abc123..."
                        disabled={isSubmitting}
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>
                      Transaction ID from your payment provider.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Note */}
              <FormField
                control={form.control}
                name="note"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Note</FormLabel>
                    <FormControl>
                      <Textarea
                        rows={3}
                        maxLength={500}
                        placeholder="Re-enrollment, partial chargeback, upsell..."
                        disabled={isSubmitting}
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>
                      Optional audit context (visible in admin views only).
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
                onClick={() => onOpenChange(false)}
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
  );
}
