"use client";

import { useId, useState, type ReactNode, type Ref } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { TranslatableText } from "@/components/translatable-text";
import { Chip } from "@/components/call-insights/item-rows";
import { formatAmountMinor } from "@/lib/format-currency";
import { reportClientError } from "@/lib/observability/report-client-error";
import { cn } from "@/lib/utils";
import { useDayTime } from "./attendance-question";
import { useLocalFormat } from "./local-time";
import {
  automationCodeSentence,
  callClock,
  checkedLine,
  CONTACT_METHOD_WORDS,
  declineWords,
  speakerWords,
  thrownSentence,
  type CallAsk,
  type CallQuote,
  type ContactMethod,
} from "./call-result-words";

// The one-tap ask for a result read from a recorded call: a call-back, a
// payment-owed task or a refusal (`automation.confirmCall.getCallAsk` in
// state "ready"). It takes the place of the suggestion card. Each ask says in
// the card what the one tap writes; "Not right" / "Not a refusal" stops the
// proposal, and the page falls back to the suggestion card and the dialogs.
// The frame, facts and quote rows below are shared with the notice and the
// summary.

// ─── Shared frame ────────────────────────────────────────────────────────────

const LABEL =
  "font-condensed text-[11px] leading-[1.2] font-semibold tracking-[0.14em] text-muted-foreground uppercase";

const FRAME_TONE = {
  /** A one-tap ask: the lime rule on a lime tint, as the Whop payment card. */
  ask: "border-l-[3px] border-l-primary bg-[color-mix(in_srgb,var(--primary)_7%,var(--card))]",
  /** A pending loss: the amber rule of something owed. */
  notice: "border-l-[3px] border-l-warning bg-[color-mix(in_srgb,var(--warning)_8%,var(--card))]",
  /** A recorded result: a plain card. */
  plain: "bg-card",
} as const;

/**
 * A result card: a heading (focusable, so the page can move focus to it when
 * the result area changes), chips beside it, then the body. `ph-no-capture`
 * keeps the prospect's words out of session replays.
 */
export function ResultCard({
  title,
  chips,
  tone,
  headingRef,
  children,
  className,
}: {
  title: ReactNode;
  chips?: ReactNode;
  tone: keyof typeof FRAME_TONE;
  headingRef?: Ref<HTMLHeadingElement>;
  children: ReactNode;
  className?: string;
}) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className={cn(
        "ph-no-capture @container flex min-w-0 flex-col gap-3 rounded-[var(--radius)] border px-4 py-3.5",
        FRAME_TONE[tone],
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2
          id={headingId}
          ref={headingRef}
          tabIndex={-1}
          data-result-heading=""
          className="min-w-0 text-[1.0625rem] leading-snug font-semibold text-balance outline-none"
        >
          {title}
        </h2>
        {chips}
      </div>
      {children}
    </section>
  );
}

/** Dense facts: a condensed label column beside the value. */
export function ResultFacts({ children }: { children: ReactNode }) {
  return (
    <dl className="grid grid-cols-[4.75rem_minmax(0,1fr)] items-baseline gap-x-3 gap-y-2">{children}</dl>
  );
}

export function ResultFact({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <>
      <dt className={cn(LABEL, "tabular-nums")}>{label}</dt>
      <dd className="min-w-0 text-sm break-words">{children}</dd>
    </>
  );
}

/**
 * The prospect's words, as the server returned them for this viewer: each
 * line under the time it was said. Never stored, logged or sent anywhere.
 * With the transcript gone, one line says so in their place.
 */
export function QuoteFacts({ quotes, quotesDeleted }: { quotes: CallQuote[]; quotesDeleted: boolean }) {
  if (quotesDeleted) {
    return (
      <ResultFact label="Quote">
        <span className="text-muted-foreground">The quote was deleted with the transcript.</span>
      </ResultFact>
    );
  }
  return (
    <>
      {quotes.map((line) => (
        <ResultFact key={line.lineIndex} label={callClock(line.atSeconds)}>
          <span className="text-pretty">&ldquo;{line.quote}&rdquo;</span>{" "}
          <span className="text-[0.8125rem] text-muted-foreground">{speakerWords(line.speaker)}</span>
        </ResultFact>
      ))}
    </>
  );
}

/** A button with its spinner; the label sits in `TranslatableText` beside it. */
export function PendingButton({
  pending,
  pendingLabel,
  disabled,
  variant,
  onClick,
  children,
  className,
}: {
  pending: boolean;
  pendingLabel: string;
  disabled?: boolean;
  variant?: "default" | "outline" | "destructive" | "ghost";
  onClick: () => void;
  children: string;
  className?: string;
}) {
  return (
    <Button
      type="button"
      variant={variant}
      disabled={pending || disabled}
      onClick={onClick}
      className={cn(variant === "default" || variant === undefined ? "font-semibold" : null, className)}
    >
      {pending ? <Spinner data-icon="inline-start" /> : null}
      <TranslatableText>{pending ? pendingLabel : children}</TranslatableText>
    </Button>
  );
}

/** A refusal or failure under the buttons, in danger ink. */
export function ResultError({ children }: { children: string | null }) {
  if (!children) return null;
  return (
    <p role="alert" className="text-[0.8125rem] leading-[1.45] text-danger-ink">
      {children}
    </p>
  );
}

/** "$500.00 USD": the repo's money format with the currency code beside it. */
export function amountWithCode(amountMinor: number, currency: string): string {
  return `${formatAmountMinor(amountMinor, currency)} ${currency.toUpperCase()}`;
}

