"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { format } from "date-fns";
import { api } from "@/convex/_generated/api";
import type { SuggestionValues } from "@/convex/callInsights/validators";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { FormRow } from "@/app/workspace/_components/action-dialog";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import {
  DetailCard,
  DetailCardFooter,
} from "@/app/workspace/closer/meetings/_components/detail-card";
import { ReportNote } from "@/app/workspace/reports/_components/report-ui";
import { getErrorMessage } from "@/lib/errors";
import {
  CONTACT_WORDS,
  EVAL_CURRENCIES,
  NO_SHOW_REASON_WORDS,
  PAYMENT_TYPE_WORDS,
  PERIOD_CHOICES,
  RESOLUTION_WORDS,
  RESULT_CHOICES,
  SCENARIO_WORDS,
  isExtractionClass,
  labelTitle,
  labelValueWords,
  parseAmountMinor,
  parseLine,
  resultValueFields,
  valuesForKind,
} from "@/lib/callInsights/quality-display";
import { minorToInput } from "@/lib/callInsights/display";
import {
  GOAL_CATEGORIES,
  INCOME_KINDS,
  ITEM_KINDS,
  LOSS_CATEGORIES,
  OBJECTION_CATEGORIES,
  STRUGGLE_CATEGORIES,
  type IncomePeriod,
  type IncomeScenario,
  type ItemKind,
  type Resolution,
  type SuggestionKind,
} from "@/lib/callInsights/taxonomy";
import { SEGMENT, SEGMENT_GROUP, type GradingView } from "./grading-parts";

/** The item being written, lifted to the page so a clicked transcript line can fill it. */
export type ItemDraft = {
  itemClass: ItemKind;
  category: string;
  lineStart: string;
  lineEnd: string;
  /** Which line field the next clicked transcript line fills. */
  target: "start" | "end";
  resolution: Resolution | "";
  scenario: IncomeScenario | "";
  period: IncomePeriod | "";
  currency: string;
  min: string;
  max: string;
};

export const EMPTY_DRAFT: ItemDraft = {
  itemClass: "objection",
  category: "",
  lineStart: "",
  lineEnd: "",
  target: "start",
  resolution: "",
  scenario: "",
  period: "",
  currency: "",
  min: "",
  max: "",
};

const KIND_WORDS: Record<ItemKind, string> = {
  objection: "Objection",
  struggle: "Struggle",
  goal: "Goal",
  income: "Income",
};

const CATEGORY_TABLES: Record<
  ItemKind,
  Record<string, { label: string; definition?: string }>
> = {
  objection: OBJECTION_CATEGORIES,
  struggle: STRUGGLE_CATEGORIES,
  goal: GOAL_CATEGORIES,
  income: INCOME_KINDS,
};

type ItemArgs = {
  itemClass: ItemKind;
  category: string;
  lineStart: number;
  lineEnd: number;
  resolution?: Resolution;
  scenario?: IncomeScenario;
  period?: IncomePeriod;
  currency?: string;
  minMinor?: number;
  maxMinor?: number;
};

/** The draft as `addAdminItem` arguments, or the first thing a person must fix. */
function draftToArgs(
  draft: ItemDraft,
  lineCount: number,
): { args: ItemArgs } | { error: string } {
  if (!draft.category) return { error: "Choose a category." };
  const start = parseLine(draft.lineStart, lineCount);
  const end =
    draft.lineEnd.trim() === "" ? start : parseLine(draft.lineEnd, lineCount);
  if (start === null || end === null)
    return { error: `Enter lines between 1 and ${lineCount}.` };
  if (end < start) return { error: "The last line comes before the first." };
  const args: ItemArgs = {
    itemClass: draft.itemClass,
    category: draft.category,
    lineStart: start,
    lineEnd: end,
  };
  if (draft.itemClass === "objection" && draft.resolution)
    args.resolution = draft.resolution;
  if (draft.itemClass === "income") {
    const min = parseAmountMinor(draft.min);
    const max = parseAmountMinor(draft.max);
    if (Number.isNaN(min) || Number.isNaN(max))
      return { error: "Enter amounts as numbers, such as 4500 or 4,500.50." };
    if (min !== null && max !== null && max < min)
      return { error: "The highest amount is below the lowest." };
    if (min !== null) args.minMinor = min;
    if (max !== null) args.maxMinor = max;
    else if (min !== null) args.maxMinor = min;
    if (draft.scenario) args.scenario = draft.scenario;
    if (draft.period) args.period = draft.period;
    if (draft.currency) args.currency = draft.currency;
  }
  return { args };
}

