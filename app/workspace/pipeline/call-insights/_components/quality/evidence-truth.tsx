"use client";

import { format } from "date-fns";
import type { EvidenceLabelValues } from "@/convex/callInsights/validators";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { FormRow } from "@/app/workspace/_components/action-dialog";
import { useLocalFormat } from "@/app/workspace/closer/meetings/_components/local-time";
import { StatusWord } from "@/app/workspace/reports/_components/report-ui";
import { minorToInput } from "@/lib/callInsights/display";
import {
  EVAL_CURRENCIES,
  parseAmountMinor,
} from "@/lib/callInsights/quality-display";
import { formatAmountMinor } from "@/lib/format-currency";
import { GradingSubhead, type AdminLabel, type Candidate } from "./grading-parts";

// The call's evidence as the grader reads it, blind: what the recording is,
// each side's final stance, and the agreed next step with its time, method
// and amount. Saved with the grader's own reading, before the model's
// evidence is on screen; afterwards the two are compared field by field.

type RecordingScope = EvidenceLabelValues["recordingScope"];
type ProspectStance = EvidenceLabelValues["prospectStance"];
type CloserStance = EvidenceLabelValues["closerStance"];
type NextStep = EvidenceLabelValues["nextStep"];
type NextStepMethod = NonNullable<EvidenceLabelValues["nextStepMethod"]>;

const SCOPE_WORDS: Record<RecordingScope, string> = {
  whole: "One whole call",
  fragment: "Starts partway through",
  cut_off: "The ending is missing",
  multiple_calls: "More than one call",
  not_sales_call: "Not a sales call",
  unknown: "Can't tell",
};

const PROSPECT_WORDS: Record<ProspectStance, string> = {
  yes: "Agreed",
  refused: "Refused",
  undecided: "Undecided",
  unknown: "Can't tell",
};

const CLOSER_WORDS: Record<CloserStance, string> = {
  continues: "Kept the sale open",
  disqualified: "Ended the sale",
  unknown: "Can't tell",
};

const NEXT_STEP_WORDS: Record<NextStep, string> = {
  call_back: "Call back",
  payment_owed: "Payment owed",
  none: "None agreed",
  unknown: "Can't tell",
};

const METHOD_WORDS: Record<NextStepMethod, string> = {
  call: "Call",
  text: "Text",
};

const FIELD_WORDS: Record<keyof EvidenceLabelValues, string> = {
  recordingScope: "Recording",
  prospectStance: "Prospect's final stance",
  closerStance: "Closer's final stance",
  nextStep: "Next step",
  nextStepAt: "Next step at",
  nextStepMethod: "Contact by",
  quotedAmountMinor: "Amount",
  quotedCurrency: "Currency",
};

const FIELD_ORDER = Object.keys(FIELD_WORDS) as Array<keyof EvidenceLabelValues>;

export type EvidenceDraft = {
  recordingScope: RecordingScope | "";
  prospectStance: ProspectStance | "";
  closerStance: CloserStance | "";
  nextStep: NextStep | "";
  nextStepAt: string;
  nextStepMethod: NextStepMethod | "";
  amount: string;
  currency: string;
};

/** The step agreed has a time and a method; only a payment owed has an amount. */
function stepHasTime(step: NextStep | "") {
  return step === "call_back" || step === "payment_owed" || step === "unknown";
}

/** Starts from evidence a person already saved (a commit that failed after it), or empty. */
export function initialEvidence(items: readonly AdminLabel[]): EvidenceDraft {
  const saved = items.find((item) => item.itemClass === "evidence");
  return {
    recordingScope: saved?.recordingScope ?? "",
    prospectStance: saved?.prospectStance ?? "",
    closerStance: saved?.closerStance ?? "",
    nextStep: saved?.nextStep ?? "",
    nextStepAt:
      saved?.nextStepAt !== undefined
        ? format(saved.nextStepAt, "yyyy-MM-dd'T'HH:mm")
        : "",
    nextStepMethod: saved?.nextStepMethod ?? "",
    amount:
      saved?.quotedAmountMinor !== undefined
        ? minorToInput(saved.quotedAmountMinor)
        : "",
    currency: saved?.quotedCurrency ?? "",
  };
}

export function evidenceReady(draft: EvidenceDraft) {
  return Boolean(
    draft.recordingScope &&
      draft.prospectStance &&
      draft.closerStance &&
      draft.nextStep,
  );
}