// ─── The ask ─────────────────────────────────────────────────────────────────

type TaskProposal = Extract<NonNullable<CallAsk["proposal"]>, { type: "task" }>;

export type CallAskCallbacks = {
  /** The write landed: the page reloads the meeting. */
  onChanged?: () => Promise<void>;
  /** The person acted: the page moves focus to the next card's heading. */
  onActed: () => void;
  /** The call was read again since this ask loaded. */
  onStale: () => void;
};

/** States 1 to 3: the call-back, payment-owed and refusal asks. */
export function CallAskCard({
  ask,
  firstName,
  onChanged,
  onActed,
  onStale,
}: { ask: CallAsk; firstName: string | null } & CallAskCallbacks) {
  const dayTime = useDayTime();
  const format = useLocalFormat();
  const confirmTask = useMutation(api.automation.confirmCall.confirmCallDecision);
  const confirmRefusal = useMutation(api.automation.refusal.confirmRefusal);
  const decline = useMutation(api.automation.confirmCall.declineCallDecision);
  const [pending, setPending] = useState<"confirm" | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const proposal = ask.proposal;
  const task: TaskProposal | null = proposal?.type === "task" ? proposal : null;
  const isRefusal = ask.kind === "refusal_loss";
  if (!isRefusal && !task) return null;

  const run = async (which: "confirm" | "decline") => {
    setPending(which);
    setError(null);
    try {
      const args = { decisionId: ask.decisionId, expectedInputKey: ask.expectedInputKey };
      const result =
        which === "decline"
          ? await decline({ decisionId: ask.decisionId })
          : isRefusal
            ? await confirmRefusal(args)
            : await confirmTask(args);
      if (!result.ok) {
        if (result.code === "stale_preview") {
          onActed();
          onStale();
        } else {
          setError(automationCodeSentence(result.code));
        }
        return;
      }
      onActed();
      if (which === "confirm") {
        toast.success(
          isRefusal ? "Closed as lost." : ask.kind === "payment_owed" ? "Payment-owed task set." : "Call-back set.",
        );
        await onChanged?.();
      }
    } catch (err) {
      reportClientError(err, { flow: which === "confirm" ? "call_ask_confirm" : "call_ask_decline", kind: ask.kind });
      setError(thrownSentence(err));
    } finally {
      setPending(null);
    }
  };

  const who = firstName ?? "The prospect";
  let title: ReactNode;
  let headline: string | null = null;
  let consequence: string;
  let confirmLabel: string;
  let declineLabel: string;
  const extra: ReactNode[] = [];

  // Without a task proposal this is the refusal (the guard above returned otherwise).
  if (isRefusal || !task) {
    title = <>From the call: {who} refused</>;
    consequence = "The deal will be closed as lost and this call marked held.";
    confirmLabel = "Close as lost";
    declineLabel = "Not a refusal";
  } else {
    const t = task;
    const method = CONTACT_METHOD_WORDS[t.contactMethod as ContactMethod];
    const when = dayTime(t.reminderScheduledAt);
    title = "From the call";
    if (ask.kind === "payment_owed") {
      const amount =
        t.expectedAmountMinor !== undefined && t.expectedCurrency
          ? amountWithCode(t.expectedAmountMinor, t.expectedCurrency)
          : null;
      const promised = t.promisedPaymentAt !== undefined ? format(t.promisedPaymentAt, "EEE MMM d") : null;
      headline = [
        amount ? `Promised ${amount}` : "Payment promised",
        promised ? `on ${promised}` : null,
      ]
        .filter(Boolean)
        .join(" ")
        .concat(` · ${method}`);
      if (t.declineCode) {
        extra.push(
          <ResultFact key="decline" label="Declined">
            {declineWords(t.declineCode)}
          </ResultFact>,
        );
      }
      consequence = `Sets a payment-owed task for ${when}, ${method}, and moves the deal to Follow-up. The meeting will be marked held.`;
      confirmLabel = "Set payment-owed task";
    } else {
      headline = `Call back ${when} · ${method}`;
      consequence = `Sets a call-back task for ${when}, ${method}, and moves the deal to Follow-up. The meeting will be marked held.`;
      confirmLabel = "Set the call-back";
    }
    declineLabel = "Not right";
  }

  return (
    <ResultCard title={title} tone="ask" chips={<Chip tone="warning">Ask</Chip>}>
      {headline ? <p className="text-base leading-snug font-semibold">{headline}</p> : null}
      <ResultFacts>
        {extra}
        <QuoteFacts quotes={ask.quotes} quotesDeleted={ask.quotesDeleted} />
        <ResultFact label="Checked">{checkedLine(ask.kind)}</ResultFact>
      </ResultFacts>
      <p className="text-[0.8125rem] leading-[1.45] text-pretty text-muted-foreground">{consequence}</p>
      <div className="flex flex-wrap gap-2">
        <PendingButton
          pending={pending === "confirm"}
          pendingLabel="Saving…"
          disabled={pending !== null || !ask.can.confirm}
          variant={isRefusal ? "destructive" : "default"}
          className={isRefusal ? "font-semibold text-danger-ink" : undefined}
          onClick={() => void run("confirm")}
        >
          {confirmLabel}
        </PendingButton>
        {ask.can.decline ? (
          <PendingButton
            pending={pending === "decline"}
            pendingLabel="Saving…"
            disabled={pending !== null}
            variant="outline"
            onClick={() => void run("decline")}
          >
            {declineLabel}
          </PendingButton>
        ) : null}
      </div>
      <ResultError>{error}</ResultError>
    </ResultCard>
  );
}
