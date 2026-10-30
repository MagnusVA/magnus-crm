import { describe, expect, it } from "vitest";
import { businessDayStart, DEFAULT_BUSINESS_DAY } from "@/lib/businessDay";
import {
  buildProgramSections,
  countWithoutNextStep,
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

const NOW = 1_000;
type Step = { kind: "call"; at: number } | DeskDeal["nextStep"]["task"];
/** A deal whose step is `step`: a call ahead, a task, a link, or none. */
const deal = (id: string, programKey: string, step: Step, personName = id): DeskDeal => ({
  opportunityId: id,
  leadId: `lead-${id}`,
  personName,
  position: "follow_up",
  programKey,
  nextStep:
    step?.kind === "call" ? { callAt: NOW + step.at, task: null } : { callAt: null, task: step },
});

const usd = (amountMinor: number, paymentCount = 1) => [{ currency: "USD", amountMinor, paymentCount }];

describe("buildProgramSections", () => {
  const input: DeskInput = {
    cash: {
      programs: [
        {
          programKey: "elite",
          programName: "Elite Mentorship",
          defaultCurrency: null,
          currencies: [
            { currency: "EUR", amountMinor: 90_000, paymentCount: 2 },
            ...usd(580_000),
          ],
          paymentCount: 3,
        },
        {
          programKey: "accelerator",
          programName: "Accelerator",
          // Its own currency is lempiras, whatever the page leads with.
          defaultCurrency: "HNL",
          currencies: [
            ...usd(1_260_000, 2),
            { currency: "HNL", amountMinor: 9_000_000, paymentCount: 1 },
          ],
          paymentCount: 3,
        },
      ],
    },
    wins: { programs: [{ programKey: "accelerator", won: 3 }, { programKey: "retired", won: 1 }] },
    open: {
      deals: [
        deal("a1", "accelerator", { kind: "call", at: 500 }),
        // A call that passed with no result, and no task: no next step.
        {
          ...deal("a5", "accelerator", null),
          nextStep: { callAt: NOW - 100, task: null },
        },
        // A call that passed, with a waiting link: the link is the step.
        {
          ...deal("a6", "accelerator", null),
          nextStep: { callAt: NOW - 100, task: { kind: "link", reschedule: false, sentAt: 50 } },
        },
        deal("a2", "accelerator", null),
        deal("a3", "accelerator", { kind: "link", reschedule: true, sentAt: 100 }),
        deal("a4", "accelerator", { kind: "task", method: "call", dueAt: 200 }),
        deal("n1", "none", null),
        deal("n2", "none", null),
        deal("n3", "none", null),
        deal("d1", "discovery", { kind: "call", at: 1 }),
      ],
      programs: [
        { programKey: "accelerator", programName: "Accelerator", open: 4, closed: 9 },
        { programKey: "none", programName: null, open: 3, closed: 2 },
        { programKey: "discovery", programName: "Discovery", open: 1, closed: 0 },
        // Closed deals only, no cash: no section.
        { programKey: "retired", programName: "Retired", open: 0, closed: 4 },
      ],
    },
  };

  it("orders programs by the month's cash in the main currency, then open-only programs, no program last", () => {
    const sections = buildProgramSections(input, "USD", NOW);
    expect(sections.map((section) => section.key)).toEqual(["accelerator", "elite", "discovery", "none"]);
    expect(sections[0]).toMatchObject({ name: "Accelerator", won: 3, closed: 9, paymentCount: 3 });
    expect(sections[1]).toMatchObject({ name: "Elite Mentorship", won: 0, closed: 0, deals: [] });
    expect(sections[3]).toMatchObject({ name: null, closed: 2 });
  });

  it("leads each header with the program's own currency, else its most-paid one", () => {
    const [accelerator, elite, discovery] = buildProgramSections(input, "USD", NOW);
    expect(accelerator.currency).toBe("HNL");
    expect(accelerator.cash.map((entry) => entry.currency)).toEqual(["HNL", "USD"]);
    expect(elite.currency).toBe("EUR");
    expect(elite.cash.map((entry) => entry.currency)).toEqual(["EUR", "USD"]);
    // No cash: the page's currency.
    expect(discovery.currency).toBe("USD");
  });

  it("orders programs by cash in the main currency only", () => {
    // In lempiras Elite has none, so Accelerator leads either way.
    const sections = buildProgramSections(input, "HNL", NOW);
    expect(sections.map((section) => section.key).slice(0, 2)).toEqual(["accelerator", "elite"]);
  });

  it("lists a program's open deals with no next step first, then the soonest step, links last", () => {
    const [accelerator] = buildProgramSections(input, "USD", NOW);
    // a5's call passed with no result and it has no task, so it has no step;
    // a6's passed call gives way to its link.
    expect(accelerator.deals.map((entry) => entry.opportunityId)).toEqual([
      "a2",
      "a5",
      "a4",
      "a1",
      "a6",
      "a3",
    ]);
    expect(countWithoutNextStep(accelerator.deals, NOW)).toBe(2);
  });

  it("leaves a single program as the only section", () => {
    const sections = buildProgramSections(
      {
        cash: { programs: [] },
        wins: { programs: [] },
        open: {
          deals: [deal("t1", "test", null)],
          programs: [{ programKey: "test", programName: "TestProgram", open: 1, closed: 30 }],
        },
      },
      "USD",
      NOW,
    );
    expect(sections).toEqual([
      {
        key: "test",
        name: "TestProgram",
        cash: [],
        currency: "USD",
        paymentCount: 0,
        won: 0,
        deals: [deal("t1", "test", null)],
        closed: 30,
      },
    ]);
  });

  it("has no sections for a closer with no deals and no cash", () => {
    expect(
      buildProgramSections(
        { cash: { programs: [] }, wins: { programs: [] }, open: { deals: [], programs: [] } },
        "USD",
        NOW,
      ),
    ).toEqual([]);
  });
});
