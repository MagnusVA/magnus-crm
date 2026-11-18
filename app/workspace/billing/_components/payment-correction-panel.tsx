"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { DealOutcome } from "@/convex/opportunities/stages";
import { useRole } from "@/components/auth/role-context";
import { TranslatableText } from "@/components/translatable-text";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { formatAmountMinor } from "@/lib/format-currency";
import { getErrorMessage } from "@/lib/errors";
import { DetailCard } from "@/app/workspace/closer/meetings/_components/detail-card";
import { SectionErrorBoundary } from "@/app/workspace/_components/section-error-boundary";
import { ChoiceGroup, type ChoiceOption } from "./billing-choice-group";
import { FIGURE, formatPaidDate, plural } from "./billing-format";
import { paymentCommandSentence, restoreRefusalSentence } from "./payment-command-words";

// Taking a payment out, and putting it back (build contract §2.6). Every
// action shows its effects first, and sends the fingerprint of the preview
// on screen. Whop amounts never appear here: these are CRM payments.

export type ExclusionCause = "wrong_match" | "refund" | "chargeback";
type ExclusionPreview = FunctionReturnType<typeof api.payments.exclude.previewExclusion>;
type RestorePreview = FunctionReturnType<typeof api.payments.restore.previewRestore>;
type UndoResult = NonNullable<ExclusionPreview["undo"]["result"]>;
type DealChoice = "undo" | "lost" | "follow_up";
type PaymentCorrection = FunctionReturnType<typeof api.billing.queries.getPaymentCorrections>["corrections"][number];

const CAUSES: ReadonlyArray<{ value: ExclusionCause; label: string }> = [
  { value: "wrong_match", label: "Wrong person or deal" },
  { value: "refund", label: "Refunded" },
  { value: "chargeback", label: "Chargeback lost" },
];

const UNDO_WORDS: Record<UndoResult, string> = {
  undo_booked: "Puts the deal back at Booked, with its tasks.",
  undo_follow_up: "Puts the deal back at Follow-up, with its tasks.",
  undo_system_loss: "Closes the deal again as the no-show, cancellation or stale deal it was.",
  system_loss_on_undo: "Calendly has since marked the call canceled or a no-show, so the deal closes as that.",
};

const BUTTON_WORDS: Record<DealChoice | "kept_won", string> = {
  kept_won: "Take it out",
  undo: "Take it out and undo the win",
  lost: "Take it out and close as lost",
  follow_up: "Take it out and reopen at Follow-up",
};

const CHANGED = "Something changed. Check the new preview.";

/** The CRM payment as the panels need it. */
export type CorrectablePayment = {
  id: Id<"paymentRecords">;
  amountMinor: number;
  currency: string;
  recordedAt: number;
  status: string;
  dealOutcome: DealOutcome | null;
};

export function PaymentCorrectionPanel({
  payment,
  now,
  takeOut,
  onCloseTakeOut,
}: {
  payment: CorrectablePayment;
  now: number;
  takeOut: boolean;
  onCloseTakeOut: () => void;
}) {
  const { hasPermission } = useRole();
  const history = useQuery(api.billing.queries.getPaymentCorrections, { paymentRecordId: payment.id });
  const canCorrect = hasPermission("billing:correct");
  const correctionId = history?.restorable;
  return (
    <>
      {canCorrect && payment.status === "disputed" && correctionId ? (
        <RestorePanel key={correctionId} correctionId={correctionId} payment={payment} now={now} />
      ) : null}
      {canCorrect && payment.status !== "disputed" && (payment.dealOutcome === "won" || takeOut) ? (
        <TakeOutPanel
          key={`${payment.id}:${takeOut}`}
          payment={payment}
          now={now}
          cause={takeOut ? "wrong_match" : undefined}
          focusOnMount={takeOut}
          onCancel={takeOut ? onCloseTakeOut : undefined}
          onExcluded={takeOut ? onCloseTakeOut : undefined}
        />
      ) : null}
      {history && history.corrections.length > 0 ? <CorrectionHistory corrections={history.corrections} now={now} /> : null}
    </>
  );
}