type ResultDraft = {
  kind: SuggestionKind | "";
  amount: string;
  currency: string;
  currencyAssumed: boolean;
  paymentType: NonNullable<SuggestionValues["paymentType"]> | "";
  callbackAt: string;
  contactMethod: NonNullable<SuggestionValues["contactMethod"]> | "";
  lossCategory: NonNullable<SuggestionValues["lossCategory"]> | "";
  noShowReason: NonNullable<SuggestionValues["noShowReason"]> | "";
  attended: "yes" | "no" | "";
};

/** Starts from a result a person already saved (a commit that failed after it), or empty. */
function initialResult(items: GradingView["adminItems"]): ResultDraft {
  const result = items.find((item) => item.itemClass === "result");
  const attendance = items.find((item) => item.itemClass === "attendance");
  const values = result?.resultValues ?? {};
  return {
    kind: result?.resultKind ?? "",
    amount:
      values.amountMinor !== undefined ? minorToInput(values.amountMinor) : "",
    currency: values.currency ?? "",
    currencyAssumed: values.currencyAssumed ?? false,
    paymentType: values.paymentType ?? "",
    callbackAt:
      values.callbackAt !== undefined
        ? format(values.callbackAt, "yyyy-MM-dd'T'HH:mm")
        : "",
    contactMethod: values.contactMethod ?? "",
    lossCategory: values.lossCategory ?? "",
    noShowReason: values.noShowReason ?? "",
    attended:
      attendance?.category === "held"
        ? "yes"
        : attendance?.category === "no_show"
          ? "no"
          : "",
  };
}

/** The result as `setAdminResult` values, or the first thing a person must fix. */
function resultToValues(
  draft: ResultDraft,
): { values: SuggestionValues } | { error: string } {
  if (!draft.kind) return { error: "Choose how the call ended." };
  if (!draft.attended) return { error: "Say whether the prospect attended." };
  const values: SuggestionValues = {};
  const amount = parseAmountMinor(draft.amount);
  if (Number.isNaN(amount))
    return { error: "Enter the amount as a number, such as 1500 or 1,500.50." };
  if (amount !== null) values.amountMinor = amount;
  if (draft.currency) values.currency = draft.currency;
  if (draft.currency && draft.currencyAssumed) values.currencyAssumed = true;
  if (draft.paymentType) values.paymentType = draft.paymentType;
  if (draft.callbackAt) {
    const at = new Date(draft.callbackAt).getTime();
    if (!Number.isFinite(at)) return { error: "Enter a valid call-back time." };
    values.callbackAt = at;
  }
  if (draft.contactMethod) values.contactMethod = draft.contactMethod;
  if (draft.lossCategory) values.lossCategory = draft.lossCategory;
  if (draft.noShowReason) values.noShowReason = draft.noShowReason;
  return { values: valuesForKind(draft.kind, values) };
}

const SELECT = "w-full @lg:max-w-72";
const NUMBER_INPUT = "h-8 w-28 font-condensed text-[15px] tabular-nums";

/**
 * Step 1, "Your own reading": the admin lists what the prospect said and how
 * the call ended before any model answer is on screen. Nothing the reading
 * produced is loaded here (the API returns no candidates in this phase).
 */
