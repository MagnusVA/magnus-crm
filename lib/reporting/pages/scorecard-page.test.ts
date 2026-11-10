import { describe, expect, it } from "vitest";
import type { Id } from "@/convex/_generated/dataModel";
import type { CashOutput, FollowThroughOutput, FunnelOutput, OriginsOutput } from "@/convex/reports/scorecard";
import {
  listCurrencies,
  pickMainCurrency,
  resolvedReportRange,
  shownCurrency,
} from "@/app/workspace/reports/scorecard/_components/report-money";
import {
  FUNNEL_PROGRAM_NOTE,
  buildScorecardDocument,
  cashPerWonDeal,
  groupByWeek,
  scorecardCurrencyWeights,
  weekLabel,
} from "@/app/workspace/reports/scorecard/_components/scorecard-shape";
import { renderSummaryCsv } from "@/lib/reporting/export";

// The Scorecard page's shaping: business weeks from the readers' days, the
// currency it opens on, and the export document built from what it shows.

const day = (dayKey: string, bookingsMade: number, cash: FunnelOutput["byDay"][number]["cash"] = []) => ({
  dayKey,
  bookingsMade,
  callsHeld: bookingsMade > 0 ? 1 : 0,
  dealsWon: 0,
  cash,
});

// Wednesday Oct 29 to Tuesday Nov 11, 2025 in business days: two cut weeks around a whole one.
const byDay: FunnelOutput["byDay"] = [];
for (let date = new Date(Date.UTC(2025, 9, 29)); date <= new Date(Date.UTC(2025, 10, 11)); date.setUTCDate(date.getUTCDate() + 1)) {
  const key = date.toISOString().slice(0, 10);
  byDay.push(
    day(key, 1, key === "2025-11-03" ? [{ currency: "USD", cashMinor: 50_000, finalMinor: 40_000 }, { currency: "EUR", cashMinor: 9_000, finalMinor: 9_000 }] : key === "2025-11-04" ? [{ currency: "USD", cashMinor: 10_000, finalMinor: 10_000 }] : []),
  );
}

const funnel: FunnelOutput = {
  stages: { prospect: 40, in_conversation: 30, qualified: 12, booked: 9, showed: 6, customer: 2 },
  cohort: { entered: 30, qualified: 10, booked: 8, showed: 5, customer: 2 },
  activity: {
    bookingsMade: 14,
    callsHeld: 14,
    dealsWon: 2,
    cash: [
      { currency: "EUR", cashMinor: 9_000, finalMinor: 9_000 },
      { currency: "USD", cashMinor: 60_000, finalMinor: 50_000 },
    ],
  },
  byDay,
};

const program = (id: string, name: string, payments: number, cashMinor: number) => ({
  programId: id as Id<"tenantPrograms">,
  name,
  cashMinor,
  finalMinor: cashMinor,
  payments,
  dealsWon: 1,
  finalOnWonDealsMinor: cashMinor,
});

const cash: CashOutput = {
  currencies: [
    {
      currency: "EUR",
      cashMinor: 9_000,
      finalMinor: 9_000,
      depositMinor: 0,
      byType: { pif: 9_000, split: 0, monthly: 0, deposit: 0 },
      byProgram: [program("p2", "Inner Circle", 1, 9_000)],
      depositsOnLostDeals: 0,
      finalOnWonDealsMinor: 9_000,
      dealsWon: 1,
    },
    {
      currency: "USD",
      cashMinor: 60_000,
      finalMinor: 50_000,
      depositMinor: 10_000,
      byType: { pif: 40_000, split: 10_000, monthly: 0, deposit: 10_000 },
      byProgram: [program("p1", "Accelerator", 3, 60_000)],
      depositsOnLostDeals: 2_500,
      finalOnWonDealsMinor: 45_000,
      dealsWon: 2,
    },
  ],
};

const followThrough: FollowThroughOutput = {
  due: 4,
  onTime: 2,
  late: 1,
  openOverdue: 1,
  byCloser: [{ userId: "u1" as Id<"users">, name: "Marco Reyes", due: 4, onTime: 2, late: 1, openOverdue: 1 }],
};

const origins: OriginsOutput = {
  origins: [
    { channel: "lead_gen", dealsWon: 1, cash: [{ currency: "USD", cashMinor: 60_000, finalMinor: 50_000 }] },
    { channel: "unknown", dealsWon: 0, cash: [] },
  ],
};

describe("groupByWeek", () => {
  const weeks = groupByWeek(byDay);

  it("cuts the days into Monday-to-Sunday business weeks and marks the cut ones", () => {
    expect(weeks.map((week) => [week.weekStart, week.weekEnd, week.days, week.partial])).toEqual([
      ["2025-10-29", "2025-11-02", 5, true],
      ["2025-11-03", "2025-11-09", 7, false],
      ["2025-11-10", "2025-11-11", 2, true],
    ]);
  });

  it("adds counts by week and keeps each currency's cash apart", () => {
    expect(weeks[1].bookingsMade).toBe(7);
    expect(weeks[1].cash).toEqual([
      { currency: "EUR", cashMinor: 9_000, finalMinor: 9_000 },
      { currency: "USD", cashMinor: 60_000, finalMinor: 50_000 },
    ]);
    expect(weeks[0].cash).toEqual([]);
  });

  it("sorts days that arrive out of order", () => {
    expect(groupByWeek([...byDay].reverse()).map((week) => week.weekStart)).toEqual(weeks.map((week) => week.weekStart));
  });

  it("names a week by its days in the range", () => {
    expect(weekLabel(weeks[0])).toBe("Oct 29 – Nov 2");
    expect(weekLabel({ weekStart: "2025-11-10", weekEnd: "2025-11-10" })).toBe("Nov 10");
  });
});