function CorrectionHistory({ corrections, now }: { corrections: PaymentCorrection[]; now: number }) {
  return (
    <DetailCard title="Payment corrections">
      <ul className="flex flex-col gap-1.5 px-4 py-3 text-[13px] text-muted-foreground">
        {corrections.map((correction) => {
          const action = correction.operation === "restore" ? "Put back" : "Taken out";
          const cause = correction.cause === "voided"
            ? "voided"
            : CAUSES.find((option) => option.value === correction.cause)?.label.toLowerCase();
          return (
            <li key={correction.correctionId}>
              {action} by <span translate="no">{correction.actorName ?? "a Billing user"}</span> on{" "}
              {formatPaidDate(correction.createdAt, now)}{cause ? `: ${cause}` : ""}.
            </li>
          );
        })}
      </ul>
    </DetailCard>
  );
}

/** Moves focus to the panel's heading when it opens, or on mount with `onMount`. */
function useFocusOnOpen(open: boolean, onMount = false) {
  const ref = useRef<HTMLSpanElement>(null);
  const opened = useRef(onMount ? false : open);
  useEffect(() => {
    if (open && !opened.current) ref.current?.focus();
    opened.current = open;
  }, [open]);
  return ref;
}

function PanelHeading({ headingRef, children }: { headingRef: React.Ref<HTMLSpanElement>; children: ReactNode }) {
  return (
    <span ref={headingRef} tabIndex={-1} className="rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
      {children}
    </span>
  );
}

function PreviewFailed() {
  return (
    <p role="alert" className="border-t px-4 py-3 text-[13px] text-danger-ink">
      Billing can&apos;t work out what this would change. Reload the page, and if it happens again, leave it for now.
    </p>
  );
}

function Effects({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[13px] font-medium text-muted-foreground">What this changes</p>
      <ul className="flex list-disc flex-col gap-1 pl-5 text-[14px] marker:text-muted-foreground">{children}</ul>
    </div>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="rounded-[7px] border border-warning/60 bg-warning-surface px-3 py-2 text-[13px] font-medium">
      {children}
    </p>
  );
}

function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="text-[13px] text-danger-ink">
      {children}
    </p>
  );
}

/**
 * Keeps the preview on screen as a snapshot. When the server's preview
 * changes, the new one replaces it and `changed` says so, so the person
 * reads it before they send its fingerprint.
 */
function usePinnedPreview<T extends { fingerprint: string }>(live: T | undefined, onChange: () => void) {
  const [shown, setShown] = useState<T | null>(null);
  const [changed, setChanged] = useState(false);
  if (live && live.fingerprint !== shown?.fingerprint) {
    if (shown) {
      setChanged(true);
      onChange();
    }
    setShown(live);
  }
  return { shown, changed, setChanged };
}

// ─── Take this payment out ──────────────────────────────────────────────

/**
 * "Take this payment out": the cause, then the preview and the choices the
 * server allows. With `cause` set, the cause is fixed and the panel opens
 * at once (the Whop page's "Take it off this deal").
 */
export function TakeOutPanel({
  payment,
  now,
  cause: fixedCause,
  defaultOpen = false,
  focusOnMount = false,
  onCancel,
  onExcluded,
}: {
  payment: CorrectablePayment;
  now: number;
  cause?: ExclusionCause;
  defaultOpen?: boolean;
  /** Focus the heading when the panel mounts open, after a person asked for it. */
  focusOnMount?: boolean;
  onCancel?: () => void;
  onExcluded?: () => void;
}) {
  const [open, setOpen] = useState(defaultOpen || fixedCause !== undefined);
  const [cause, setCause] = useState<ExclusionCause | "">(fixedCause ?? "");
  const headingRef = useFocusOnOpen(open, focusOnMount);
  const amount = formatAmountMinor(payment.amountMinor, payment.currency);
  const causeId = `take-out-cause-${payment.id}`;

  return (
    <DetailCard title={<PanelHeading headingRef={headingRef}>Take this payment out</PanelHeading>}>
      {!open ? (
        <div className="flex flex-col gap-2.5 px-4 py-3">
          <p className="text-[13px] text-muted-foreground">
            For a payment on the wrong person or deal, a refund, or a lost chargeback. You see what changes before
            anything is saved, and it can be put back.
          </p>
          <Button type="button" variant="outline" className="w-fit" onClick={() => setOpen(true)}>
            Take this payment out
          </Button>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-3 px-4 py-3">
            {payment.dealOutcome === "won" ? (
              <p className="text-[14px]">
                The <span className={FIGURE}>{amount}</span> payment recorded on {formatPaidDate(payment.recordedAt, now)} stops counting.
              </p>
            ) : null}
            {fixedCause ? (
              <p className="text-[13px] text-muted-foreground">
                Reason: {CAUSES.find((option) => option.value === fixedCause)?.label}
              </p>
            ) : (
              <Field>
                <FieldLabel htmlFor={causeId}>Why is it coming out?</FieldLabel>
                <Select value={cause} onValueChange={(value) => setCause(value as ExclusionCause)}>
                  <SelectTrigger id={causeId} className="w-full sm:w-72" aria-required>
                    <SelectValue placeholder="Choose a reason" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {CAUSES.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            )}
          </div>
          {cause ? (
            <SectionErrorBoundary key={cause} sectionName="the preview" fallback={<PreviewFailed />}>
              <ExclusionPreviewBody
                payment={payment}
                cause={cause}
                now={now}
                onExcluded={onExcluded}
                onCancel={() => {
                  if (onCancel) onCancel();
                  else {
                    setOpen(false);
                    setCause("");
                  }
                }}
              />
            </SectionErrorBoundary>
          ) : (
            <div className="flex flex-wrap items-center gap-2 border-t px-4 py-3">
              <p className="mr-auto text-[13px] text-muted-foreground">Choose a reason to see what changes.</p>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  if (onCancel) onCancel();
                  else setOpen(false);
                }}
              >
                Cancel
              </Button>
            </div>
          )}
        </>
      )}
    </DetailCard>
  );
}

