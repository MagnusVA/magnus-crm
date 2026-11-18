"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import { TranslatableText } from "@/components/translatable-text";
import { formatAmountMinor } from "@/lib/format-currency";
import { cn } from "@/lib/utils";
import {
  ActionDialogFooter,
  CancelButton,
  DialogNote,
  FACT_FIGURE,
  FIELD_ERROR,
  FormRow,
  RecordFact,
  RecordFacts,
  SubmitError,
} from "@/app/workspace/_components/action-dialog";
import {
  MAX_PROOF_FILE_SIZE,
  PAYMENT_TYPE_LABELS,
  PROOF_FILE_TYPES,
  type PaymentTypeValue,
} from "@/app/workspace/_components/payment-dialog-form";
import { formatPaidAt, formatPaidClock } from "@/app/workspace/billing/_components/billing-format";
import { ProofFileInput } from "@/app/workspace/closer/meetings/_components/proof-file-input";
import {
  differentMoneyIntent,
  paymentPins,
  proofNeedFor,
  type ProofNeed,
  type WhopAnswer,
  type WhopConflict,
} from "./whop-payment-check";

// "Whop payment found": the step a payment dialog shows before it saves when
// the tenant's Whop account already reports a payment for this person
// (docs: the call-results plan, "The payment dialog when Whop already has the
// money"). It never decides for the person: nothing is preselected, and each
// answer is a button or a radio they pick. It returns the `provider` intent
// through `onAnswer`; the dialog saves.

/** What the person typed on the form. */
export type WhopTyped = {
  amountMinor: number;
  currency: string;
  paymentType?: PaymentTypeValue;
  programName?: string | null;
};

export type WhopPaymentFoundStepProps = {
  /** The Whop payments to ask about: the pre-check's, or the server's on a refused save. Never empty. */
  conflicts: WhopConflict[];
  typed: WhopTyped;
  /** Named in the heading. */
  personName?: string | null;
  /** "dialog" renders the dialog's title; "page" a section with its own heading (the pay page). */
  variant?: "dialog" | "page";
  /** The meeting dialog: attaching to a recorded payment also marks the call attended. */
  marksAttendance?: boolean;
  /**
   * `newMoney`: the dialog's proof rule for a new payment today.
   * `roleNeedsProof`: the closer rule, which still applies to a link when the amounts differ.
   */
  proofRules: { newMoney: boolean; roleNeedsProof: boolean };
  /** The dialog's proof file. Without it the step shows no proof row and the page asks for proof itself. */
  proof?: { file?: File; onChange: (file: File | undefined) => void };
  /** The server answered with a different set than the person saw. */
  notice?: string | null;
  /** A refused save, shown at the top and announced. */
  error?: string | null;
  /** A save is running (an attach saves from the step). */
  pending?: boolean;
  onAnswer: (answer: WhopAnswer) => void;
  /** Back to the form. Left out on the pay page. */
  onBack?: () => void;
  /**
   * Move focus to the heading when the step appears (default). The pay page
   * turns it off when the pre-check, not the person, brought the step in.
   */
  autoFocus?: boolean;
};

type View =
  | { kind: "one"; conflict: Recorded }
  | { kind: "here"; conflict: Recorded }
  | { kind: "elsewhere" }
  | { kind: "several" }
  | { kind: "read_limit" };

type Recorded = Exclude<WhopConflict, { state: "read_limit" }>;

function viewOf(conflicts: WhopConflict[]): View {
  if (conflicts.some((conflict) => conflict.state === "read_limit")) return { kind: "read_limit" };
  if (conflicts.every((conflict) => conflict.state === "recorded_elsewhere")) return { kind: "elsewhere" };
  if (conflicts.length === 1) {
    const [conflict] = conflicts;
    if (conflict.state === "unlinked") return { kind: "one", conflict };
    if (conflict.state === "recorded_here") return { kind: "here", conflict };
  }
  return { kind: "several" };
}

function sameDay(at: number, now: number) {
  return new Date(at).toDateString() === new Date(now).toDateString();
}

/** "collected today 2:32 PM", or "collected Nov 3, 4:12 PM", in the viewer's time zone. */
function collected(paidAt: number | undefined, now: number) {
  if (paidAt === undefined) return "collection time not reported";
  return sameDay(paidAt, now) ? `collected today ${formatPaidClock(paidAt)}` : `collected ${formatPaidAt(paidAt, now)}`;
}