/** The draft as `setAdminEvidence` values, or the first thing a person must fix. */
export function evidenceToValues(
  draft: EvidenceDraft,
): { evidence: EvidenceLabelValues } | { error: string } {
  if (
    !draft.recordingScope ||
    !draft.prospectStance ||
    !draft.closerStance ||
    !draft.nextStep
  )
    return { error: "Answer every evidence question, or choose Can't tell." };
  const evidence: EvidenceLabelValues = {
    recordingScope: draft.recordingScope,
    prospectStance: draft.prospectStance,
    closerStance: draft.closerStance,
    nextStep: draft.nextStep,
  };
  if (stepHasTime(draft.nextStep)) {
    if (draft.nextStepAt) {
      const at = new Date(draft.nextStepAt).getTime();
      if (!Number.isFinite(at))
        return { error: "Enter a valid next-step time." };
      evidence.nextStepAt = at;
    }
    if (draft.nextStepMethod) evidence.nextStepMethod = draft.nextStepMethod;
  }
  if (draft.nextStep === "payment_owed") {
    const amount = parseAmountMinor(draft.amount);
    if (Number.isNaN(amount))
      return {
        error: "Enter the amount as a number, such as 1500 or 1,500.50.",
      };
    if (amount !== null) evidence.quotedAmountMinor = amount;
    if (draft.currency) evidence.quotedCurrency = draft.currency;
  }
  return { evidence };
}

const SELECT = "w-full @lg:max-w-72";

