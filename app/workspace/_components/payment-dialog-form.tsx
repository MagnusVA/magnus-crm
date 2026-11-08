"use client";

import { useEffect, useId, useRef, useState, type FormEventHandler, type ReactNode } from "react";
import { Controller, useFormContext, useWatch } from "react-hook-form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ProgramSelect } from "@/app/workspace/closer/_components/program-select";
import { ProofFileInput } from "@/app/workspace/closer/meetings/_components/proof-file-input";
import { formatAmountMinor } from "@/lib/format-currency";
import {
  ACTION_FORM,
  ActionDialogFooter,
  CancelButton,
  FACT_FIGURE,
  FormRow,
  FormRows,
  RecordFact,
  RecordFacts,
  SubmitButton,
  SubmitError,
  WhatHappens,
} from "./action-dialog";

// The body the four payment dialogs share (the meeting page, the task page, and
// the deal modal's additional and side-deal payments): the form rows, then a
// confirm step with the facts and what recording does. Each dialog keeps its
// own schema, mutation, upload, toast and analytics.

export const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "JPY"] as const;
export type PaymentCurrency = (typeof CURRENCIES)[number];
export const PAYMENT_TYPES = ["monthly", "split", "pif", "deposit"] as const;
export type PaymentTypeValue = (typeof PAYMENT_TYPES)[number];
export const PAYMENT_TYPE_LABELS: Record<PaymentTypeValue, string> = {
  monthly: "Monthly",
  split: "Split",
  pif: "Paid in Full",
  deposit: "Deposit",
};

/** Max proof file size: 10 MB (the server enforces it too). */
export const MAX_PROOF_FILE_SIZE = 10 * 1024 * 1024;
export const PROOF_FILE_TYPES = ["image/jpeg", "image/png", "image/gif", "application/pdf"];

/** The fields the shared rows read. Each dialog's own schema holds the rules and messages. */
type PaymentRowFields = {
  amount: string;
  currency: PaymentCurrency;
  programId?: string;
  paymentType?: PaymentTypeValue;
  proofFile?: File;
};

/** The program row: chosen from the active programs, or fixed by the deal. */
export type PaymentProgramRow =
  | { kind: "choose"; description: ReactNode; disabled?: boolean }
  | { kind: "fixed"; name: string | null; description: ReactNode };

/**
 * The values waiting on the confirm step, or null on the form step. Each
 * opening of the dialog starts on the form.
 */
export function useConfirmStep<Values>(open: boolean) {
  const [values, setValues] = useState<Values | null>(null);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setValues(null);
  }
  return [values, setValues] as const;
}

/** "$1,500.00": the typed amount in its currency, as the confirm step names it. */
export function formatPaymentAmount(amount: string, currency: string) {
  return formatAmountMinor(Math.round(Number(amount) * 100), currency);
}

/**
 * The form step: amount and currency on one row, program, payment type and
 * proof file, then any rows the dialog adds (`children`). Wrap it in
 * react-hook-form's `FormProvider`. Its button only validates; the confirm
 * step records. `proofRequired` (closers, `useProofRequired`) drops
 * "Optional" from the proof row; the dialog checks the file before it
 * confirms, and the payment mutations enforce it.
 */
