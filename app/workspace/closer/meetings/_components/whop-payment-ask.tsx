"use client";

import { useId, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatAmountMinor } from "@/lib/format-currency";
import { reportClientError } from "@/lib/observability/report-client-error";
import { NO_SHOW_REASONS, type NoShowReason } from "@/lib/callInsights/taxonomy";
import {
  ACTION_DIALOG,
  ACTION_FORM,
  ActionDialogFooter,
  ActionDialogHeader,
  CancelButton,
  DialogNote,
  FACT_FIGURE,
  FormRow,
  FormRows,
  RecordFact,
  RecordFacts,
  SubmitButton,
  SubmitError,
  WhatHappens,
} from "@/app/workspace/_components/action-dialog";
import {
  PAYMENT_TYPES,
  PAYMENT_TYPE_LABELS,
  type PaymentTypeValue,
} from "@/app/workspace/_components/payment-dialog-form";
import type { ProviderIntent } from "@/app/workspace/_components/payments/whop-payment-check";
import {
  paymentCommandSentence,
  paymentErrorSentence,
  thrownPaymentCode,
} from "@/app/workspace/_components/payments/payment-command-words";
import { ProgramSelect } from "@/app/workspace/closer/_components/program-select";
import { NO_SHOW_REASON_LABELS, useDayTime } from "./attendance-question";

// "Whop payment found": a Whop payment waiting for the closer to confirm it
// (`payments.confirm.getWhopAsk`). The meeting page offers "Record payment ·
// call attended" (the payment dialog's `logPayment` save with the confirm
// intent) and "Record payment · they didn't attend"
// (`payments.confirm.confirmWhopPaymentNoShow`); the reminder page offers one
// Record payment (`logReminderPayment` with the same intent).

export type WhopAsk = NonNullable<FunctionReturnType<typeof api.payments.confirm.getWhopAsk>>;
type ReadyPreview = Extract<WhopAsk["preview"], { ok: true }>;

/** What a payment dialog needs to open filled from the ask and save with the confirm intent. */
export type WhopConfirmPrefill = {
  intent: Extract<ProviderIntent, { kind: "confirm" }>;
  /** The preview's fingerprint, for `confirmWhopPaymentNoShow`. */
  fingerprint: string;
  amountMinor: number;
  currency: string;
  programId?: Id<"tenantPrograms">;
  paymentType?: PaymentTypeValue;
  collectedAt: number | null;
};

/** The ask's preview, when it is one that can be recorded. */
export function readyPreview(ask: WhopAsk | null | undefined): ReadyPreview | null {
  return ask && ask.preview.ok ? ask.preview : null;
}

export function whopConfirmPrefill(ask: WhopAsk): WhopConfirmPrefill | null {
  const preview = readyPreview(ask);
  if (!preview) return null;
  return {
    intent: {
      kind: "confirm",
      providerPaymentId: ask.providerPaymentId,
      expectedAllocationRevision: preview.allocationRevision,
      decisionId: ask.decisionId,
    },
    fingerprint: preview.fingerprint,
    amountMinor: preview.proposal.amountMinor,
    currency: preview.proposal.currency,
    programId: preview.proposal.programId,
    paymentType: preview.proposal.paymentType,
    collectedAt: ask.paidAt,
  };
}

/** "Deposit · Program A", or what the mapping leaves to pick. */
function useMappedTo(programId: Id<"tenantPrograms"> | undefined, paymentType: PaymentTypeValue | undefined) {
  const programs = useQuery(api.tenantPrograms.queries.listPrograms, { includeArchived: true });
  const programName = programId ? programs?.find((program) => program._id === programId)?.name : undefined;
  const parts = [paymentType ? PAYMENT_TYPE_LABELS[paymentType] : null, programName ?? null].filter(Boolean);
  if (!programId && !paymentType) return "Not mapped. You pick the program and type.";
  if (!programId) return `${parts.join(" · ")} · you pick the program`;
  if (!paymentType) return `${parts.join(" · ") || "Mapped program"} · you pick the type`;
  return parts.length === 2 ? parts.join(" · ") : null;
}