/** The blind evidence questions, as rows of the "How did the call end?" card. */
export function EvidenceFields({
  draft,
  onChange,
}: {
  draft: EvidenceDraft;
  onChange: (patch: Partial<EvidenceDraft>) => void;
}) {
  return (
    <>
      <div className="border-t">
        <GradingSubhead title="The call's evidence">
          Your own answers. The reading&apos;s evidence shows only after you
          save.
        </GradingSubhead>
      </div>
      <div className="@container divide-y">
        <EvidenceSelect
          id="evidence-scope"
          label="Recording"
          value={draft.recordingScope}
          words={SCOPE_WORDS}
          onChange={(value) => onChange({ recordingScope: value })}
        />
        <EvidenceSelect
          id="evidence-prospect"
          label="Prospect's final stance"
          value={draft.prospectStance}
          words={PROSPECT_WORDS}
          onChange={(value) => onChange({ prospectStance: value })}
        />
        <EvidenceSelect
          id="evidence-closer"
          label="Closer's final stance"
          value={draft.closerStance}
          words={CLOSER_WORDS}
          onChange={(value) => onChange({ closerStance: value })}
        />
        <EvidenceSelect
          id="evidence-next-step"
          label="Next step"
          value={draft.nextStep}
          words={NEXT_STEP_WORDS}
          onChange={(value) => onChange({ nextStep: value })}
        />
        {stepHasTime(draft.nextStep) ? (
          <>
            <FormRow
              label="Next step at"
              htmlFor="evidence-at"
              description="Only when both the day and the time were agreed."
            >
              <Input
                id="evidence-at"
                type="datetime-local"
                className="h-8 w-fit"
                value={draft.nextStepAt}
                onChange={(event) =>
                  onChange({ nextStepAt: event.target.value })
                }
              />
            </FormRow>
            <EvidenceSelect
              id="evidence-method"
              label="Contact by"
              value={draft.nextStepMethod}
              words={METHOD_WORDS}
              empty="Not said"
              onChange={(value) => onChange({ nextStepMethod: value })}
            />
          </>
        ) : null}
        {draft.nextStep === "payment_owed" ? (
          <>
            <FormRow
              label="Amount"
              htmlFor="evidence-amount"
              description="The amount of that payment, as the prospect said it."
            >
              <Input
                id="evidence-amount"
                inputMode="decimal"
                className="h-8 w-28 font-condensed text-[15px] tabular-nums"
                value={draft.amount}
                onChange={(event) => onChange({ amount: event.target.value })}
                placeholder="Not said"
              />
            </FormRow>
            <FormRow label="Currency" htmlFor="evidence-currency">
              <NativeSelect
                id="evidence-currency"
                className={SELECT}
                value={draft.currency}
                onChange={(event) => onChange({ currency: event.target.value })}
              >
                <NativeSelectOption value="">Not said</NativeSelectOption>
                {EVAL_CURRENCIES.map((currency) => (
                  <NativeSelectOption key={currency} value={currency}>
                    {currency}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </FormRow>
          </>
        ) : null}
      </div>
    </>
  );
}

function EvidenceSelect<T extends string>({
  id,
  label,
  value,
  words,
  empty = "Choose",
  onChange,
}: {
  id: string;
  label: string;
  value: T | "";
  words: Record<T, string>;
  empty?: string;
  onChange: (value: T | "") => void;
}) {
  return (
    <FormRow label={label} htmlFor={id}>
      <NativeSelect
        id={id}
        className={SELECT}
        value={value}
        onChange={(event) => onChange(event.target.value as T | "")}
      >
        <NativeSelectOption value="">{empty}</NativeSelectOption>
        {(Object.entries(words) as Array<[T, string]>).map(([key, text]) => (
          <NativeSelectOption key={key} value={key}>
            {text}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </FormRow>
  );
}

type EvidenceLike = Partial<EvidenceLabelValues>;

function fieldWords(
  key: keyof EvidenceLabelValues,
  label: EvidenceLike,
  at: (time: number) => string,
): string {
  switch (key) {
    case "recordingScope":
      return label.recordingScope ? SCOPE_WORDS[label.recordingScope] : "—";
    case "prospectStance":
      return label.prospectStance ? PROSPECT_WORDS[label.prospectStance] : "—";
    case "closerStance":
      return label.closerStance ? CLOSER_WORDS[label.closerStance] : "—";
    case "nextStep":
      return label.nextStep ? NEXT_STEP_WORDS[label.nextStep] : "—";
    case "nextStepAt":
      return label.nextStepAt !== undefined ? at(label.nextStepAt) : "Not said";
    case "nextStepMethod":
      return label.nextStepMethod ? METHOD_WORDS[label.nextStepMethod] : "Not said";
    case "quotedAmountMinor":
      if (label.quotedAmountMinor === undefined) return "Not said";
      return label.quotedCurrency
        ? formatAmountMinor(label.quotedAmountMinor, label.quotedCurrency)
        : minorToInput(label.quotedAmountMinor);
    case "quotedCurrency":
      return label.quotedCurrency ?? "Not said";
  }
}

/**
 * After the commit: the reading's evidence beside the grader's own, field by
 * field. The server compared them when the grader saved; this only shows it.
 */
export function EvidenceComparison({
  adminItems,
  candidates,
}: {
  adminItems: readonly AdminLabel[];
  candidates: readonly Candidate[];
}) {
  const format = useLocalFormat();
  const truth = adminItems.find((item) => item.itemClass === "evidence");
  const reading = candidates.find(
    (candidate) => candidate.itemClass === "evidence",
  );
  if (!truth) return null;
  const at = (time: number) => format(time, "MMM d, h:mm a");
  const wrong = new Set(reading?.wrongFields ?? []);

  return (
    <>
      <div className="border-t">
      <GradingSubhead title="The call's evidence">
        {!reading
          ? "The reading has no evidence for this call."
          : wrong.size === 0
            ? "The reading matches your answers on every field."
            : `The reading differs on ${wrong.size} ${wrong.size === 1 ? "field" : "fields"}.`}
        {truth.evidenceBlind === false
          ? " Your answers were saved after the reading was seen, so they don't count."
          : null}
      </GradingSubhead>
      </div>
      <dl className="@container divide-y">
        {FIELD_ORDER.map((key) => {
          const differs = reading ? wrong.has(key) : false;
          return (
            <div
              key={key}
              className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-0.5 px-4 py-2 text-[13px] @lg:grid-cols-[10rem_minmax(0,1fr)_minmax(0,1fr)_auto]"
            >
              <dt className="font-medium">{FIELD_WORDS[key]}</dt>
              <dd className="order-last col-span-2 text-muted-foreground @lg:order-none @lg:col-span-1">
                You: {fieldWords(key, truth, at)}
              </dd>
              {reading ? (
                <dd className="order-last col-span-2 text-muted-foreground @lg:order-none @lg:col-span-1">
                  Reading: {fieldWords(key, reading, at)}
                </dd>
              ) : (
                <dd className="hidden @lg:block" />
              )}
              <dd className="text-right">
                {reading ? (
                  <StatusWord tone={differs ? "failed" : "done"}>
                    {differs ? "Differs" : "Matches"}
                  </StatusWord>
                ) : null}
              </dd>
            </div>
          );
        })}
      </dl>
    </>
  );
}
