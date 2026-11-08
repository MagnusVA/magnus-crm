"use client";

import { useId, useMemo, useState, type ReactNode, type RefObject } from "react";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { Controller, useForm, useWatch } from "react-hook-form";
import { z } from "zod";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
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
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
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
import { getErrorMessage } from "@/lib/errors";
import { PAYMENT_TYPE_LABELS } from "./billing-format";

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

/** A ruled form row: a 13px slate label in a 120px column beside the control, over it when narrow. */
const ROW =
  "grid gap-1.5 px-4 py-3 data-[invalid=true]:text-foreground @lg:grid-cols-[120px_minmax(0,1fr)] @lg:items-start @lg:gap-x-3";
const ROW_LABEL = "text-[13px] font-normal text-muted-foreground @lg:min-h-8 @lg:items-center";
/** Field errors in danger ink, which reads at 4.5:1 where the fill red doesn't. */
const ERROR = "text-[13px] text-danger-ink";

function RowControl({ children }: { children: ReactNode }) {
  return <div className="flex min-w-0 flex-col gap-1.5">{children}</div>;
}

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

/**
 * The correction form. The page keeps the trigger and mounts this on the
 * first opening, with a new `key` for each opening so the form starts from
 * the payment as it is now.
 */
export function CorrectionDialog({
  payment,
  open,
  onOpenChange,
  onCorrected,
  triggerRef,
}: {
  payment: BillingPayment;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCorrected: (result: CorrectionResult) => void;
  /** The page's trigger, which takes focus back on close. */
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const ids = useId();
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


  const watched = useWatch({ control: form.control });
  const financialChange = useMemo(() => {
    const amountMinor = amountToMinor(watched.amount ?? "");
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
      onOpenChange(false);
      setPendingValues(null);
      form.reset(defaultValues);
      onCorrected({
        returnedToReview: result.returnedToReview,
        changed: result.changed,
      });
    } catch (error) {
      const message =
        getErrorMessage(error, "Unable to correct payment.");
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

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (isSubmitting) return;
          onOpenChange(nextOpen);
        }}
      >
        <DialogContent
          className="gap-0 overflow-hidden p-0 sm:max-w-xl"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            triggerRef.current?.focus();
          }}
        >
          <DialogHeader className="border-b px-4 pt-4 pr-12 pb-3.5">
            <DialogTitle className="text-[17px] font-semibold">Correct payment details</DialogTitle>
            <DialogDescription className="text-[13px]">
              Changes to the amount, type, program, reference and note are kept in the payment&apos;s history.
            </DialogDescription>
          </DialogHeader>

          <form className="@container flex min-h-0 flex-col" onSubmit={form.handleSubmit(onSubmit)}>
            {submitError ? (
              <p role="alert" className="border-b px-4 py-3 text-[13px] text-danger-ink">
                {submitError}
              </p>
            ) : null}

            {financialChange && payment.status === "verified" ? (
              <p role="status" className="border-b bg-warning-surface px-4 py-3 text-[13px] font-medium text-warning-ink">
                This change returns the reviewed payment to Needs review.
              </p>
            ) : null}

            <FieldGroup className="max-h-[min(60vh,32rem)] gap-0 divide-y overflow-y-auto">
              <Controller
                control={form.control}
                name="amount"
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid} className={ROW}>
                    <FieldLabel htmlFor={`${ids}-amount`} className={ROW_LABEL}>
                      Amount
                    </FieldLabel>
                    <RowControl>
                      <div className="flex items-center gap-2">
                        <Input
                          {...field}
                          id={`${ids}-amount`}
                          aria-invalid={fieldState.invalid}
                          className="w-40 font-condensed text-[15px] font-semibold tabular-nums"
                          disabled={isSubmitting}
                          inputMode="decimal"
                        />
                        <span className="font-condensed text-[14px] font-semibold tracking-[0.04em] text-muted-foreground">
                          {payment.currency.toUpperCase()}
                        </span>
                      </div>
                      <FieldError className={ERROR} errors={[fieldState.error]} />
                    </RowControl>
                  </Field>
                )}
              />

              <Controller
                control={form.control}
                name="paymentType"
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid} className={ROW}>
                    <FieldLabel htmlFor={`${ids}-type`} className={ROW_LABEL}>
                      Payment type
                    </FieldLabel>
                    <RowControl>
                      <Select disabled={isSubmitting} onValueChange={field.onChange} value={field.value}>
                        <SelectTrigger id={`${ids}-type`} aria-invalid={fieldState.invalid} className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {Object.entries(PAYMENT_TYPE_LABELS).map(([value, label]) => (
                              <SelectItem key={value} value={value}>
                                {label}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                      <FieldError className={ERROR} errors={[fieldState.error]} />
                    </RowControl>
                  </Field>
                )}
              />

              <Controller
                control={form.control}
                name="programId"
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid} className={ROW}>
                    <FieldLabel htmlFor={`${ids}-program`} className={ROW_LABEL}>
                      Program
                    </FieldLabel>
                    <RowControl>
                      <Select
                        disabled={isSubmitting || programs === undefined}
                        onValueChange={field.onChange}
                        value={field.value}
                      >
                        <SelectTrigger id={`${ids}-program`} aria-invalid={fieldState.invalid} className="w-full">
                          <SelectValue placeholder="Select a program" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {currentProgramMissing ? (
                              <SelectItem value={payment.programId}>Current: {payment.programName}</SelectItem>
                            ) : null}
                            {(programs ?? []).map((program) => (
                              <SelectItem key={program._id} value={program._id}>
                                {program.name}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                      <FieldDescription className="text-[13px]">
                        Archived programs can&apos;t be chosen for a correction.
                      </FieldDescription>
                      <FieldError className={ERROR} errors={[fieldState.error]} />
                    </RowControl>
                  </Field>
                )}
              />

              <Controller
                control={form.control}
                name="referenceCode"
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid} className={ROW}>
                    <FieldLabel htmlFor={`${ids}-reference`} className={ROW_LABEL}>
                      Reference code
                    </FieldLabel>
                    <RowControl>
                      <Input
                        {...field}
                        id={`${ids}-reference`}
                        aria-invalid={fieldState.invalid}
                        className="font-mono text-[13px]"
                        disabled={isSubmitting}
                        spellCheck={false}
                      />
                      <FieldError className={ERROR} errors={[fieldState.error]} />
                    </RowControl>
                  </Field>
                )}
              />

              <Controller
                control={form.control}
                name="note"
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid} className={ROW}>
                    <FieldLabel htmlFor={`${ids}-note`} className={ROW_LABEL}>
                      Internal note
                    </FieldLabel>
                    <RowControl>
                      <Input {...field} id={`${ids}-note`} aria-invalid={fieldState.invalid} disabled={isSubmitting} />
                      <FieldError className={ERROR} errors={[fieldState.error]} />
                    </RowControl>
                  </Field>
                )}
              />

              <Controller
                control={form.control}
                name="reason"
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid} className={ROW}>
                    <FieldLabel htmlFor={`${ids}-reason`} className={ROW_LABEL}>
                      Reason
                    </FieldLabel>
                    <RowControl>
                      <Textarea
                        {...field}
                        id={`${ids}-reason`}
                        aria-invalid={fieldState.invalid}
                        aria-required
                        disabled={isSubmitting}
                        placeholder="Why this payment needs a correction"
                        rows={3}
                      />
                      <FieldError className={ERROR} errors={[fieldState.error]} />
                    </RowControl>
                  </Field>
                )}
              />
            </FieldGroup>

            <div className="flex flex-wrap items-center justify-end gap-2 border-t bg-background px-4 py-3">
              <Button disabled={isSubmitting} onClick={() => onOpenChange(false)} type="button" variant="outline">
                Cancel
              </Button>
              <Button disabled={isSubmitting} type="submit" className="font-semibold">
                {isSubmitting ? <Spinner data-icon="inline-start" /> : null}
                {isSubmitting ? "Saving…" : "Save correction"}
              </Button>
            </div>
          </form>
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
