import { z } from "zod";
import {
  INCOME_PERIODS,
  RESOLUTIONS,
  type IncomePeriod,
  type IncomeScenario,
  type Resolution,
} from "../../lib/callInsights/taxonomy";

/**
 * Reads the model's JSON answer. The answer is flat (see prompt.ts for why):
 * one `items` list and one list of attendance quotes, with an empty string, 0
 * or "none" where a value does not apply. This module checks its shape and
 * turns it into `RawExtraction`, the shape validate.ts works on. A wrong shape
 * fails with a message that never contains the answer's text.
 */

export const CURRENCIES_AS_SAID = [
  "usd",
  "cad",
  "aud",
  "eur",
  "gbp",
  "hnl",
  "mxn",
  "dollars_unspecified",
  "symbol_only",
  "other",
  "none",
] as const;
export type CurrencyAsSaid = (typeof CURRENCIES_AS_SAID)[number];

/**
 * What a result quote establishes. A fixed list, never the model's own words:
 * a free-text label would be prospect-derived text that outlives the transcript.
 */
export const RESULT_QUOTE_LABELS = [
  "price",
  "agreement",
  "payment",
  "timing",
  "decline",
  "other",
] as const;
export type ResultQuoteLabel = (typeof RESULT_QUOTE_LABELS)[number];

export const ATTENDANCE_QUOTE_TYPES = [
  "waiting",
  "leaving",
  "tried_to_reach",
  "someone_there",
  "second_person",
  "not_sales_call",
] as const;

type RawQuote = { quote: string; lineIndex: number };

export type RawAttendance = {
  reading: "absent" | "present" | "not_sales_call" | "unclear";
  waiting: RawQuote[];
  leaving: RawQuote[];
  triedToReach: RawQuote[];
  someoneThere: RawQuote[];
  secondPerson: RawQuote[];
  notSalesCall: RawQuote[];
  reachOutcome?: "cant_make_it" | "trouble_joining";
};

export type RawExtraction = {
  objections: Array<
    RawQuote & {
      category: string;
      statement: string;
      resolution: Resolution;
      resolutionQuote?: string;
      resolutionLineIndex?: number;
    }
  >;
  struggles: Array<RawQuote & { category: string; statement: string }>;
  goals: Array<
    RawQuote & {
      category: string;
      statement: string;
      targetAmount?: string;
      targetAmountMax?: string;
      targetCurrency?: CurrencyAsSaid;
      targetPeriod?: IncomePeriod;
      deadline?: string;
    }
  >;
  income: Array<
    RawQuote & {
      kind: string;
      scenario: IncomeScenario;
      amountMin: string;
      amountMax?: string;
      currencyAsSaid: CurrencyAsSaid;
      period: IncomePeriod;
      statement: string;
    }
  >;
  primaryBlocker: string;
  result: {
    kind: "paid" | "promised" | "call_back" | "lost" | "no_decision" | "none";
    quotes: Array<RawQuote & { label: ResultQuoteLabel }>;
    amount?: string;
    amountRole?: "this_payment" | "full_price";
    currencyAsSaid?: CurrencyAsSaid;
    paymentType?: "monthly" | "split" | "pif" | "deposit";
    installments?: number;
    programHeard?: string;
    callbackDateTimeLocal?: string;
    contactMethod?: "call" | "text";
    lossCategory?: string;
  };
  attendance: RawAttendance;
};

export class FormatError extends Error {
  constructor() {
    super("Call insights response has an invalid format");
    this.name = "FormatError";
  }
}

const AMOUNT = /^\d+(?:\.\d+)?$/;
/** Null, an empty string, 0 and "none" all mean the value was not said. */
const absent = (value: unknown) =>
  value === null ||
  value === undefined ||
  value === "" ||
  value === 0 ||
  value === "none";
const text = z
  .string()
  .nullish()
  .transform((value) =>
    absent(value) ? undefined : value!.trim() || undefined,
  );
const count = z
  .number()
  .nullish()
  .transform((value) =>
    absent(value) || !Number.isInteger(value) || value! < 1
      ? undefined
      : value!,
  );
/** An amount in major units, or absent when missing or not a plain number. */
const amount = z
  .string()
  .nullish()
  .transform((value) => {
    const trimmed = value?.trim();
    return trimmed && AMOUNT.test(trimmed) ? trimmed : undefined;
  });
function choice<T extends string>(values: readonly T[]) {
  return z
    .string()
    .nullish()
    .transform((value) =>
      (values as readonly string[]).includes(value ?? "")
        ? (value as T)
        : undefined,
    );
}
const currency = choice(CURRENCIES_AS_SAID);
const period = choice(INCOME_PERIODS);
const lineIndex = z.number().int();
const quote = z.object({ quote: z.string(), lineIndex: lineIndex.positive() });