function whopAmount(conflict: Recorded) {
  return conflict.totalMinor === undefined ? null : formatAmountMinor(conflict.totalMinor, conflict.currency);
}

function matches(conflict: Recorded, typed: WhopTyped) {
  return conflict.totalMinor === typed.amountMinor && conflict.currency === typed.currency;
}

type SameAnswer = Extract<WhopAnswer, { kind: "same_money" }>;

function sameAnswer(conflict: Recorded, typed: WhopTyped, otherConflicts: Recorded[] = []): SameAnswer {
  const amountsMatch = matches(conflict, typed);
  return {
    kind: "same_money",
    intent: {
      kind: "same_money",
      providerPaymentId: conflict.providerPaymentId,
      expectedAllocationRevision: conflict.allocationRevision,
      acknowledgeAmountDifference: !amountsMatch,
      ...(otherConflicts.length ? { otherPins: paymentPins(otherConflicts) } : {}),
    },
    existing: conflict.state === "recorded_here",
    amountsMatch,
  };
}

function proofProblem(file: File) {
  if (file.size > MAX_PROOF_FILE_SIZE) return "File size must be less than 10 MB";
  if (!PROOF_FILE_TYPES.includes(file.type)) return "Only images (JPEG, PNG, GIF) and PDFs are allowed";
  return null;
}

const DIFFERENT = "different";

/**
 * The step. Its states, by the conflicts it is given: one unlinked Whop
 * payment (Yes / No); several (a radio list and "None of these"); one already
 * recorded on this deal (attach proof); recorded on another deal (different
 * money only); a read limit (save as different money behind a confirmation).
 */
