/**
 * Test helper: writes a model answer in the flat shape the extraction schema
 * asks for (convex/callInsights/prompt.ts) from the nested shape tests are
 * easier to read in. Missing optional values become "", 0 or "none", the way
 * the model sends them.
 */
type Loose = Record<string, unknown>;
const list = (value: unknown): Loose[] =>
  Array.isArray(value) ? (value as Loose[]) : [];

const blankItem = {
  resolution: "none",
  resolutionQuote: "",
  resolutionLineIndex: 0,
  scenario: "none",
  amountMin: "",
  amountMax: "",
  currencyAsSaid: "none",
  period: "unknown",
  deadline: "",
};

export function flatAttendance(attendance: Loose = {}): Loose {
  const quotes = [
    ["waiting", "waiting"],
    ["leaving", "leaving"],
    ["triedToReach", "tried_to_reach"],
    ["someoneThere", "someone_there"],
    ["secondPerson", "second_person"],
    ["notSalesCall", "not_sales_call"],
  ].flatMap(([field, type]) =>
    list(attendance[field]).map((quote) => ({ type, ...quote })),
  );
  return {
    reading: attendance.reading ?? "unclear",
    quotes,
    reachOutcome: attendance.reachOutcome ?? "none",
  };
}

export function flatAnswer(nested: Loose = {}): Loose {
  const base = (item: Loose) => ({
    category: item.category,
    statement: item.statement,
    quote: item.quote,
    lineIndex: item.lineIndex,
  });
  const items = [
    ...list(nested.objections).map((item) => ({
      ...blankItem,
      kind: "objection",
      ...base(item),
      resolution: item.resolution ?? "unknown",
      resolutionQuote: item.resolutionQuote ?? "",
      resolutionLineIndex: item.resolutionLineIndex ?? 0,
    })),
    ...list(nested.struggles).map((item) => ({
      ...blankItem,
      kind: "struggle",
      ...base(item),
    })),
    ...list(nested.goals).map((item) => ({
      ...blankItem,
      kind: "goal",
      ...base(item),
      amountMin: item.targetAmount ?? "",
      amountMax: item.targetAmountMax ?? "",
      currencyAsSaid: item.targetCurrency ?? "none",
      period: item.targetPeriod ?? "unknown",
      deadline: item.deadline ?? "",
    })),
    ...list(nested.income).map((item) => ({
      ...blankItem,
      kind: "income",
      ...base({ ...item, category: item.kind }),
      scenario: item.scenario ?? "current",
      amountMin: item.amountMin ?? "",
      amountMax: item.amountMax ?? "",
      currencyAsSaid: item.currencyAsSaid ?? "none",
      period: item.period ?? "unknown",
    })),
  ];
  const result = (nested.result ?? {}) as Loose;
  return {
    items,
    primaryBlocker: nested.primaryBlocker ?? "none",
    result: {
      kind: result.kind ?? "none",
      quotes: result.quotes ?? [],
      amount: result.amount ?? "",
      amountRole: result.amountRole ?? "none",
      currencyAsSaid: result.currencyAsSaid ?? "none",
      paymentType: result.paymentType ?? "none",
      installments: result.installments ?? 0,
      programHeard: result.programHeard ?? "",
      callbackDateTimeLocal: result.callbackDateTimeLocal ?? "",
      contactMethod: result.contactMethod ?? "none",
      lossCategory: result.lossCategory ?? "none",
    },
    attendance: flatAttendance((nested.attendance ?? {}) as Loose),
  };
}