const flatAttendance = z.object({
  reading: z.enum(["absent", "present", "not_sales_call", "unclear"]),
  quotes: z.array(quote.extend({ type: z.string() })),
  reachOutcome: choice(["cant_make_it", "trouble_joining"] as const),
});

const flatExtraction = z.object({
  items: z.array(
    quote.extend({
      kind: z.enum(["objection", "struggle", "goal", "income"]),
      category: z.string(),
      statement: z.string(),
      resolution: choice(RESOLUTIONS),
      resolutionQuote: text,
      resolutionLineIndex: count,
      scenario: choice(["current", "target"] as const),
      amountMin: amount,
      amountMax: amount,
      currencyAsSaid: currency,
      period,
      deadline: text,
    }),
  ),
  primaryBlocker: z
    .string()
    .nullish()
    .transform((value) => value ?? "none"),
  result: z.object({
    kind: z.enum([
      "paid",
      "promised",
      "call_back",
      "lost",
      "no_decision",
      "none",
    ]),
    quotes: z.array(
      quote.extend({
        label: z
          .string()
          .nullish()
          .transform(
            (value): ResultQuoteLabel =>
              (RESULT_QUOTE_LABELS as readonly string[]).includes(value ?? "")
                ? (value as ResultQuoteLabel)
                : "other",
          ),
      }),
    ),
    amount,
    amountRole: choice(["this_payment", "full_price"] as const),
    currencyAsSaid: currency,
    paymentType: choice(["monthly", "split", "pif", "deposit"] as const),
    installments: count,
    programHeard: text,
    callbackDateTimeLocal: text,
    contactMethod: choice(["call", "text"] as const),
    lossCategory: text,
  }),
  attendance: flatAttendance,
});

function parseJson<T>(input: string, schema: z.ZodType<T>): T {
  try {
    const result = schema.safeParse(JSON.parse(input));
    if (result.success) return result.data;
  } catch {
    // Parser details could echo the answer. A fixed error replaces them.
  }
  throw new FormatError();
}

function attendanceFrom(flat: z.infer<typeof flatAttendance>): RawAttendance {
  const of = (type: (typeof ATTENDANCE_QUOTE_TYPES)[number]): RawQuote[] =>
    flat.quotes
      .filter((entry) => entry.type === type)
      .map((entry) => ({ quote: entry.quote, lineIndex: entry.lineIndex }));
  return {
    reading: flat.reading,
    waiting: of("waiting"),
    leaving: of("leaving"),
    triedToReach: of("tried_to_reach"),
    someoneThere: of("someone_there"),
    secondPerson: of("second_person"),
    notSalesCall: of("not_sales_call"),
    reachOutcome: flat.reachOutcome,
  };
}

export function parseExtraction(input: string): RawExtraction {
  const flat = parseJson(input, flatExtraction);
  const out: RawExtraction = {
    objections: [],
    struggles: [],
    goals: [],
    income: [],
    primaryBlocker: flat.primaryBlocker,
    result: flat.result,
    attendance: attendanceFrom(flat.attendance),
  };
  for (const item of flat.items) {
    const base = {
      category: item.category,
      statement: item.statement,
      quote: item.quote,
      lineIndex: item.lineIndex,
    };
    if (item.kind === "objection")
      out.objections.push({
        ...base,
        resolution: item.resolution ?? "unknown",
        resolutionQuote: item.resolutionQuote,
        resolutionLineIndex: item.resolutionLineIndex,
      });
    else if (item.kind === "struggle") out.struggles.push(base);
    else if (item.kind === "goal")
      out.goals.push({
        ...base,
        targetAmount: item.amountMin,
        targetAmountMax: item.amountMax,
        targetCurrency:
          item.currencyAsSaid === "none" ? undefined : item.currencyAsSaid,
        targetPeriod: item.period,
        deadline: item.deadline,
      });
    // An income item with no usable amount says nothing a report can use.
    else if (item.amountMin !== undefined)
      out.income.push({
        kind: item.category,
        scenario: item.scenario ?? "current",
        amountMin: item.amountMin,
        amountMax: item.amountMax,
        currencyAsSaid: item.currencyAsSaid ?? "none",
        period: item.period ?? "unknown",
        statement: item.statement,
        quote: item.quote,
        lineIndex: item.lineIndex,
      });
  }
  return out;
}

export function parseAttendanceOnly(input: string): RawAttendance {
  return attendanceFrom(parseJson(input, flatAttendance));
}
