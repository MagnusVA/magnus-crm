"use client";

import { useEffect, useMemo, useState } from "react";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { PencilIcon } from "lucide-react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import { Textarea } from "@/components/ui/textarea";

type BillingPaymentDetail = NonNullable<
  FunctionReturnType<typeof api.billing.queries.getPaymentDetail>
>;
type BillingPayment = BillingPaymentDetail["payment"];
type CorrectionResult = {
  returnedToReview: boolean;
  changed: boolean;
};

const correctionSchema = z.object({
  amount: z.string().min(1, "Amount is required").refine((value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0;
  }, "Amount must be greater than 0"),
  paymentType: z.enum(["monthly", "split", "pif", "deposit"]),
  programId: z.string().min(1, "Program is required"),
  referenceCode: z.string().optional(),
  note: z.string().optional(),
  reason: z.string().trim().min(1, "A correction reason is required"),
});

type CorrectionFormValues = z.infer<typeof correctionSchema>;

const PAYMENT_TYPE_LABELS: Record<BillingPayment["paymentType"], string> = {
  monthly: "Monthly",
  split: "Split",
  pif: "Paid in full",
  deposit: "Deposit",
};

function amountToMinor(value: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.round(parsed * 100);
}

function defaultValuesForPayment(payment: BillingPayment): CorrectionFormValues {
  return {
    amount: (payment.amountMinor / 100).toFixed(2),
    paymentType: payment.paymentType,
    programId: payment.programId,
    referenceCode: payment.referenceCode ?? "",
    note: payment.note ?? "",
    reason: "",
  };
}

export function CorrectionDialog({
  payment,
  onCorrected,
}: {
  payment: BillingPayment;
  onCorrected: (result: CorrectionResult) => void;
}) {
  const [open, setOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pendingValues, setPendingValues] =
    useState<CorrectionFormValues | null>(null);
  const correctPayment = useMutation(api.billing.mutations.correctPayment);
  const programs = useQuery(api.tenantPrograms.queries.listPrograms, {
    includeArchived: false,
  });

  const defaultValues = useMemo(() => defaultValuesForPayment(payment), [payment]);
  const form = useForm({
    resolver: standardSchemaResolver(correctionSchema),
    defaultValues,
  });

  useEffect(() => {
    if (open) {
      form.reset(defaultValues);
      setSubmitError(null);
      setPendingValues(null);
    }
  }, [defaultValues, form, open]);

  const watched = form.watch();
  const financialChange = useMemo(() => {
    const amountMinor = amountToMinor(watched.amount);
    return (
      (amountMinor !== null && amountMinor !== payment.amountMinor) ||
      watched.paymentType !== payment.paymentType ||
      watched.programId !== payment.programId
    );
  }, [payment, watched]);

  const currentProgramMissing =
    programs !== undefined &&
    !programs.some((program) => program._id === payment.programId);

  const submitCorrection = async (values: CorrectionFormValues) => {
    setIsSubmitting(true);
    setSubmitError(null);

    try {
      const result = await correctPayment({
        paymentRecordId: payment.id,
        amount: Number(values.amount),
        paymentType: values.paymentType,
        programId: values.programId as Id<"tenantPrograms">,
        referenceCode: values.referenceCode,
        note: values.note,
        reason: values.reason,
      });
      setOpen(false);
      setPendingValues(null);
      form.reset(defaultValues);
      onCorrected({
        returnedToReview: result.returnedToReview,
        changed: result.changed,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to correct payment.";
      setSubmitError(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const onSubmit = async (values: CorrectionFormValues) => {
    if (financialChange && payment.status === "verified") {
      setPendingValues(values);
      return;
    }
    await submitCorrection(values);
  };

  if (payment.status === "disputed") {
    return null;
  }

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!isSubmitting) {
            setOpen(nextOpen);
          }
        }}
      >
        <DialogTrigger asChild>
          <Button variant="outline">
            <PencilIcon aria-hidden="true" data-icon="inline-start" />
            Correct payment
          </Button>
        </DialogTrigger>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Correct payment details</DialogTitle>
            <DialogDescription>
              Amount, type, program, reference, and note changes are audited.
            </DialogDescription>
          </DialogHeader>

          <Form {...form}>
            <form
              className="flex flex-col gap-4"
              onSubmit={form.handleSubmit(onSubmit)}
            >
              {submitError ? (
                <Alert variant="destructive">
                  <AlertDescription>{submitError}</AlertDescription>
                </Alert>
              ) : null}

              {financialChange && payment.status === "verified" ? (
                <Alert>
                  <AlertDescription>
                    This financial correction will return the reviewed payment
                    to the review queue.
                  </AlertDescription>
                </Alert>
              ) : null}

              <FieldGroup className="grid gap-4 md:grid-cols-2">
                <FormField
                  control={form.control}
                  name="amount"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Amount</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          disabled={isSubmitting}
                          inputMode="decimal"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="paymentType"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Payment type</FormLabel>
                      <Select
                        disabled={isSubmitting}
                        onValueChange={field.onChange}
                        value={field.value}
                      >
                        <FormControl>
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectGroup>
                            {Object.entries(PAYMENT_TYPE_LABELS).map(
                              ([value, label]) => (
                                <SelectItem key={value} value={value}>
                                  {label}
                                </SelectItem>
                              ),
                            )}
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
                    <FormItem className="md:col-span-2">
                      <FormLabel>Program</FormLabel>
                      <Select
                        disabled={isSubmitting || programs === undefined}
                        onValueChange={field.onChange}
                        value={field.value}
                      >
                        <FormControl>
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder="Select a program" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectGroup>
                            {currentProgramMissing ? (
                              <SelectItem value={payment.programId}>
                                Current: {payment.programName}
                              </SelectItem>
                            ) : null}
                            {(programs ?? []).map((program) => (
                              <SelectItem key={program._id} value={program._id}>
                                {program.name}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                      <FormDescription>
                        Archived programs cannot be selected for a new
                        correction.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="referenceCode"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Reference code</FormLabel>
                      <FormControl>
                        <Input {...field} disabled={isSubmitting} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="note"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Internal note</FormLabel>
                      <FormControl>
                        <Input {...field} disabled={isSubmitting} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="reason"
                  render={({ field }) => (
                    <FormItem className="md:col-span-2">
                      <FormLabel>Correction reason</FormLabel>
                      <FormControl>
                        <Textarea
                          {...field}
                          disabled={isSubmitting}
                          rows={3}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </FieldGroup>

              <DialogFooter>
                <Button
                  disabled={isSubmitting}
                  onClick={() => setOpen(false)}
                  type="button"
                  variant="outline"
                >
                  Cancel
                </Button>
                <Button disabled={isSubmitting} type="submit">
                  {isSubmitting ? <Spinner data-icon="inline-start" /> : null}
                  Save correction
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={pendingValues !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !isSubmitting) {
            setPendingValues(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Return payment to review?</AlertDialogTitle>
            <AlertDialogDescription>
              This correction changes billing substance on a reviewed payment.
              It will clear the reviewer stamp and move the payment back to
              Needs review.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isSubmitting}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={isSubmitting}
              onClick={(event) => {
                event.preventDefault();
                if (pendingValues) {
                  void submitCorrection(pendingValues);
                }
              }}
            >
              Continue
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