const LABEL =
  "font-condensed text-[11px] leading-[1.2] font-semibold tracking-[0.14em] text-muted-foreground uppercase";

/**
 * The card: a lime rule on a lime tint, as the confirmed suggestion is.
 * AMOUNT, COLLECTED and MAPPED TO, what recording does, then `actions`.
 */
export function WhopPaymentFoundCard({
  ask,
  sentence,
  actions,
}: {
  ask: WhopAsk;
  sentence: string;
  actions: React.ReactNode;
}) {
  const headingId = useId();
  const dayTime = useDayTime();
  const preview = readyPreview(ask);
  const mappedTo = useMappedTo(preview?.proposal.programId, preview?.proposal.paymentType);
  if (!preview) return null;
  const { amountMinor, currency } = preview.proposal;
  const product = [ask.productTitle, ask.variantTitle].filter(Boolean).join(" · ");

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-[var(--radius)] border border-l-[3px] border-l-primary bg-[color-mix(in_srgb,var(--primary)_7%,var(--card))] px-4 py-3.5"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 id={headingId} className="text-[1.0625rem] leading-snug font-semibold">
          Whop payment found
        </h2>
        <span className="inline-flex h-5 items-center rounded bg-warning-surface px-1.5 font-condensed text-[0.6875rem] font-bold tracking-[0.1em] text-warning-ink uppercase">
          Ask
        </span>
      </div>
      {product ? <p className="text-[0.8125rem] text-muted-foreground" translate="no">{product}</p> : null}
      <dl className="grid gap-x-4 gap-y-2.5 @md:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <dt className={LABEL}>Amount</dt>
          <dd className="font-condensed text-lg leading-tight font-semibold tabular-nums">
            {formatAmountMinor(amountMinor, currency)}
          </dd>
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <dt className={LABEL}>Collected</dt>
          <dd className="text-sm tabular-nums">
            {ask.paidAt !== null ? `${dayTime(ask.paidAt)}, by Whop` : "Collection time unavailable"}
          </dd>
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <dt className={LABEL}>Mapped to</dt>
          <dd className="text-sm break-words" translate="no">
            {mappedTo ?? "—"}
          </dd>
        </div>
      </dl>
      <p className="text-[0.8125rem] leading-[1.45] text-muted-foreground text-pretty">{sentence}</p>
      <div className="flex flex-wrap gap-2">{actions}</div>
    </section>
  );
}

const MEETING_SENTENCE =
  "Recording it closes the deal as won. The form is already filled from Whop and your product mapping, and no proof file is needed: the Whop payment is the proof. The two buttons differ only in what they record about the call.";
export const REMINDER_SENTENCE =
  "Recording it closes the deal as won and completes this reminder. The form is already filled from Whop and your product mapping, and no proof file is needed: the Whop payment is the proof.";

/**
 * The meeting page's ask: the card with Record payment · call attended
 * (`onRecordAttended` opens the payment dialog filled from the ask) and
 * Record payment · they didn't attend (its own dialog, below).
 */
export function MeetingWhopAsk({
  ask,
  meetingId,
  leadName,
  onRecordAttended,
  onRecorded,
}: {
  ask: WhopAsk;
  meetingId: Id<"meetings">;
  leadName: string | null;
  onRecordAttended: () => void;
  onRecorded?: () => Promise<void>;
}) {
  const [noShowOpen, setNoShowOpen] = useState(false);
  const prefill = whopConfirmPrefill(ask);
  if (!prefill) return null;
  return (
    <>
      <WhopPaymentFoundCard
        ask={ask}
        sentence={MEETING_SENTENCE}
        actions={
          <>
            <Button type="button" className="font-semibold" onClick={onRecordAttended}>
              Record payment · call attended
            </Button>
            <Button type="button" variant="outline" onClick={() => setNoShowOpen(true)}>
              Record payment · they didn&rsquo;t attend
            </Button>
          </>
        }
      />
      <WhopNoShowDialog
        open={noShowOpen}
        onOpenChange={setNoShowOpen}
        meetingId={meetingId}
        prefill={prefill}
        leadName={leadName}
        onRecorded={onRecorded}
      />
    </>
  );
}

