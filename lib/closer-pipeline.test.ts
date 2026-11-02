import { describe, expect, it } from "vitest";
import { businessDayStart, DEFAULT_BUSINESS_DAY } from "@/lib/businessDay";
import {
  buildBookPrograms,
  compareBookDeals,
  dealStanding,
  matchesBookFilter,
  NO_BOOK_FILTER,
  recordAgeOf,
  summarizeBook,
  visibleBookDeals,
  formatCash,
  isMonthKey,
  mainCurrency,
  pipelineMonth,
  resolveNextStep,
  shiftMonth,
  type DeskDeal,
  type DeskInput,
} from "./closer-pipeline";

const setting = DEFAULT_BUSINESS_DAY;
const HOUR = 3_600_000;

describe("pipelineMonth", () => {
  it("reads the running month from its first business day, against last month cut to the same length", () => {
    const start = businessDayStart("2026-10-01", setting);
    const cutoff = start + 10 * 24 * HOUR;
    const month = pipelineMonth("2026-10", "2026-10-11", cutoff, setting);

    expect(month).toMatchObject({
      key: "2026-10",
      isCurrent: true,
      startDate: start,
      endDate: businessDayStart("2026-11-01", setting),
      name: "October",
      day: 11,
      days: 31,
      comparisonLabel: "vs this time last month",
    });
    const previousStart = businessDayStart("2026-09-01", setting);
    expect(month.previous).toEqual({ startDate: previousStart, endDate: previousStart + 10 * 24 * HOUR });
  });

  it("compares a past month with the whole month before it", () => {
    const month = pipelineMonth("2025-12", "2026-10-11", 0, setting);
    expect(month).toMatchObject({
      isCurrent: false,
      name: "December 2025",
      day: 31,
      comparisonLabel: "vs November",
    });
    expect(month.previous).toEqual({
      startDate: businessDayStart("2025-11-01", setting),
      endDate: businessDayStart("2025-12-01", setting),
    });
  });

  it("reads a month after this one as this one", () => {
    expect(pipelineMonth("2027-01", "2026-10-11", 0, setting).key).toBe("2026-10");
  });

  it("checks and moves month keys across years", () => {
    expect(isMonthKey("2026-10")).toBe(true);
    expect(isMonthKey("2026-13")).toBe(false);
    expect(isMonthKey(null)).toBe(false);
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2025-12", 1)).toBe("2026-01");
  });
});

describe("cash", () => {
  it("leads with the currency with the most payments, never comparing amounts across currencies", () => {
    // More lempiras than dollars in raw amount, but fewer payments.
    const month = [
      { currency: "HNL", amountMinor: 2_500_000, paymentCount: 1 },
      { currency: "USD", amountMinor: 1_840_000, paymentCount: 6 },
    ];
    expect(mainCurrency(month)).toBe("USD");
    expect(mainCurrency([{ currency: "HNL", amountMinor: 1, paymentCount: 3 }, { currency: "USD", amountMinor: 9, paymentCount: 1 }])).toBe("HNL");
  });

  it("breaks a tie with last month's main currency, then dollars, and falls back with no payments", () => {
    const tie = [
      { currency: "EUR", amountMinor: 9, paymentCount: 2 },
      { currency: "HNL", amountMinor: 1, paymentCount: 2 },
      { currency: "USD", amountMinor: 5, paymentCount: 2 },
    ];
    expect(mainCurrency(tie, "HNL")).toBe("HNL");
    expect(mainCurrency(tie)).toBe("USD");
    expect(mainCurrency([], "EUR")).toBe("EUR");
    expect(mainCurrency([])).toBe("USD");
  });

  it("drops the cents from whole amounts and signs a change with a true minus", () => {
    expect(formatCash(1_840_000, "USD")).toBe("$18,400");
    expect(formatCash(1_840_050, "USD")).toBe("$18,400.50");
    expect(formatCash(630_000, "USD", true)).toBe("+$6,300");
    expect(formatCash(-630_000, "USD", true)).toBe("\u2212$6,300");
    expect(formatCash(0, "USD")).toBe("$0");
  });
});

describe("resolveNextStep", () => {
  const now = 1_000_000;
  const link = { kind: "link" as const, reschedule: false, sentAt: 10 };
  const task = { kind: "task" as const, method: "call" as const, dueAt: now + 5 };

  it("shows the next call while it is ahead, whatever task sits beside it", () => {
    expect(resolveNextStep({ callAt: now + 60, task }, now)).toEqual({
      step: { kind: "call", at: now + 60 },
      missedCallAt: null,
    });
  });

  it("falls back to the open task once the call has passed with no result", () => {
    expect(resolveNextStep({ callAt: now - 60, task: link }, now)).toEqual({
      step: link,
      missedCallAt: now - 60,
    });
    expect(resolveNextStep({ callAt: null, task }, now)).toEqual({ step: task, missedCallAt: null });
  });

  it("has no next step when the call has passed and there is no task", () => {
    expect(resolveNextStep({ callAt: now - 60, task: null }, now)).toEqual({
      step: null,
      missedCallAt: now - 60,
    });
    expect(resolveNextStep({ callAt: null, task: null }, now).step).toBeNull();
  });
});