export function WhopPaymentFoundStep({
  conflicts,
  typed,
  personName,
  variant = "dialog",
  marksAttendance = false,
  proofRules,
  proof,
  notice,
  error,
  pending = false,
  onAnswer,
  onBack,
  autoFocus = true,
}: WhopPaymentFoundStepProps) {
  const ids = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [now] = useState(() => Date.now());
  const [selected, setSelected] = useState<string>("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [ackError, setAckError] = useState<string | null>(null);
  const [revealProof, setRevealProof] = useState(false);
  const [proofError, setProofError] = useState<string | null>(null);
  const [confirmingReadLimit, setConfirmingReadLimit] = useState(false);

  const view = viewOf(conflicts);
  const setKey = conflicts
    .map((conflict) => `${conflict.providerPaymentId ?? ""}:${conflict.allocationRevision ?? ""}:${conflict.state}`)
    .join("|");

  // A new set (the server's) starts the questions again; what was typed stays.
  const [shownKey, setShownKey] = useState(setKey);
  if (shownKey !== setKey) {
    setShownKey(setKey);
    setSelected("");
    setAcknowledged(false);
    setAckError(null);
    setRevealProof(false);
    setProofError(null);
    setConfirmingReadLimit(false);
  }

  // Focus the heading when the step appears, and again for a new set.
  useEffect(() => {
    if (autoFocus) headingRef.current?.focus();
  }, [setKey, autoFocus]);

  const firstName = personName?.trim().split(/\s+/)[0] || "this person";
  const recorded = conflicts.filter((conflict): conflict is Recorded => conflict.state !== "read_limit");
  const typedAmount = formatAmountMinor(typed.amountMinor, typed.currency);
  const rules = { ...proofRules, marksAttendance };
  const differentAnswer: WhopAnswer = { kind: "different_money", intent: differentMoneyIntent(conflicts) };

  // The answer the current choice would give, for the proof row and the amount line.
  const pickedConflict =
    view.kind === "one" || view.kind === "here"
      ? view.conflict
      : view.kind === "several"
        ? recorded.find((conflict) => conflict.providerPaymentId === selected)
        : undefined;
  const pickedSame = pickedConflict
    ? sameAnswer(pickedConflict, typed, recorded.filter((conflict) => conflict !== pickedConflict))
    : null;
  const pickedNeedsAck = pickedSame !== null && !pickedSame.existing && !pickedSame.amountsMatch;

  let upfrontNeed: ProofNeed | null = null;
  if (view.kind === "one" && pickedSame && !pickedSame.amountsMatch) upfrontNeed = proofNeedFor(pickedSame, rules);
  if (view.kind === "here" && pickedSame) upfrontNeed = proofNeedFor(pickedSame, rules);
  if (view.kind === "elsewhere" || view.kind === "read_limit") upfrontNeed = proofNeedFor(differentAnswer, rules);
  if (view.kind === "several" && selected) {
    upfrontNeed = proofNeedFor(selected === DIFFERENT ? differentAnswer : (pickedSame ?? differentAnswer), rules);
  }
  const showProofRow = Boolean(proof) && ((upfrontNeed !== null && upfrontNeed !== "waived") || revealProof);
  const proofOptional = upfrontNeed === "optional";
  const proofWaived =
    !proof?.file &&
    !revealProof &&
    pickedSame !== null &&
    !pickedSame.existing &&
    pickedSame.amountsMatch &&
    (view.kind === "one" || selected === pickedConflict?.providerPaymentId);

  const attempt = (answer: WhopAnswer) => {
    if (pending) return;
    if (answer.kind === "same_money" && !answer.existing && !answer.amountsMatch && !acknowledged) {
      setAckError("Tick the box to link them anyway, or say it’s different money.");
      return;
    }
    if (proof) {
      const need = proofNeedFor(answer, rules);
      if (need === "required" && !proof.file) {
        setRevealProof(true);
        setProofError(
          answer.kind === "different_money"
            ? "Attach proof: a separate payment needs its own."
            : answer.kind === "same_money" && answer.existing
              ? "Attach the proof file to add it to the payment."
              : "Attach proof: the amounts differ, so Whop’s payment can’t stand in for it.",
        );
        return;
      }
      if (proof.file) {
        const problem = proofProblem(proof.file);
        if (problem) {
          setRevealProof(true);
          setProofError(problem);
          return;
        }
      }
    }
    onAnswer(answer);
  };

  const heading =
    view.kind === "one"
      ? `Whop already reports a payment from ${firstName}`
      : view.kind === "several"
        ? `Whop already reports ${conflicts.length} payments from ${firstName}`
        : view.kind === "here"
          ? "This payment is already recorded from Whop"
          : view.kind === "elsewhere"
            ? conflicts.length === 1
              ? "Whop’s payment for this person is recorded on another deal"
              : "Whop’s payments for this person are recorded on other deals"
            : `Whop’s payments for ${firstName} couldn’t all be checked`;

  const description =
    view.kind === "read_limit"
      ? "There is too much history to check automatically. Check Billing before saving."
      : view.kind === "here"
        ? "The CRM already has a payment created from it on this deal."
        : view.kind === "elsewhere"
          ? "Only a different payment can be saved here."
          : "Say whether it’s the money you typed, so it counts once.";

  const typedLine = (
    <>
      <span className={FACT_FIGURE}>{typedAmount}</span>
      {typed.paymentType ? ` · ${PAYMENT_TYPE_LABELS[typed.paymentType].toLowerCase()}` : null}
      {typed.programName ? (
        <>
          {" · "}
          <span translate="no">{typed.programName}</span>
        </>
      ) : null}
    </>
  );

  const amountLine = (conflict: Recorded) => {
    const whop = whopAmount(conflict);
    return whop ? `Whop collected ${whop}. You typed ${typedAmount}.` : `Whop reported no amount. You typed ${typedAmount}.`;
  };

  const proofRow = showProofRow && proof ? (
    <FormRow
      label={proofOptional ? "Proof file (optional)" : "Proof file"}
      htmlFor={`${ids}-proof`}
      invalid={Boolean(proofError)}
      error={proofError ? { message: proofError } : undefined}
      description="A receipt or screenshot of the payment. PNG, JPEG, GIF or PDF, up to 10 MB."
      className="border-t"
    >
      <ProofFileInput
        id={`${ids}-proof`}
        value={proof.file}
        onChange={(file?: File) => {
          const problem = file ? proofProblem(file) : null;
          setProofError(problem);
          if (!problem) proof.onChange(file);
        }}
        accept={PROOF_FILE_TYPES.join(",")}
        aria-invalid={Boolean(proofError)}
        disabled={pending}
      />
    </FormRow>
  ) : null;

  const acknowledgement = (
    <div className="flex flex-col gap-1.5">
      <label className="flex items-start gap-2.5 text-sm" htmlFor={`${ids}-ack`}>
        <Checkbox
          id={`${ids}-ack`}
          className="mt-0.5"
          checked={acknowledged}
          disabled={pending}
          aria-invalid={Boolean(ackError)}
          aria-describedby={ackError ? `${ids}-ack-error` : undefined}
          onCheckedChange={(value) => {
            setAcknowledged(value === true);
            if (value === true) setAckError(null);
          }}
        />
        <span>Link them anyway. The amount I typed is kept.</span>
      </label>
      {ackError ? (
        <p id={`${ids}-ack-error`} role="alert" className={FIELD_ERROR}>
          {ackError}
        </p>
      ) : null}
    </div>
  );

  let body: ReactNode;
  if (view.kind === "one") {
    const { conflict } = view;
    const amountsMatch = matches(conflict, typed);
    body = (
      <>
        <RecordFacts>
          <RecordFact label="Whop">
            <span className={FACT_FIGURE}>{whopAmount(conflict) ?? "—"}</span> · {collected(conflict.paidAt, now)}
          </RecordFact>
          <RecordFact label="You typed">{typedLine}</RecordFact>
        </RecordFacts>
        <div className="flex flex-col gap-3 px-4 py-3">
          {amountsMatch ? null : <p className="text-[13px] leading-[1.45] font-medium text-warning-ink">{amountLine(conflict)}</p>}
          <p id={`${ids}-question`} className="text-sm font-medium">
            Is this the same money?
          </p>
          {amountsMatch ? null : acknowledgement}
          {proofWaived ? (
            <p className="text-[13px] leading-[1.45] text-muted-foreground">
              No proof file is needed: the Whop payment is the proof.
            </p>
          ) : null}
        </div>
        {proofRow}
        <div className="flex flex-col gap-2 border-t px-4 py-3 sm:flex-row">
          <Button type="button" disabled={pending} onClick={() => attempt(sameAnswer(conflict, typed))}>
            Yes, it’s that payment
          </Button>
          <Button type="button" variant="outline" disabled={pending} onClick={() => attempt(differentAnswer)}>
            No, this is different money
          </Button>
        </div>
        <p className="border-t px-4 py-2.5 text-[13px] leading-[1.45] text-muted-foreground">
          &ldquo;Yes&rdquo; links the two and records one payment. What you typed is kept.
        </p>
      </>
    );
  } else if (view.kind === "several") {
    const elsewhere = recorded.some((conflict) => conflict.state === "recorded_elsewhere");
    body = (
      <>
        <RecordFacts>
          <RecordFact label="You typed">{typedLine}</RecordFact>
        </RecordFacts>
        <div className="flex flex-col gap-3 px-4 py-3">
          <p id={`${ids}-question`} className="text-sm font-medium">
            Is one of these the money you typed?
          </p>
          <RadioGroup
            value={selected}
            onValueChange={(value) => {
              setSelected(value);
              setAcknowledged(false);
              setAckError(null);
              setRevealProof(false);
              setProofError(null);
            }}
            aria-labelledby={`${ids}-question`}
            disabled={pending}
            className="gap-0 rounded-md border"
          >
            {recorded.map((conflict, index) => {
              const itemId = `${ids}-option-${index}`;
              const disabled = conflict.state === "recorded_elsewhere";
              const product = [conflict.productTitle, conflict.variantTitle].filter(Boolean).join(" · ");
              return (
                <label
                  key={conflict.providerPaymentId}
                  htmlFor={itemId}
                  className={cn(
                    "flex items-start gap-3 border-b px-3 py-2.5 text-sm",
                    disabled ? "cursor-not-allowed text-muted-foreground" : "cursor-pointer",
                  )}
                >
                  <RadioGroupItem id={itemId} value={conflict.providerPaymentId} disabled={disabled} className="mt-0.5" />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span>
                      <span className={FACT_FIGURE}>{whopAmount(conflict) ?? "Amount not reported"}</span>
                      {" · "}
                      {collected(conflict.paidAt, now)}
                    </span>
                    {product ? (
                      <span translate="no" className="text-[13px] text-muted-foreground">{product}</span>
                    ) : null}
                    {conflict.state === "recorded_here" ? (
                      <span className="text-[13px] text-muted-foreground">Already recorded on this deal</span>
                    ) : conflict.state === "recorded_elsewhere" ? (
                      <span className="text-[13px]">Recorded on another deal</span>
                    ) : null}
                  </span>
                </label>
              );
            })}
            <label htmlFor={`${ids}-different`} className="flex cursor-pointer items-start gap-3 px-3 py-2.5 text-sm">
              <RadioGroupItem id={`${ids}-different`} value={DIFFERENT} className="mt-0.5" />
              <span>None of these: this is different money</span>
            </label>
          </RadioGroup>
          {elsewhere ? (
            <p className="text-[13px] leading-[1.45] text-muted-foreground">If one belongs here, ask Billing to move it.</p>
          ) : null}
          {pickedConflict && pickedNeedsAck ? (
            <>
              <p className="text-[13px] leading-[1.45] font-medium text-warning-ink">{amountLine(pickedConflict)}</p>
              {acknowledgement}
            </>
          ) : null}
          {proofWaived ? (
            <p className="text-[13px] leading-[1.45] text-muted-foreground">
              No proof file is needed: the Whop payment is the proof.
            </p>
          ) : null}
        </div>
        {proofRow}
        <div className="flex flex-col gap-2 border-t px-4 py-3 sm:flex-row">
          <Button
            type="button"
            disabled={pending || !selected}
            onClick={() => {
              if (selected === DIFFERENT) attempt(differentAnswer);
              else if (pickedSame) attempt(pickedSame);
            }}
          >
            {pending ? <Spinner data-icon="inline-start" /> : null}
            <TranslatableText>{pending ? "Saving…" : "Continue"}</TranslatableText>
          </Button>
        </div>
        <p className="border-t px-4 py-2.5 text-[13px] leading-[1.45] text-muted-foreground">
          Picking one links the two and records one payment. What you typed is kept.
        </p>
      </>
    );
  } else if (view.kind === "here") {
    const { conflict } = view;
    body = (
      <>
        <RecordFacts>
          <RecordFact label="Whop">
            <span className={FACT_FIGURE}>{whopAmount(conflict) ?? "—"}</span> · {collected(conflict.paidAt, now)}
          </RecordFact>
          <RecordFact label="You typed">{typedLine}</RecordFact>
        </RecordFacts>
        <p className="px-4 py-3 text-[13px] leading-[1.45] text-muted-foreground">
          No second payment is added. Your proof file goes on the payment that is already there
          {marksAttendance ? ", and the call is marked attended." : "."}
        </p>
        {proofRow}
        <div className="flex flex-col gap-2 border-t px-4 py-3 sm:flex-row">
          <Button type="button" disabled={pending} onClick={() => attempt(sameAnswer(conflict, typed))}>
            {pending ? <Spinner data-icon="inline-start" /> : null}
            <TranslatableText>
              {pending
                ? "Saving…"
                : marksAttendance
                  ? "Attach my proof to it and mark the call attended"
                  : "Attach my proof to it"}
            </TranslatableText>
          </Button>
        </div>
      </>
    );
  } else if (view.kind === "elsewhere") {
    body = (
      <>
        <RecordFacts>
          {recorded.map((conflict) => (
            <RecordFact key={conflict.providerPaymentId} label="Whop">
              <span className={FACT_FIGURE}>{whopAmount(conflict) ?? "—"}</span> · {collected(conflict.paidAt, now)}
            </RecordFact>
          ))}
          <RecordFact label="You typed">{typedLine}</RecordFact>
        </RecordFacts>
        <p className="px-4 py-3 text-[13px] leading-[1.45] text-muted-foreground">
          If it belongs here, ask Billing to move it.
        </p>
        {proofRow}
        <div className="flex flex-col gap-2 border-t px-4 py-3 sm:flex-row">
          <Button type="button" disabled={pending} onClick={() => attempt(differentAnswer)}>
            This is different money
          </Button>
        </div>
      </>
    );
  } else {
    body = (
      <>
        <RecordFacts>
          <RecordFact label="You typed">{typedLine}</RecordFact>
        </RecordFacts>
        {confirmingReadLimit ? (
          <>
            <div className="flex flex-col gap-1 bg-warning-surface px-4 py-3" role="group" aria-labelledby={`${ids}-confirm`}>
              <p id={`${ids}-confirm`} className="text-sm font-medium text-warning-ink">
                Save it as a new payment without the check?
              </p>
              <p className="text-[13px] leading-[1.45] text-warning-ink">
                If Whop already has this money, it counts twice until Billing removes one.
              </p>
            </div>
            {proofRow}
            <div className="flex flex-col gap-2 border-t px-4 py-3 sm:flex-row">
              <Button type="button" disabled={pending} onClick={() => attempt(differentAnswer)}>
                Yes, save as different money
              </Button>
              <Button type="button" variant="outline" disabled={pending} onClick={() => setConfirmingReadLimit(false)}>
                Don’t save
              </Button>
            </div>
          </>
        ) : (
          <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row">
            <Button type="button" variant="outline" disabled={pending} onClick={() => setConfirmingReadLimit(true)}>
              Save as different money
            </Button>
          </div>
        )}
      </>
    );
  }

  return (
    <div className="flex min-h-0 flex-col">
      {variant === "dialog" ? (
        <DialogHeader className="gap-1 border-b px-4 pt-4 pr-12 pb-3.5 text-left">
          <DialogTitle
            ref={headingRef}
            tabIndex={-1}
            className="text-[17px] leading-snug font-semibold text-balance outline-none"
          >
            {heading}
          </DialogTitle>
          <DialogDescription className="text-[13px] leading-[1.45] text-muted-foreground">{description}</DialogDescription>
        </DialogHeader>
      ) : (
        <div className="flex flex-col gap-1 border-b px-4 pt-4 pb-3.5">
          <h2 ref={headingRef} tabIndex={-1} className="text-[17px] leading-snug font-semibold text-balance outline-none">
            {heading}
          </h2>
          <p className="text-[13px] leading-[1.45] text-muted-foreground">{description}</p>
        </div>
      )}
      <SubmitError>{error}</SubmitError>
      {notice ? <DialogNote tone="warning">{notice}</DialogNote> : null}
      <div className="max-h-[min(60vh,34rem)] min-h-0 overflow-y-auto">{body}</div>
      {onBack ? (
        <ActionDialogFooter>
          <CancelButton onClick={onBack} disabled={pending}>
            Back
          </CancelButton>
        </ActionDialogFooter>
      ) : null}
    </div>
  );
}

/**
 * A capacity hold: the deal holds as many payments as the CRM keeps. No
 * retry; an admin has to look first.
 */
export function WhopCapacityHold({
  variant = "dialog",
  onClose,
}: {
  variant?: "dialog" | "page";
  onClose?: () => void;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);
  const text = "This deal has reached the number of payments the CRM can hold. Ask an admin before adding more.";
  return (
    <div className="flex min-h-0 flex-col">
      {variant === "dialog" ? (
        <DialogHeader className="gap-1 border-b px-4 pt-4 pr-12 pb-3.5 text-left">
          <DialogTitle ref={headingRef} tabIndex={-1} className="text-[17px] leading-snug font-semibold outline-none">
            This payment wasn’t saved
          </DialogTitle>
        </DialogHeader>
      ) : (
        <h2 ref={headingRef} tabIndex={-1} className="border-b px-4 pt-4 pb-3.5 text-[17px] font-semibold outline-none">
          This payment wasn’t saved
        </h2>
      )}
      {variant === "dialog" ? (
        <DialogDescription role="alert" className="px-4 py-3 text-[13px] leading-[1.45] text-danger-ink">
          {text}
        </DialogDescription>
      ) : (
        <p role="alert" className="px-4 py-3 text-[13px] leading-[1.45] text-danger-ink">
          {text}
        </p>
      )}
      {onClose ? (
        <ActionDialogFooter>
          <CancelButton onClick={onClose}>Close</CancelButton>
        </ActionDialogFooter>
      ) : null}
    </div>
  );
}

/**
 * "Use Whop's amount: $200.00": one quiet line over an untouched form, never
 * a silent change to the field.
 */
export function WhopAmountOffer({ amountLabel, onUse }: { amountLabel: string; onUse: () => void }) {
  return (
    <div className="border-b px-4 py-2">
      <Button type="button" variant="link" size="sm" className="h-auto p-0 text-[13px]" onClick={onUse}>
        Use Whop’s amount: <span className="tabular-nums">{amountLabel}</span>
      </Button>
    </div>
  );
}

/** The confirm step's fact for an answered step. */
export function WhopAnswerFact({ answer, hasProofFile }: { answer: WhopAnswer | null; hasProofFile: boolean }) {
  if (!answer) return null;
  return (
    <RecordFact label="Whop">
      {answer.kind === "different_money"
        ? "Different money from the Whop payment shown"
        : answer.amountsMatch && !hasProofFile
          ? "The same money. No proof file is needed: the Whop payment is the proof."
          : "The same money, linked to Whop’s payment"}
    </RecordFact>
  );
}