// ─── The form inside a payment dialog ────────────────────────────────────────

const confirmSchema = z.object({
  programId: z.string().min(1, "Pick the program"),
  paymentType: z.enum(PAYMENT_TYPES, { error: "Pick the payment type" }),
});
type ConfirmValues = z.infer<typeof confirmSchema>;
export type WhopConfirmChoice = { programId: Id<"tenantPrograms">; paymentType: PaymentTypeValue };

/** Refusals the person can fix in the form; any other one closes the dialog so the ask reloads. */
const FIXABLE = new Set(["program_required"]);

/**
 * The payment dialog's body when it opens from a Whop ask: the amount and
 * collection time fixed from Whop, the program and type filled from the
 * mapping (changeable), no proof field, what recording does, and Record.
 * `save` runs the dialog's own mutation with the confirm intent; a refusal
 * shows its sentence and, unless the form can fix it, closes the dialog so
 * the ask on the page reloads.
 */
export function WhopConfirmForm({
  prefill,
  leadName,
  steps,
  save,
  onClose,
}: {
  prefill: WhopConfirmPrefill;
  leadName: string | null;
  steps: React.ReactNode[];
  save: (choice: WhopConfirmChoice) => Promise<void>;
  onClose: () => void;
}) {
  const ids = useId();
  const dayTime = useDayTime();
  const [pending, setPending] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const amountLabel = formatAmountMinor(prefill.amountMinor, prefill.currency);
  const form = useForm({
    resolver: standardSchemaResolver(confirmSchema),
    defaultValues: {
      programId: String(prefill.programId ?? ""),
      paymentType: prefill.paymentType as ConfirmValues["paymentType"],
    },
  });

  const onSubmit = async (values: ConfirmValues) => {
    setPending(true);
    setSubmitError(null);
    try {
      await save({ programId: values.programId as Id<"tenantPrograms">, paymentType: values.paymentType });
    } catch (error) {
      const code = thrownPaymentCode(error);
      const sentence = paymentErrorSentence(error, "The payment wasn't recorded. Please try again.");
      if (code && !FIXABLE.has(code)) {
        toast.error(sentence);
        onClose();
        return;
      }
      if (!code) reportClientError(error, { flow: "whop_confirm_payment" });
      setSubmitError(sentence);
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <ActionDialogHeader
        title={leadName ? `Record ${leadName}’s ${amountLabel} payment from Whop` : `Record the ${amountLabel} payment from Whop`}
        description="Filled from Whop and your product mapping. No proof file is needed: the Whop payment is the proof."
      />
      <SubmitError>{submitError}</SubmitError>
      <form className={ACTION_FORM} onSubmit={form.handleSubmit(onSubmit)}>
        <RecordFacts>
          <RecordFact label="Amount">
            <span className={FACT_FIGURE}>{amountLabel}</span>{" "}
            <span className="font-condensed text-[13px] font-semibold tracking-[0.04em] text-muted-foreground">
              {prefill.currency}
            </span>
          </RecordFact>
          <RecordFact label="Collected">
            {prefill.collectedAt !== null ? `${dayTime(prefill.collectedAt)}, by Whop` : "Collection time unavailable"}
          </RecordFact>
          <RecordFact label="Proof">The Whop payment</RecordFact>
        </RecordFacts>
        <FormRows>
          <Controller
            control={form.control}
            name="programId"
            render={({ field, fieldState }) => (
              <FormRow
                label="Program"
                invalid={fieldState.invalid}
                error={fieldState.error}
                description={prefill.programId ? "From your Whop product mapping." : undefined}
              >
                <ProgramSelect
                  value={field.value || undefined}
                  onChange={field.onChange}
                  disabled={pending}
                  className="w-full"
                />
              </FormRow>
            )}
          />
          <Controller
            control={form.control}
            name="paymentType"
            render={({ field, fieldState }) => (
              <FormRow
                label="Payment type"
                htmlFor={`${ids}-type`}
                invalid={fieldState.invalid}
                error={fieldState.error}
              >
                <Select value={field.value ?? ""} onValueChange={field.onChange} disabled={pending}>
                  <SelectTrigger id={`${ids}-type`} aria-invalid={fieldState.invalid} className="w-full">
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
        </FormRows>
        <WhatHappens steps={steps} />
        <ActionDialogFooter>
          <CancelButton onClick={onClose} disabled={pending} />
          <SubmitButton pending={pending} pendingLabel="Recording…">
            Record {amountLabel} payment
          </SubmitButton>
        </ActionDialogFooter>
      </form>
    </>
  );
}

// ─── Record payment · they didn't attend ─────────────────────────────────────

const noShowSchema = confirmSchema.extend({
  reason: z.enum(NO_SHOW_REASONS, { error: "Pick a reason" }),
});
type NoShowValues = z.infer<typeof noShowSchema>;

/**
 * The Whop payment wins the deal and the call is recorded as a no-show, in
 * one save (`confirmWhopPaymentNoShow`). It asks for the reason, and for the
 * program and type when the mapping left them out.
 */
function WhopNoShowDialog({
  open,
  onOpenChange,
  meetingId,
  prefill,
  leadName,
  onRecorded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  meetingId: Id<"meetings">;
  prefill: WhopConfirmPrefill;
  leadName: string | null;
  onRecorded?: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!pending) onOpenChange(value);
      }}
    >
      <DialogContent className={ACTION_DIALOG} showCloseButton={!pending}>
        {open ? (
          <WhopNoShowForm
            meetingId={meetingId}
            prefill={prefill}
            leadName={leadName}
            pending={pending}
            setPending={setPending}
            onClose={() => onOpenChange(false)}
            onRecorded={onRecorded}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function WhopNoShowForm({
  meetingId,
  prefill,
  leadName,
  pending,
  setPending,
  onClose,
  onRecorded,
}: {
  meetingId: Id<"meetings">;
  prefill: WhopConfirmPrefill;
  leadName: string | null;
  pending: boolean;
  setPending: (pending: boolean) => void;
  onClose: () => void;
  onRecorded?: () => Promise<void>;
}) {
  const ids = useId();
  const dayTime = useDayTime();
  const confirmNoShow = useMutation(api.payments.confirm.confirmWhopPaymentNoShow);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const amountLabel = formatAmountMinor(prefill.amountMinor, prefill.currency);
  const form = useForm({
    resolver: standardSchemaResolver(noShowSchema),
    defaultValues: {
      programId: String(prefill.programId ?? ""),
      paymentType: prefill.paymentType as NoShowValues["paymentType"],
      reason: undefined,
    },
  });
  const firstName = leadName?.trim().split(/\s+/)[0] || "the lead";

  const onSubmit = async (values: NoShowValues) => {
    setPending(true);
    setSubmitError(null);
    try {
      const result = await confirmNoShow({
        meetingId,
        providerPaymentId: prefill.intent.providerPaymentId,
        decisionId: prefill.intent.decisionId,
        amountMinor: prefill.amountMinor,
        currency: prefill.currency,
        programId: values.programId as Id<"tenantPrograms">,
        paymentType: values.paymentType,
        noShowReason: values.reason,
        expectedFingerprint: prefill.fingerprint,
        expectedAllocationRevision: prefill.intent.expectedAllocationRevision,
      });
      if (!result.ok) {
        const sentence = paymentCommandSentence(result.code);
        if (FIXABLE.has(result.code)) {
          setSubmitError(sentence);
          return;
        }
        toast.error(sentence);
        onClose();
        return;
      }
      toast.success(
        result.alreadyApplied
          ? "This payment was already recorded. Nothing else changed."
          : "Payment recorded and the call marked as a no-show. The deal is won.",
      );
      onClose();
      await onRecorded?.();
    } catch (error) {
      reportClientError(error, { flow: "whop_confirm_no_show" });
      setSubmitError(paymentErrorSentence(error, "The payment wasn't recorded. Please try again."));
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <ActionDialogHeader
        title={leadName ? `Record ${leadName}’s ${amountLabel} payment from Whop` : `Record the ${amountLabel} payment from Whop`}
        description={`${firstName} paid but didn't attend the call. No proof file is needed: the Whop payment is the proof.`}
      />
      <SubmitError>{submitError}</SubmitError>
      <form className={ACTION_FORM} onSubmit={form.handleSubmit(onSubmit)}>
        <RecordFacts>
          <RecordFact label="Amount">
            <span className={FACT_FIGURE}>{amountLabel}</span>{" "}
            <span className="font-condensed text-[13px] font-semibold tracking-[0.04em] text-muted-foreground">
              {prefill.currency}
            </span>
          </RecordFact>
          <RecordFact label="Collected">
            {prefill.collectedAt !== null ? `${dayTime(prefill.collectedAt)}, by Whop` : "Collection time unavailable"}
          </RecordFact>
        </RecordFacts>
        <FormRows>
          <Controller
            control={form.control}
            name="reason"
            render={({ field, fieldState }) => (
              <FormRow label="Reason" htmlFor={`${ids}-reason`} invalid={fieldState.invalid} error={fieldState.error}>
                <Select value={field.value ?? ""} onValueChange={field.onChange} disabled={pending}>
                  <SelectTrigger id={`${ids}-reason`} aria-invalid={fieldState.invalid} className="w-full">
                    <SelectValue placeholder="Pick a reason" />
                  </SelectTrigger>
                  <SelectContent>
                    {NO_SHOW_REASONS.map((value) => (
                      <SelectItem key={value} value={value}>
                        {NO_SHOW_REASON_LABELS[value as NoShowReason]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormRow>
            )}
          />
          <Controller
            control={form.control}
            name="programId"
            render={({ field, fieldState }) => (
              <FormRow label="Program" invalid={fieldState.invalid} error={fieldState.error}>
                <ProgramSelect
                  value={field.value || undefined}
                  onChange={field.onChange}
                  disabled={pending}
                  className="w-full"
                />
              </FormRow>
            )}
          />
          <Controller
            control={form.control}
            name="paymentType"
            render={({ field, fieldState }) => (
              <FormRow
                label="Payment type"
                htmlFor={`${ids}-type`}
                invalid={fieldState.invalid}
                error={fieldState.error}
              >
                <Select value={field.value ?? ""} onValueChange={field.onChange} disabled={pending}>
                  <SelectTrigger id={`${ids}-type`} aria-invalid={fieldState.invalid} className="w-full">
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
        </FormRows>
        <DialogNote>The call is recorded as a no-show. It doesn&rsquo;t change the win.</DialogNote>
        <WhatHappens
          steps={[
            "Records the Whop payment, credited to the deal’s closer.",
            "Closes the deal as won.",
            "Marks the call a no-show, with your reason.",
          ]}
        />
        <ActionDialogFooter>
          <CancelButton onClick={onClose} disabled={pending} />
          <SubmitButton pending={pending} pendingLabel="Recording…">
            Record {amountLabel} payment
          </SubmitButton>
        </ActionDialogFooter>
      </form>
    </>
  );
}