const DAY = 86_400_000;
const NOW = 200 * DAY;
type Step = { kind: "call"; at: number } | DeskDeal["nextStep"]["task"];
/** A deal whose step is `step`: a call ahead, a task, a link, or none. */
const deal = (
  id: string,
  programKey: string,
  step: Step,
  extra: Partial<DeskDeal> = {},
): DeskDeal => ({
  opportunityId: id,
  leadId: `lead-${id}`,
  personName: id,
  position: "booked",
  programKey,
  nextStep:
    step?.kind === "call" ? { callAt: NOW + step.at, task: null } : { callAt: null, task: step },
  lastActivityAt: NOW - DAY,
  ...extra,
});
/** A deal whose call `daysAgo` days back was never recorded, with `task` beside it. */
const missed = (id: string, programKey: string, daysAgo: number, task: Step = null): DeskDeal =>
  deal(id, programKey, null, {
    nextStep: { callAt: NOW - daysAgo * DAY, task: task?.kind === "call" ? null : task },
  });

const usd = (amountMinor: number, paymentCount = 1) => [{ currency: "USD", amountMinor, paymentCount }];

describe("dealStanding", () => {
  it("is ahead with a step, even beside a call that was never recorded", () => {
    const link = { kind: "link" as const, reschedule: false, sentAt: NOW - DAY };
    expect(dealStanding(missed("a", "p", 5, link), NOW)).toEqual({
      state: "ahead",
      step: link,
      missedCallAt: NOW - 5 * DAY,
    });
    expect(dealStanding(deal("b", "p", { kind: "call", at: 60 }), NOW).state).toBe("ahead");
  });

  it("is not recorded when the call passed and nothing follows it, else has no next step", () => {
    expect(dealStanding(missed("a", "p", 5), NOW).state).toBe("not_recorded");
    expect(dealStanding(deal("b", "p", null), NOW).state).toBe("no_step");
  });

  it("ages a call never recorded in three bands", () => {
    expect(recordAgeOf(NOW - 29 * DAY, NOW)).toBe("under_30");
    expect(recordAgeOf(NOW - 30 * DAY, NOW)).toBe("30_90");
    expect(recordAgeOf(NOW - 90 * DAY, NOW)).toBe("30_90");
    expect(recordAgeOf(NOW - 91 * DAY, NOW)).toBe("over_90");
  });
});

describe("the book", () => {
  const deals = [
    deal("ahead-call", "acc", { kind: "call", at: 5_000 }, { position: "follow_up" }),
    deal("ahead-task", "acc", { kind: "task", method: "call", dueAt: NOW - 1_000 }),
    deal("ahead-link", "none", { kind: "link", reschedule: true, sentAt: NOW - 2 * DAY }),
    deal("idle-old", "acc", null, { lastActivityAt: NOW - 9 * DAY, position: "call_held" }),
    deal("idle-new", "disc", null, { lastActivityAt: NOW - 2 * DAY }),
    missed("nr-10", "acc", 10),
    missed("nr-120", "acc", 120),
    missed("nr-45", "none", 45),
  ];

  it("counts the book by stage, state and age of the calls never recorded", () => {
    expect(summarizeBook(deals, NOW)).toEqual({
      total: 8,
      positions: { booked: 6, call_held: 1, follow_up: 1 },
      ahead: 3,
      noStep: 2,
      notRecorded: 3,
      ages: { under_30: 1, "30_90": 1, over_90: 1 },
      oldestMissedAt: NOW - 120 * DAY,
    });
  });

  it("orders by what's next: steps by time with links after, idle deals by latest activity, then calls never recorded oldest first", () => {
    expect([...deals].sort(compareBookDeals(NOW)).map((entry) => entry.opportunityId)).toEqual([
      "ahead-task",
      "ahead-call",
      "ahead-link",
      "idle-new",
      "idle-old",
      "nr-120",
      "nr-45",
      "nr-10",
    ]);
  });

  it("keeps the open row's deal listed after it leaves the filter or the page", () => {
    const ids = (openId: string | null) =>
      visibleBookDeals(deals, { ...NO_BOOK_FILTER, state: "no_step" }, openId, NOW, 25).rows.map(
        (entry) => entry.opportunityId,
      );
    expect(ids(null)).toEqual(["idle-new", "idle-old"]);
    // A next step was just set from the open row: the deal is Ahead now.
    expect(ids("ahead-call")).toEqual(["ahead-call", "idle-new", "idle-old"]);

    // 30 Ahead deals due before the open one: it would sort past a 25-row page.
    const busy = [
      ...Array.from({ length: 30 }, (_, i) =>
        deal(`due-${i}`, "acc", { kind: "task", method: "call", dueAt: NOW + i * 1_000 }),
      ),
      deal("open", "acc", { kind: "call", at: DAY }),
    ];
    const page = visibleBookDeals(busy, { ...NO_BOOK_FILTER, state: "ahead" }, "open", NOW, 25);
    expect(page.rows).toHaveLength(26);
    expect(page.rows.at(-1)?.opportunityId).toBe("open");
    expect(page.matched).toBe(31);
    expect(visibleBookDeals(busy, { ...NO_BOOK_FILTER, state: "ahead" }, null, NOW, 25).rows).toHaveLength(25);
  });

  it("filters by state, by age within calls never recorded, and by program", () => {
    const ids = (filter: Parameters<typeof matchesBookFilter>[1]) =>
      deals.filter((entry) => matchesBookFilter(entry, filter, NOW)).map((entry) => entry.opportunityId);
    expect(ids(NO_BOOK_FILTER)).toHaveLength(8);
    expect(ids({ ...NO_BOOK_FILTER, state: "no_step" })).toEqual(["idle-old", "idle-new"]);
    expect(ids({ state: "not_recorded", age: "over_90", programKey: null })).toEqual(["nr-120"]);
    expect(ids({ state: "not_recorded", age: null, programKey: "acc" })).toEqual(["nr-10", "nr-120"]);
    expect(ids({ ...NO_BOOK_FILTER, programKey: "none" })).toEqual(["ahead-link", "nr-45"]);
  });
});