describe("the Scorecard's money", () => {
  it("divides final cash on won deals by deals won, and has no figure with none won", () => {
    expect(cashPerWonDeal({ finalOnWonDealsMinor: 45_000, dealsWon: 2 })).toBe(22_500);
    expect(cashPerWonDeal({ finalOnWonDealsMinor: 45_000, dealsWon: 0 })).toBeNull();
  });

  it("opens on the currency with the most payments, then US dollars, then alphabetical", () => {
    expect(pickMainCurrency(scorecardCurrencyWeights(cash, funnel, origins))).toBe("USD");
    expect(pickMainCurrency([{ currency: "EUR", weight: 1 }, { currency: "USD", weight: 1 }])).toBe("USD");
    expect(pickMainCurrency([{ currency: "GBP", weight: 0 }, { currency: "EUR", weight: 0 }])).toBe("EUR");
    expect(pickMainCurrency([])).toBeNull();
  });

  it("keeps a chosen currency only while it is in the range", () => {
    const currencies = listCurrencies(funnel.activity.cash, cash.currencies);
    expect(currencies).toEqual(["EUR", "USD"]);
    expect(shownCurrency("EUR", currencies, "USD")).toBe("EUR");
    expect(shownCurrency("GBP", currencies, "USD")).toBe("USD");
    expect(shownCurrency(null, [], null)).toBe("USD");
  });

  it("builds the readers' resolved range from the picker's days and window", () => {
    const range = resolvedReportRange(
      { startDayKey: "2025-11-03", endDayKeyExclusive: "2025-11-10" },
      { startDate: 1, endDate: 2 },
      { timeZone: "America/Tegucigalpa", dayStartHour: 1 },
    );
    expect(range).toEqual({
      startDate: "2025-11-03",
      endDateInclusive: "2025-11-09",
      fromMs: 1,
      toMs: 2,
      timeZone: "America/Tegucigalpa",
      dayStartHour: 1,
    });
  });
});

describe("buildScorecardDocument", () => {
  const document = buildScorecardDocument({
    words: "This week · Nov 3 – Nov 9",
    dayLine: "Days run 1:00 am to 1:00 am, America/Tegucigalpa time",
    programName: null,
    generatedAt: Date.parse("2025-11-09T18:00:00Z"),
    funnel,
    cash,
    followThrough,
    origins,
    answers: { fieldKey: "income", label: "Monthly income?", answers: [{ answer: "$10k+", people: 4, held: 3, won: 1 }] },
  });

  it("puts the band's figures first, cash once per currency", () => {
    expect(document.summary.map((item) => [item.label, item.value])).toEqual([
      ["People in conversation", "30"],
      ["Qualified", "12"],
      ["Bookings made", "14"],
      ["Calls held", "14"],
      ["Deals won", "2"],
      ["Cash (EUR)", "€90.00"],
      ["Final cash (EUR)", "€90.00"],
      ["Cash (USD)", "$600.00"],
      ["Final cash (USD)", "$500.00"],
    ]);
  });

  it("writes one table per card and ends with the definitions", () => {
    expect(document.tables.map((table) => table.title)).toEqual([
      "The funnel · in this range",
      "The funnel · cohort",
      "Cash",
      "Cash by payment type",
      "Programs",
      "Week by week",
      "Cash by week",
      "Follow-through",
      "Where the business came from",
      "What predicts a sale · Monthly income?",
      "Definitions",
    ]);
    expect(document.tables.at(-1)?.rows.map((row) => row.term)).toContain("Cash per won deal");
  });

  it("keeps money in its currency column and never sums currencies", () => {
    const cashTable = document.tables.find((table) => table.title === "Cash")!;
    expect(cashTable.columns.filter((column) => column.format === "money").every((column) => column.currencyKey === "currency")).toBe(true);
    expect(cashTable.rows).toEqual([
      { currency: "EUR", cash: 9_000, final: 9_000, deposits: 0, depositsOnLost: 0, dealsWon: 1, perWonDeal: 9_000 },
      { currency: "USD", cash: 60_000, final: 50_000, deposits: 10_000, depositsOnLost: 2_500, dealsWon: 2, perWonDeal: 22_500 },
    ]);
    const csv = new TextDecoder().decode(renderSummaryCsv(document));
    expect(csv).toContain("EUR,€90.00");
    expect(csv).toContain("USD,$600.00");
  });

  it("leads follow-through with the whole team and keeps a channel with no cash", () => {
    const follow = document.tables.find((table) => table.title === "Follow-through")!;
    expect(follow.rows[0]).toEqual({ closer: "All closers", due: 4, onTime: 2, late: 1, overdue: 1, share: 0.5 });
    const where = document.tables.find((table) => table.title === "Where the business came from")!;
    expect(where.rows).toContainEqual({ channel: "No first touch", dealsWon: 0, currency: null, cash: null });
  });

  it("says the funnel's people counts ignore a picked program", () => {
    expect(document.filters).toBe("All programs");
    const oneProgram = buildScorecardDocument({
      words: "",
      dayLine: "",
      programName: "Coaching",
      generatedAt: 0,
      funnel,
      cash,
      followThrough,
      origins,
      answers: null,
    });
    expect(oneProgram.filters).toBe(`Program: Coaching · ${FUNNEL_PROGRAM_NOTE}`);
  });

  it("leaves the answers table out until a question's answers are loaded", () => {
    const without = buildScorecardDocument({
      words: "",
      dayLine: "",
      programName: null,
      generatedAt: 0,
      funnel,
      cash,
      followThrough,
      origins,
      answers: null,
    });
    expect(without.tables.some((table) => table.title.startsWith("What predicts a sale"))).toBe(false);
  });
});