function ExclusionPreviewBody({
  payment,
  cause,
  now,
  onExcluded,
  onCancel,
}: {
  payment: CorrectablePayment;
  cause: ExclusionCause;
  now: number;
  onExcluded?: () => void;
  onCancel: () => void;
}) {
  const live = useQuery(api.payments.exclude.previewExclusion, { paymentRecordId: payment.id, cause });
  const evidence = useQuery(api.payments.review.getLinkedProviderPayment, { paymentRecordId: payment.id });
  const exclude = useMutation(api.payments.exclude.excludePayment);
  const [choice, setChoice] = useState<DealChoice | "">("");
  const [contact, setContact] = useState<"call" | "text" | "">("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { shown: preview, changed, setChanged } = usePinnedPreview(live, () => {
    setChoice("");
    setContact("");
    setError(null);
  });

  if (!preview) {
    return (
      <p role="status" className="border-t px-4 py-3 text-[13px] text-muted-foreground">
        Working out what this changes…
      </p>
    );
  }

  if (preview.refusal) {
    return (
      <div className="flex flex-wrap items-center gap-2 border-t px-4 py-3">
        <p role="alert" className="mr-auto text-[14px]">
          {preview.refusal === "deal_not_won"
            ? "A payment can only be taken out of a won deal."
            : preview.refusal === "stale_preview"
            ? "This payment no longer counts, so there is nothing to take out."
            : paymentCommandSentence(preview.refusal)}
        </p>
        <Button type="button" variant="outline" onClick={onCancel}>
          Close
        </Button>
      </div>
    );
  }

  const fromWhop = evidence?.paymentRecordId === payment.id;
  const keptWon = preview.survivors.length > 0;
  const undoAllowed = preview.undo.allowed && !keptWon;
  const options: Array<ChoiceOption<DealChoice>> = [];
  if (undoAllowed && preview.undo.result) {
    options.push({ value: "undo", label: "Undo", description: UNDO_WORDS[preview.undo.result] });
  }
  if (!keptWon) {
    for (const disposition of preview.allowedDispositions) {
      options.push(
        disposition === "lost"
          ? {
              value: "lost",
              label: "Closed as lost",
              description: "Closes the deal as lost because the payment was taken out. Attendance the closer recorded is kept.",
            }
          : {
              value: "follow_up",
              label: "Back to Follow-up with a reminder due now",
              description: "Reopens the deal at Follow-up and gives its closer one reminder due now. Attendance the closer recorded is kept.",
            },
      );
    }
  }
  // Undo is the one-step choice when the server allows it; a single
  // allowed outcome is chosen for the person.
  const effectiveChoice: DealChoice | "" =
    choice || (undoAllowed ? "undo" : options.length === 1 ? options[0].value : "");
  const needsContact = effectiveChoice === "follow_up";
  const ready = keptWon || (effectiveChoice !== "" && (!needsContact || contact !== ""));
  const buttonWords = keptWon ? BUTTON_WORDS.kept_won : effectiveChoice ? BUTTON_WORDS[effectiveChoice] : BUTTON_WORDS.kept_won;

  const firstMoves = preview.newFirstPaymentAt !== undefined && payment.recordedAt <= preview.newFirstPaymentAt;

  async function submit() {
    if (!preview || !ready) return;
    setPending(true);
    setError(null);
    setChanged(false);
    try {
      const result = await exclude({
        paymentRecordId: payment.id,
        cause,
        expectedFingerprint: preview.fingerprint,
        ...(keptWon
          ? { level: "reviewed" as const }
          : effectiveChoice === "undo"
            ? { level: "undo" as const }
            : {
                level: "reviewed" as const,
                disposition: effectiveChoice === "lost" ? ("lost" as const) : ("follow_up" as const),
                ...(effectiveChoice === "follow_up" && contact ? { followUpContactMethod: contact } : {}),
              }),
      });
      if (result.ok) {
        toast.success(result.alreadyApplied ? "This payment was already taken out." : "Payment taken out.");
        onExcluded?.();
      } else if (result.code === "stale_preview") {
        setChanged(true);
      } else {
        setError(paymentCommandSentence(result.code));
      }
    } catch (caught) {
      setError(getErrorMessage(caught, "Couldn't take the payment out. Try again."));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 border-t px-4 py-3">
      {changed ? <Notice>{CHANGED}</Notice> : null}
      <Effects>
        {preview.cashDeltaByCurrency.map((delta) => (
          <li key={delta.currency}>
            Removes <span className={FIGURE}>{formatAmountMinor(Math.abs(delta.amountMinor), delta.currency)}</span> from cash on{" "}
            {formatPaidDate(payment.recordedAt, now)}.
          </li>
        ))}
        {keptWon ? (
          <li>
            {plural(preview.survivors.length, "other payment")} on this deal still {preview.survivors.length === 1 ? "counts" : "count"}, so the deal stays won.
            {preview.newFirstPaymentAt !== undefined ? (
              <>
                {" "}Its first-payment date {firstMoves ? "moves to" : "stays"} {formatPaidDate(preview.newFirstPaymentAt, now)}.
              </>
            ) : null}
          </li>
        ) : (
          <li>No other payment on this deal counts, so the deal can&apos;t stay won.</li>
        )}
        {fromWhop && cause === "wrong_match" ? (
          <li>The Whop payment goes back to the From Whop list to be matched again. It won&apos;t be offered for this deal again.</li>
        ) : null}
        <li>Enrollments and customer status are worked out again.</li>
        <li>The credited closer sees a note that the payment was taken out.</li>
      </Effects>

      {!keptWon && options.length > 0 ? (
        <ChoiceGroup
          legend={undoAllowed ? "What happens to the deal?" : "What does the deal become?"}
          options={options}
          value={effectiveChoice}
          onChange={(value) => {
            setChoice(value);
            setError(null);
          }}
          disabled={pending}
        />
      ) : null}
      {!keptWon && options.length === 0 ? (
        <ErrorLine>No outcome is allowed for this deal here. Leave it for now and check the deal page.</ErrorLine>
      ) : null}
      {needsContact ? (
        <ChoiceGroup
          legend="How should the closer reach them?"
          options={[
            { value: "call", label: "Call" },
            { value: "text", label: "Text" },
          ]}
          value={contact}
          onChange={setContact}
          disabled={pending}
        />
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="destructive" className="font-semibold" disabled={!ready || pending} onClick={() => void submit()}>
          {pending ? <Spinner data-icon="inline-start" /> : null}
          <TranslatableText>{buttonWords}</TranslatableText>
        </Button>
        <Button type="button" variant="outline" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {error ? <ErrorLine>{error}</ErrorLine> : null}
    </div>
  );
}

// ─── Put this payment back ──────────────────────────────────────────────

const RESTORE_MOVE_WORDS: Record<NonNullable<RestorePreview["move"]>, string> = {
  none: "The deal stays won.",
  ordinary: "Wins the deal again from where it stands now. The reminder the correction made is closed if nobody has worked it.",
  payment_exclusion_restored: "Wins the deal again. Taking the payment out had closed it as lost.",
  provider_payment_after_system_loss: "Wins the deal again over the loss the system recorded.",
};

/**
 * "Put this payment back": the restore preview for one correction, its
 * refusal in words, and Put it back. Takes the correction id as a prop so
 * any page that knows it can mount it.
 */
export function RestorePanel({
  correctionId,
  payment,
  now,
}: {
  correctionId: Id<"paymentCorrections">;
  payment: Pick<CorrectablePayment, "amountMinor" | "currency" | "recordedAt">;
  now: number;
}) {
  const { hasPermission } = useRole();
  const [open, setOpen] = useState(false);
  const headingRef = useFocusOnOpen(open);
  if (!hasPermission("billing:correct")) return null;

  return (
    <DetailCard title={<PanelHeading headingRef={headingRef}>Put this payment back</PanelHeading>}>
      {!open ? (
        <div className="flex flex-col gap-2.5 px-4 py-3">
          <p className="text-[13px] text-muted-foreground">
            This payment was taken out and no longer counts. Putting it back counts it again. You see what changes first.
          </p>
          <Button type="button" variant="outline" className="w-fit" onClick={() => setOpen(true)}>
            Put this payment back
          </Button>
        </div>
      ) : (
        <SectionErrorBoundary sectionName="the preview" fallback={<PreviewFailed />}>
          <RestorePreviewBody correctionId={correctionId} payment={payment} now={now} onCancel={() => setOpen(false)} />
        </SectionErrorBoundary>
      )}
    </DetailCard>
  );
}

function RestorePreviewBody({
  correctionId,
  payment,
  now,
  onCancel,
}: {
  correctionId: Id<"paymentCorrections">;
  payment: Pick<CorrectablePayment, "amountMinor" | "currency" | "recordedAt">;
  now: number;
  onCancel: () => void;
}) {
  const live = useQuery(api.payments.restore.previewRestore, { correctionId });
  const restore = useMutation(api.payments.restore.restorePayment);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { shown: preview, changed, setChanged } = usePinnedPreview(live, () => setError(null));

  if (!preview) {
    return (
      <p role="status" className="px-4 py-3 text-[13px] text-muted-foreground">
        Working out what this changes…
      </p>
    );
  }

  if (preview.refusal) {
    return (
      <div className="flex flex-col gap-2.5 px-4 py-3">
        <p className="text-[13px] font-medium text-muted-foreground">It can&apos;t be put back now</p>
        <p role="alert" className="text-[14px]">
          {restoreRefusalSentence(preview.refusal)}
        </p>
        <Button type="button" variant="outline" className="w-fit" onClick={onCancel}>
          Close
        </Button>
      </div>
    );
  }

  async function submit() {
    if (!preview) return;
    setPending(true);
    setError(null);
    setChanged(false);
    try {
      const result = await restore({ correctionId, expectedFingerprint: preview.fingerprint });
      if (result.ok) {
        toast.success(result.alreadyApplied ? "This payment was already put back." : "Payment put back.");
      } else if (result.code === "stale_preview") {
        setChanged(true);
      } else {
        setError(restoreRefusalSentence(result.code));
      }
    } catch (caught) {
      setError(getErrorMessage(caught, "Couldn't put the payment back. Try again."));
    } finally {
      setPending(false);
    }
  }

  const deltas = preview.cashDeltaByCurrency.length > 0
    ? preview.cashDeltaByCurrency
    : [{ currency: payment.currency, amountMinor: payment.amountMinor }];

  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      {changed ? <Notice>{CHANGED}</Notice> : null}
      <Effects>
        {deltas.map((delta) => (
          <li key={delta.currency}>
            Adds <span className={FIGURE}>{formatAmountMinor(Math.abs(delta.amountMinor), delta.currency)}</span> back to cash on{" "}
            {formatPaidDate(payment.recordedAt, now)}.
          </li>
        ))}
        {preview.result === "restored_kept_won" ? <li>{RESTORE_MOVE_WORDS.none}</li> : null}
        {preview.result === "restored_won" && preview.move ? <li>{RESTORE_MOVE_WORDS[preview.move]}</li> : null}
        {preview.newFirstPaymentAt !== undefined ? (
          <li>The deal&apos;s first-payment date is {formatPaidDate(preview.newFirstPaymentAt, now)}.</li>
        ) : null}
        <li>Enrollments and customer status are worked out again.</li>
      </Effects>
      <div className="flex flex-wrap gap-2">
        <Button type="button" className="font-semibold" disabled={pending} onClick={() => void submit()}>
          {pending ? <Spinner data-icon="inline-start" /> : null}
          <TranslatableText>Put it back</TranslatableText>
        </Button>
        <Button type="button" variant="outline" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {error ? <ErrorLine>{error}</ErrorLine> : null}
    </div>
  );
}