describe("buildBookPrograms", () => {
  const input: DeskInput = {
    cash: {
      programs: [
        {
          programKey: "elite",
          programName: "Elite Mentorship",
          defaultCurrency: null,
          currencies: [{ currency: "EUR", amountMinor: 90_000, paymentCount: 2 }, ...usd(580_000)],
          paymentCount: 3,
        },
        {
          programKey: "acc",
          programName: "Accelerator",
          // Its own currency is lempiras, whatever the page leads with.
          defaultCurrency: "HNL",
          currencies: [...usd(1_260_000, 2), { currency: "HNL", amountMinor: 9_000_000, paymentCount: 1 }],
          paymentCount: 3,
        },
      ],
    },
    wins: { programs: [{ programKey: "acc", won: 3 }, { programKey: "retired", won: 0 }] },
    open: {
      deals: [
        deal("a1", "acc", { kind: "call", at: 500 }),
        missed("a2", "acc", 40),
        missed("n1", "none", 3),
        deal("d1", "disc", null),
        deal("d2", "disc", null),
      ],
      programs: [
        { programKey: "acc", programName: "Accelerator", open: 2, closed: 9 },
        { programKey: "none", programName: null, open: 1, closed: 2 },
        { programKey: "disc", programName: "Discovery", open: 2, closed: 0 },
        // Closed deals only, nothing this month: no row.
        { programKey: "retired", programName: "Retired", open: 0, closed: 4 },
      ],
    },
  };

  it("lists programs by the month's cash in the main currency, then by open deals, no program last", () => {
    const rows = buildBookPrograms(input, "USD", NOW);
    expect(rows.map((row) => row.key)).toEqual(["acc", "elite", "disc", "none"]);
    expect(rows[0]).toMatchObject({ name: "Accelerator", open: 2, notRecorded: 1, won: 3 });
    expect(rows[2]).toMatchObject({ name: "Discovery", open: 2, notRecorded: 0, won: 0, cash: [] });
    expect(rows[3]).toMatchObject({ name: null, open: 1, notRecorded: 1 });
  });

  it("leads each program's cash with its own currency, else its most-paid one", () => {
    const [acc, elite, disc] = buildBookPrograms(input, "USD", NOW);
    expect(acc.currency).toBe("HNL");
    expect(acc.cash.map((entry) => entry.currency)).toEqual(["HNL", "USD"]);
    expect(elite.currency).toBe("EUR");
    expect(disc.currency).toBe("USD");
  });

  it("orders by cash in the main currency only", () => {
    // In lempiras Elite has none, so Accelerator leads either way.
    expect(buildBookPrograms(input, "HNL", NOW).map((row) => row.key).slice(0, 2)).toEqual(["acc", "elite"]);
  });

  it("has no programs for a closer with no deals and no cash", () => {
    expect(
      buildBookPrograms(
        { cash: { programs: [] }, wins: { programs: [] }, open: { deals: [], programs: [] } },
        "USD",
        NOW,
      ),
    ).toEqual([]);
  });
});