export function PaymentFormStep({
  onSubmit,
  onCancel,
  program,
  submitDisabled,
  proofRequired = false,
  children,
}: {
  onSubmit: FormEventHandler<HTMLFormElement>;
  onCancel: () => void;
  program: PaymentProgramRow;
  submitDisabled?: boolean;
  proofRequired?: boolean;
  children?: ReactNode;
}) {
  const ids = useId();
  const { control } = useFormContext<PaymentRowFields>();
  // The picker shows this, not the Controller's value. After Back remounts the
  // rows, react-hook-form's Controller falls back to the file it mounted with
  // once the value is cleared, so a removed file would stay on screen.
  const proofFile = useWatch({ control, name: "proofFile" });

  return (
    <form className={ACTION_FORM} onSubmit={onSubmit}>
      <FormRows>
        <Controller
          control={control}
          name="amount"
          render={({ field, fieldState }) => (
            <FormRow label="Amount" htmlFor={`${ids}-amount`} invalid={fieldState.invalid} error={fieldState.error}>
              <div className="flex items-center gap-2">
                <Input
                  {...field}
                  id={`${ids}-amount`}
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0"
                  placeholder="299.99"
                  autoComplete="off"
                  aria-invalid={fieldState.invalid}
                  aria-required
                  className="w-40 [appearance:textfield] font-condensed text-[15px] font-semibold tabular-nums placeholder:font-normal [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                />
                <Controller
                  control={control}
                  name="currency"
                  render={({ field: currency }) => (
                    <Select value={currency.value} onValueChange={currency.onChange}>
                      <SelectTrigger
                        aria-label="Currency"
                        className="w-24 font-condensed text-[14px] font-semibold tracking-[0.04em]"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {CURRENCIES.map((code) => (
                            <SelectItem key={code} value={code}>
                              {code}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>
            </FormRow>
          )}
        />

        {program.kind === "choose" ? (
          <Controller
            control={control}
            name="programId"
            render={({ field, fieldState }) => (
              <FormRow
                label="Program"
                invalid={fieldState.invalid}
                error={fieldState.error}
                description={program.description}
              >
                <ProgramSelect
                  value={field.value || undefined}
                  onChange={field.onChange}
                  disabled={program.disabled}
                  className="w-full"
                />
              </FormRow>
            )}
          />
        ) : (
          <FormRow label="Program" description={program.description}>
            <p className="flex min-h-8 items-center text-sm" translate="no">
              {program.name ?? "—"}
            </p>
          </FormRow>
        )}

        <Controller
          control={control}
          name="paymentType"
          render={({ field, fieldState }) => (
            <FormRow
              label="Payment type"
              htmlFor={`${ids}-type`}
              invalid={fieldState.invalid}
              error={fieldState.error}
            >
              <Select value={field.value ?? ""} onValueChange={field.onChange}>
                <SelectTrigger
                  id={`${ids}-type`}
                  aria-invalid={fieldState.invalid}
                  aria-required
                  className="w-full"
                  onBlur={field.onBlur}
                >
                  <SelectValue placeholder="Select payment type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {PAYMENT_TYPES.map((type) => (
                      <SelectItem key={type} value={type}>
                        {PAYMENT_TYPE_LABELS[type]}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </FormRow>
          )}
        />

        <Controller
          control={control}
          name="proofFile"
          render={({ field: { onChange, onBlur, name }, fieldState }) => (
            <FormRow
              label="Proof file"
              htmlFor={`${ids}-proof`}
              invalid={fieldState.invalid}
              error={fieldState.error}
              description={
                proofRequired
                  ? "A receipt or screenshot of the payment. PNG, JPEG, GIF or PDF, up to 10 MB."
                  : "Optional. PNG, JPEG, GIF or PDF, up to 10 MB."
              }
            >
              <ProofFileInput
                id={`${ids}-proof`}
                value={proofFile}
                onChange={onChange}
                onBlur={onBlur}
                name={name}
                accept={PROOF_FILE_TYPES.join(",")}
                aria-invalid={fieldState.invalid}
              />
            </FormRow>
          )}
        />

        {children}
      </FormRows>

      <ActionDialogFooter>
        <CancelButton onClick={onCancel} />
        <SubmitButton pending={false} pendingLabel="Checking…" disabled={submitDisabled}>
          Review payment
        </SubmitButton>
      </ActionDialogFooter>
    </form>
  );
}

/**
 * The confirm step: the payment's facts and what recording does, then Back
 * and "Record $1,500.00 payment". Only its button calls the mutation.
 */
export function PaymentConfirmStep({
  amount,
  currency,
  programName,
  paymentType,
  proofFile,
  extraFacts,
  steps,
  submitError,
  pending,
  onBack,
  onConfirm,
}: {
  /** The typed amount, as the form holds it. */
  amount: string;
  currency: string;
  programName: string | null;
  paymentType: PaymentTypeValue;
  proofFile?: File;
  /** Facts only this dialog collects (a Fathom link, a note). */
  extraFacts?: ReactNode;
  /** What recording does, in the order the server does it. */
  steps: ReactNode[];
  submitError: string | null;
  pending: boolean;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  // The form's button unmounts with the form; keep focus inside the dialog.
  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  return (
    <div ref={rootRef} tabIndex={-1} className="flex min-h-0 flex-col outline-none">
      <SubmitError>{submitError}</SubmitError>
      <RecordFacts>
        <RecordFact label="Amount">
          <span className={FACT_FIGURE}>{formatPaymentAmount(amount, currency)}</span>{" "}
          <span className="font-condensed text-[13px] font-semibold tracking-[0.04em] text-muted-foreground">
            {currency}
          </span>
        </RecordFact>
        <RecordFact label="Program">
          <span translate="no">{programName ?? "—"}</span>
        </RecordFact>
        <RecordFact label="Payment type">{PAYMENT_TYPE_LABELS[paymentType]}</RecordFact>
        <RecordFact label="Proof file">
          {proofFile ? (
            <span className="break-all">{proofFile.name}</span>
          ) : (
            <span className="text-muted-foreground">None</span>
          )}
        </RecordFact>
        {extraFacts}
      </RecordFacts>
      <WhatHappens steps={steps} />
      <ActionDialogFooter>
        <CancelButton onClick={onBack} disabled={pending}>
          Back
        </CancelButton>
        <SubmitButton type="button" onClick={onConfirm} pending={pending} pendingLabel="Recording…">
          Record {formatPaymentAmount(amount, currency)} payment
        </SubmitButton>
      </ActionDialogFooter>
    </div>
  );
}