export function GradingListPhase({
  view,
  draft,
  setDraft,
}: {
  view: GradingView;
  draft: ItemDraft;
  setDraft: (draft: ItemDraft) => void;
}) {
  const caseId = view.case.caseId;
  const lineCount = view.transcript.lineCount;
  const addItem = useMutation(api.callInsights.eval.labels.addAdminItem);
  const removeItem = useMutation(api.callInsights.eval.labels.removeAdminItem);
  const setResult = useMutation(api.callInsights.eval.labels.setAdminResult);
  const commitList = useMutation(api.callInsights.eval.labels.commitList);

  const [itemError, setItemError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [result, setResultDraft] = useState<ResultDraft>(() =>
    initialResult(view.adminItems),
  );
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [committing, setCommitting] = useState<"done" | "skip" | null>(null);

  const ownItems = view.adminItems.filter((item) =>
    isExtractionClass(item.itemClass),
  );
  const categories = CATEGORY_TABLES[draft.itemClass];
  const definition = draft.category
    ? categories[draft.category]?.definition
    : undefined;
  const resultFields = new Set(resultValueFields(result.kind || undefined));
  const resultReady = Boolean(result.kind && result.attended);
  const transcriptGone = lineCount === 0;

  const update = (patch: Partial<ItemDraft>) =>
    setDraft({ ...draft, ...patch });
  const updateResult = (patch: Partial<ResultDraft>) =>
    setResultDraft({ ...result, ...patch });

  const add = async () => {
    const parsed = draftToArgs(draft, lineCount);
    if ("error" in parsed) {
      setItemError(parsed.error);
      return;
    }
    setAdding(true);
    setItemError(null);
    try {
      await addItem({ caseId, ...parsed.args });
      // Keep the kind and category: several items of one kind are often listed in a row.
      setDraft({
        ...EMPTY_DRAFT,
        itemClass: draft.itemClass,
        category: draft.category,
      });
    } catch (error) {
      setItemError(getErrorMessage(error, "Couldn't add the item."));
    } finally {
      setAdding(false);
    }
  };

  const remove = async (labelId: (typeof ownItems)[number]["labelId"]) => {
    setRemoving(labelId);
    try {
      await removeItem({ labelId });
    } catch (error) {
      setItemError(getErrorMessage(error, "Couldn't remove the item."));
    } finally {
      setRemoving(null);
    }
  };

  const done = async () => {
    const parsed = resultToValues(result);
    if ("error" in parsed) {
      setSubmitError(parsed.error);
      return;
    }
    setCommitting("done");
    setSubmitError(null);
    try {
      await setResult({
        caseId,
        resultKind: result.kind as SuggestionKind,
        resultValues: parsed.values,
        noShowHeld: result.attended === "yes",
      });
      await commitList({ caseId });
    } catch (error) {
      setSubmitError(getErrorMessage(error, "Couldn't save your reading."));
    } finally {
      setCommitting(null);
    }
  };

  const skip = async () => {
    setCommitting("skip");
    setSubmitError(null);
    try {
      await commitList({ caseId, skipped: true });
    } catch (error) {
      setSubmitError(getErrorMessage(error, "Couldn't skip your list."));
    } finally {
      setCommitting(null);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-3.5 short:gap-3">
      <DetailCard title="Your own reading" meta="Step 1 of 2">
        <ReportNote>
          List what the prospect said before you see what the reading found.
          Click a line number in the transcript to fill the lines.
        </ReportNote>
        {ownItems.length === 0 ? (
          <SectionEmpty title="No items yet." className="border-b">
            Add each objection, struggle, goal and income figure the prospect
            said.
          </SectionEmpty>
        ) : (
          <ul aria-label="Your items" className="border-b">
            {ownItems.map((item) => {
              const values = labelValueWords(item);
              return (
                <li
                  key={item.labelId}
                  className="flex min-h-11 items-center gap-3 border-b px-4 py-2 last:border-b-0"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {labelTitle(item)}
                    </p>
                    {values.length ? (
                      <p className="truncate text-[13px] text-muted-foreground">
                        {values.join(" · ")}
                      </p>
                    ) : null}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={removing === item.labelId || committing !== null}
                    onClick={() => void remove(item.labelId)}
                    aria-label={`Remove ${labelTitle(item)}`}
                  >
                    Remove
                  </Button>
                </li>
              );
            })}
          </ul>
        )}

        <form
          className="@container flex flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
          aria-label="Add an item"
        >
          <div className="divide-y">
            <FormRow label="Kind">
              <ToggleGroup
                type="single"
                value={draft.itemClass}
                onValueChange={(value) => {
                  if (value)
                    update({ itemClass: value as ItemKind, category: "" });
                }}
                aria-label="Kind"
                className={SEGMENT_GROUP}
              >
                {ITEM_KINDS.map((kind) => (
                  <ToggleGroupItem key={kind} value={kind} className={SEGMENT}>
                    {KIND_WORDS[kind]}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </FormRow>
            <FormRow
              label="Category"
              htmlFor="item-category"
              description={definition}
            >
              <NativeSelect
                id="item-category"
                className={SELECT}
                value={draft.category}
                onChange={(event) => update({ category: event.target.value })}
              >
                <NativeSelectOption value="">
                  Choose a category
                </NativeSelectOption>
                {Object.entries(categories).map(([key, entry]) => (
                  <NativeSelectOption key={key} value={key}>
                    {entry.label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </FormRow>
            <FormRow
              label="Lines"
              htmlFor="item-line-start"
              description={
                draft.target === "end" && draft.lineStart
                  ? "Click another line number to end the span there."
                  : "Click a line number in the transcript, or type it."
              }
            >
              <div className="flex items-center gap-2">
                <Input
                  id="item-line-start"
                  inputMode="numeric"
                  aria-label="First line"
                  className={NUMBER_INPUT}
                  value={draft.lineStart}
                  onChange={(event) =>
                    update({ lineStart: event.target.value, target: "end" })
                  }
                  placeholder="From"
                />
                <span className="text-[13px] text-muted-foreground">to</span>
                <Input
                  inputMode="numeric"
                  aria-label="Last line"
                  className={NUMBER_INPUT}
                  value={draft.lineEnd}
                  onChange={(event) =>
                    update({ lineEnd: event.target.value, target: "start" })
                  }
                  placeholder="To"
                />
              </div>
            </FormRow>
            {draft.itemClass === "objection" ? (
              <FormRow label="Resolution" htmlFor="item-resolution">
                <NativeSelect
                  id="item-resolution"
                  className={SELECT}
                  value={draft.resolution}
                  onChange={(event) =>
                    update({
                      resolution: event.target.value as Resolution | "",
                    })
                  }
                >
                  <NativeSelectOption value="">Not set</NativeSelectOption>
                  {Object.entries(RESOLUTION_WORDS).map(([key, label]) => (
                    <NativeSelectOption key={key} value={key}>
                      {label}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </FormRow>
            ) : null}
            {draft.itemClass === "income" ? (
              <>
                <FormRow label="Current or target" htmlFor="item-scenario">
                  <NativeSelect
                    id="item-scenario"
                    className={SELECT}
                    value={draft.scenario}
                    onChange={(event) =>
                      update({
                        scenario: event.target.value as IncomeScenario | "",
                      })
                    }
                  >
                    <NativeSelectOption value="">Not set</NativeSelectOption>
                    {Object.entries(SCENARIO_WORDS).map(([key, label]) => (
                      <NativeSelectOption key={key} value={key}>
                        {label}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </FormRow>
                <FormRow
                  label="Amount"
                  htmlFor="item-min"
                  description="One figure: fill the lowest only."
                >
                  <div className="flex items-center gap-2">
                    <Input
                      id="item-min"
                      inputMode="decimal"
                      aria-label="Lowest amount"
                      className={NUMBER_INPUT}
                      value={draft.min}
                      onChange={(event) => update({ min: event.target.value })}
                      placeholder="Lowest"
                    />
                    <span className="text-[13px] text-muted-foreground">
                      to
                    </span>
                    <Input
                      inputMode="decimal"
                      aria-label="Highest amount"
                      className={NUMBER_INPUT}
                      value={draft.max}
                      onChange={(event) => update({ max: event.target.value })}
                      placeholder="Highest"
                    />
                  </div>
                </FormRow>
                <FormRow label="Currency" htmlFor="item-currency">
                  <NativeSelect
                    id="item-currency"
                    className={SELECT}
                    value={draft.currency}
                    onChange={(event) =>
                      update({ currency: event.target.value })
                    }
                  >
                    <NativeSelectOption value="">Not said</NativeSelectOption>
                    {EVAL_CURRENCIES.map((currency) => (
                      <NativeSelectOption key={currency} value={currency}>
                        {currency}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </FormRow>
                <FormRow label="Period" htmlFor="item-period">
                  <NativeSelect
                    id="item-period"
                    className={SELECT}
                    value={draft.period}
                    onChange={(event) =>
                      update({
                        period: event.target.value as IncomePeriod | "",
                      })
                    }
                  >
                    <NativeSelectOption value="">Not set</NativeSelectOption>
                    {Object.entries(PERIOD_CHOICES).map(([key, label]) => (
                      <NativeSelectOption key={key} value={key}>
                        {label}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </FormRow>
              </>
            ) : null}
          </div>
          {itemError ? (
            <p
              role="alert"
              className="border-t px-4 py-2 text-[13px] text-danger-ink"
            >
              {itemError}
            </p>
          ) : null}
          <div className="flex justify-end border-t px-4 py-2.5">
            <Button
              type="submit"
              variant="outline"
              size="sm"
              disabled={adding || transcriptGone || committing !== null}
            >
              {adding ? <Spinner data-icon="inline-start" /> : null}
              Add item
            </Button>
          </div>
        </form>
      </DetailCard>

      <DetailCard title="How did the call end?">
        <div className="@container divide-y">
          <FormRow label="Result" htmlFor="result-kind">
            <NativeSelect
              id="result-kind"
              className={SELECT}
              value={result.kind}
              onChange={(event) =>
                updateResult({
                  kind: event.target.value as SuggestionKind | "",
                })
              }
            >
              <NativeSelectOption value="">Choose</NativeSelectOption>
              {RESULT_CHOICES.map((choice) => (
                <NativeSelectOption key={choice.value} value={choice.value}>
                  {choice.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </FormRow>
          {resultFields.has("amountMinor") ? (
            <FormRow label="Amount" htmlFor="result-amount">
              <Input
                id="result-amount"
                inputMode="decimal"
                className={NUMBER_INPUT}
                value={result.amount}
                onChange={(event) =>
                  updateResult({ amount: event.target.value })
                }
                placeholder="Not said"
              />
            </FormRow>
          ) : null}
          {resultFields.has("currency") ? (
            <FormRow label="Currency" htmlFor="result-currency">
              <div className="flex flex-col gap-2">
                <NativeSelect
                  id="result-currency"
                  className={SELECT}
                  value={result.currency}
                  onChange={(event) =>
                    updateResult({ currency: event.target.value })
                  }
                >
                  <NativeSelectOption value="">Not said</NativeSelectOption>
                  {EVAL_CURRENCIES.map((currency) => (
                    <NativeSelectOption key={currency} value={currency}>
                      {currency}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                {result.currency === "USD" ? (
                  <label
                    htmlFor="result-assumed"
                    className="flex min-h-6 items-center gap-2 text-sm"
                  >
                    <Checkbox
                      id="result-assumed"
                      checked={result.currencyAssumed}
                      onCheckedChange={(checked) =>
                        updateResult({ currencyAssumed: checked === true })
                      }
                    />
                    Only &ldquo;dollars&rdquo; was said
                  </label>
                ) : null}
              </div>
            </FormRow>
          ) : null}
          {resultFields.has("paymentType") ? (
            <FormRow label="Payment type" htmlFor="result-payment-type">
              <NativeSelect
                id="result-payment-type"
                className={SELECT}
                value={result.paymentType}
                onChange={(event) =>
                  updateResult({
                    paymentType: event.target
                      .value as ResultDraft["paymentType"],
                  })
                }
              >
                <NativeSelectOption value="">Not said</NativeSelectOption>
                {Object.entries(PAYMENT_TYPE_WORDS).map(([key, label]) => (
                  <NativeSelectOption key={key} value={key}>
                    {label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </FormRow>
          ) : null}
          {resultFields.has("callbackAt") ? (
            <FormRow label="Call back at" htmlFor="result-callback">
              <Input
                id="result-callback"
                type="datetime-local"
                className="h-8 w-fit"
                value={result.callbackAt}
                onChange={(event) =>
                  updateResult({ callbackAt: event.target.value })
                }
              />
            </FormRow>
          ) : null}
          {resultFields.has("contactMethod") ? (
            <FormRow label="Contact by" htmlFor="result-contact">
              <NativeSelect
                id="result-contact"
                className={SELECT}
                value={result.contactMethod}
                onChange={(event) =>
                  updateResult({
                    contactMethod: event.target
                      .value as ResultDraft["contactMethod"],
                  })
                }
              >
                <NativeSelectOption value="">Not said</NativeSelectOption>
                {Object.entries(CONTACT_WORDS).map(([key, label]) => (
                  <NativeSelectOption key={key} value={key}>
                    {label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </FormRow>
          ) : null}
          {resultFields.has("lossCategory") ? (
            <FormRow label="Loss category" htmlFor="result-loss">
              <NativeSelect
                id="result-loss"
                className={SELECT}
                value={result.lossCategory}
                onChange={(event) =>
                  updateResult({
                    lossCategory: event.target
                      .value as ResultDraft["lossCategory"],
                  })
                }
              >
                <NativeSelectOption value="">Not said</NativeSelectOption>
                {Object.entries(LOSS_CATEGORIES).map(([key, label]) => (
                  <NativeSelectOption key={key} value={key}>
                    {label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </FormRow>
          ) : null}
          {resultFields.has("noShowReason") ? (
            <FormRow label="No-show reason" htmlFor="result-no-show">
              <NativeSelect
                id="result-no-show"
                className={SELECT}
                value={result.noShowReason}
                onChange={(event) =>
                  updateResult({
                    noShowReason: event.target
                      .value as ResultDraft["noShowReason"],
                  })
                }
              >
                <NativeSelectOption value="">Not said</NativeSelectOption>
                {Object.entries(NO_SHOW_REASON_WORDS).map(([key, label]) => (
                  <NativeSelectOption key={key} value={key}>
                    {label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </FormRow>
          ) : null}
          <FormRow label="Did the prospect attend?">
            <RadioGroup
              value={result.attended}
              onValueChange={(value) =>
                updateResult({ attended: value as "yes" | "no" })
              }
              aria-label="Did the prospect attend?"
              className="flex gap-5"
            >
              <label
                htmlFor="attended-yes"
                className="flex min-h-6 items-center gap-2 text-sm"
              >
                <RadioGroupItem id="attended-yes" value="yes" />
                Yes
              </label>
              <label
                htmlFor="attended-no"
                className="flex min-h-6 items-center gap-2 text-sm"
              >
                <RadioGroupItem id="attended-no" value="no" />
                No
              </label>
            </RadioGroup>
          </FormRow>
        </div>
        {submitError ? (
          <p
            role="alert"
            className="border-t px-4 py-2 text-[13px] text-danger-ink"
          >
            {submitError}
          </p>
        ) : null}
        <DetailCardFooter className="bg-background">
          <span className="text-[13px] font-normal">
            Once the reading shows, your list can&apos;t change.
          </span>
          <Button
            type="button"
            className="font-semibold"
            disabled={!resultReady || committing !== null || transcriptGone}
            onClick={() => void done()}
          >
            {committing === "done" ? (
              <Spinner data-icon="inline-start" />
            ) : null}
            Done, show the reading
          </Button>
        </DetailCardFooter>
      </DetailCard>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={ownItems.length > 0 || committing !== null}
          onClick={() => void skip()}
        >
          {committing === "skip" ? <Spinner data-icon="inline-start" /> : null}
          Skip my own list
        </Button>
        <p className="text-[13px] text-muted-foreground">
          {ownItems.length > 0 ? "Remove your items to skip. " : null}
          Skipped calls don&apos;t count toward the missed-item checks.
        </p>
      </div>
    </div>
  );
}
