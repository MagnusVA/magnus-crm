import {
  businessPeriodRange,
  countBusinessDays,
  type BusinessDaySetting,
} from "@/lib/businessDay";

// My Pipeline's month and program sections, worked out from the desk's
// queries (convex/closer/pipelineDesk.ts) by the rules the user settled
// (.impeccable/surfaces/app-workspace-closer-pipeline-page-tsx.md, "Data rules").

// ── Months ────────────────────────────────────────────────────────────────

/** "2026-10", the business month a key names. */
export type MonthKey = string;

export function isMonthKey(value: string | null | undefined): value is MonthKey {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

/** The month `delta` months from `key`. */
export function shiftMonth(key: MonthKey, delta: number): MonthKey {
  const [year, month] = key.split("-").map(Number);
  const index = year * 12 + (month - 1) + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

const MONTH_NAME = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" });

function monthName(key: MonthKey) {
  return MONTH_NAME.format(Date.parse(`${key}-01T12:00:00Z`));
}

export type PipelineMonth = {
  key: MonthKey;
  isCurrent: boolean;
  startDate: number;
  endDate: number;
  /**
   * The month before, cut to the same elapsed length while the month runs
   * ("this time last month"), or whole once the month is over.
   */
  previous: { startDate: number; endDate: number };
  /** "October", or "October 2025" outside the current year. */
  name: string;
  /** The business day the month is on, and how many it has. */
  day: number;
  days: number;
  /** "vs this time last month", or "vs September" for a past month. */
  comparisonLabel: string;
};

/**
 * The business month `key` names, as of today's business date. A key after
 * today's month reads as today's. `cutoff` is how far into the running month
 * to compare (the next hour, so the arguments hold still between ticks).
 */
export function pipelineMonth(
  key: MonthKey,
  today: string,
  cutoff: number,
  setting: BusinessDaySetting,
): PipelineMonth {
  const currentKey = today.slice(0, 7);
  const monthKey = key > currentKey ? currentKey : key;
  const isCurrent = monthKey === currentKey;
  const range = businessPeriodRange(`${monthKey}-01`, "month", setting);
  const previousKey = shiftMonth(monthKey, -1);
  const previousRange = businessPeriodRange(`${previousKey}-01`, "month", setting);
  const nextKey = shiftMonth(monthKey, 1);
  const days = countBusinessDays(`${monthKey}-01`, `${nextKey}-01`);
  const elapsed = Math.max(1, Math.min(cutoff, range.end) - range.start);

  return {
    key: monthKey,
    isCurrent,
    startDate: range.start,
    endDate: range.end,
    previous: isCurrent
      ? {
          startDate: previousRange.start,
          endDate: Math.min(previousRange.start + elapsed, previousRange.end),
        }
      : { startDate: previousRange.start, endDate: previousRange.end },
    name:
      monthKey.slice(0, 4) === currentKey.slice(0, 4)
        ? monthName(monthKey)
        : `${monthName(monthKey)} ${monthKey.slice(0, 4)}`,
    day: isCurrent ? Number(today.slice(8, 10)) : days,
    days,
    comparisonLabel: isCurrent ? "vs this time last month" : `vs ${monthName(previousKey)}`,
  };
}

// ── Money ─────────────────────────────────────────────────────────────────

export type CurrencyAmount = { currency: string; amountMinor: number; paymentCount?: number };

/**
 * The currency a figure leads with. Amounts in different currencies are
 * never compared, so it is the currency with the most payments, a tie going
 * to `preferred` (last month's main currency), then US dollars, then the
 * code; with no payments, `preferred`, else US dollars. The tenant has no
 * currency setting of its own (convex/schema.ts, `tenants`).
 */
export function mainCurrency(current: CurrencyAmount[], preferred?: string | null): string {
  const rank = (code: string) => (code === preferred ? 0 : code === "USD" ? 1 : 2);
  const [first] = [...current].sort(
    (a, b) =>
      (b.paymentCount ?? 0) - (a.paymentCount ?? 0) ||
      rank(a.currency) - rank(b.currency) ||
      a.currency.localeCompare(b.currency),
  );
  return first?.currency ?? preferred ?? "USD";
}

/** `amounts` with `currency` first and the rest by payment count, as the desk sorts them. */
export function leadingWith(amounts: CurrencyAmount[], currency: string): CurrencyAmount[] {
  return [...amounts].sort(
    (a, b) => Number(b.currency === currency) - Number(a.currency === currency),
  );
}

export function amountIn(amounts: CurrencyAmount[], currency: string): number {
  return amounts.find((entry) => entry.currency === currency)?.amountMinor ?? 0;
}

/**
 * "$18,400", or "$18,400.50" when there are cents; amounts are in hundredths.
 * A negative amount takes a true minus sign: "−$2,000".
 */
export function formatCash(amountMinor: number, currency: string, signed = false): string {
  const whole = amountMinor % 100 === 0;
  const options: Intl.NumberFormatOptions = {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
    signDisplay: signed ? "exceptZero" : "auto",
  };
  let formatted: string;
  try {
    formatted = new Intl.NumberFormat("en-US", options).format(amountMinor / 100);
  } catch {
    const figure = new Intl.NumberFormat("en-US", {
      maximumFractionDigits: 2,
      signDisplay: options.signDisplay,
    }).format(amountMinor / 100);
    formatted = `${figure} ${currency.toUpperCase()}`;
  }
  return formatted.replace(/^-/, "\u2212");
}

// ── Program sections ──────────────────────────────────────────────────────

export const NO_PROGRAM = "none";

/** A deal's open task: the soonest call-back or text-back, else a waiting link. */
export type DeskTaskStep =
  | null
  | { kind: "task"; method: "call" | "text"; dueAt: number | null }
  | { kind: "link"; reschedule: boolean; sentAt: number };

/** What the server sends: the next call's time and the open task, side by side. */
export type DeskNextStep = { callAt: number | null; task: DeskTaskStep };

/** The step a row shows. */
export type ShownStep = { kind: "call"; at: number } | Exclude<DeskTaskStep, null> | null;

/**
 * The deal's next step as of `now`: its next call while that call is still
 * ahead, else its open task, else none ("No next step"). A call that has
 * passed with no result is never the step; it comes back as `missedCallAt`
 * so a row can mention it.
 */
export function resolveNextStep(
  next: DeskNextStep,
  now: number,
): { step: ShownStep; missedCallAt: number | null } {
  if (next.callAt !== null && next.callAt > now) {
    return { step: { kind: "call", at: next.callAt }, missedCallAt: null };
  }
  return { step: next.task, missedCallAt: next.callAt };
}

export type DeskDeal = {
  opportunityId: string;
  leadId: string;
  personName: string;
  position: "booked" | "call_held" | "follow_up";
  programKey: string;
  nextStep: DeskNextStep;
};

export type DeskInput = {
  cash: {
    programs: Array<{
      programKey: string;
      programName: string | null;
      defaultCurrency: string | null;
      currencies: CurrencyAmount[];
      paymentCount: number;
    }>;
  };
  wins: { programs: Array<{ programKey: string; won: number }> };
  open: {
    deals: DeskDeal[];
    programs: Array<{ programKey: string; programName: string | null; open: number; closed: number }>;
  };
};

export type ProgramSection = {
  key: string;
  /** Null for the deals with no program. */
  name: string | null;
  /** The month's cash, by currency, its main currency first. */
  cash: CurrencyAmount[];
  /**
   * The currency its header leads with: the program's own currency from its
   * settings, else the one with the most payments in it, else the page's.
   */
  currency: string;
  paymentCount: number;
  won: number;
  /** The open deals, the ones with no next step first. */
  deals: DeskDeal[];
  closed: number;
};

/** When a step happens, for the row order: calls and tasks by time, then links. */
function stepOrder(step: ShownStep): [number, number] {
  if (step === null) return [0, 0];
  if (step.kind === "call") return [1, step.at];
  if (step.kind === "task") return [1, step.dueAt ?? Number.MAX_SAFE_INTEGER];
  return [2, step.sentAt];
}

/** As of `now`: an open deal with no next step first, then the soonest step, then by name. */
export function compareDeskDeals(now: number) {
  return (a: DeskDeal, b: DeskDeal): number => {
    const [groupA, timeA] = stepOrder(resolveNextStep(a.nextStep, now).step);
    const [groupB, timeB] = stepOrder(resolveNextStep(b.nextStep, now).step);
    return groupA - groupB || timeA - timeB || a.personName.localeCompare(b.personName);
  };
}

/** How many of `deals` have no next step as of `now`. */
export function countWithoutNextStep(deals: DeskDeal[], now: number): number {
  return deals.filter((deal) => resolveNextStep(deal.nextStep, now).step === null).length;
}

/**
 * One section per program, in the order the user settled: the programs
 * with cash this month, the most cash in the page's main currency first (a
 * tie goes to more payments, then more open deals); then the programs with
 * open deals and no cash, the most open deals first, with the deals that
 * have no program last. A program with neither is left out; its deals stay
 * in the lookup. Rows are ordered as of `now`.
 */
export function buildProgramSections(
  input: DeskInput,
  currency: string,
  now: number,
): ProgramSection[] {
  const sections = new Map<string, ProgramSection>();
  const owned = new Map<string, string | null>();
  const section = (key: string, name: string | null) => {
    let entry = sections.get(key);
    if (!entry) {
      entry = { key, name, cash: [], currency, paymentCount: 0, won: 0, deals: [], closed: 0 };
      sections.set(key, entry);
    }
    if (entry.name === null && name !== null) entry.name = name;
    return entry;
  };

  for (const program of input.cash.programs) {
    if (program.paymentCount === 0) continue;
    const entry = section(program.programKey, program.programName);
    entry.cash = program.currencies;
    entry.paymentCount = program.paymentCount;
    owned.set(program.programKey, program.defaultCurrency);
  }
  for (const deal of input.open.deals) {
    section(deal.programKey, null).deals.push(deal);
  }
  for (const program of input.open.programs) {
    const entry = sections.get(program.programKey);
    if (!entry) continue;
    if (entry.name === null) entry.name = program.programName;
    entry.closed = program.closed;
  }
  for (const program of input.wins.programs) {
    const entry = sections.get(program.programKey);
    if (entry) entry.won = program.won;
  }
  for (const entry of sections.values()) {
    entry.currency = owned.get(entry.key) ?? mainCurrency(entry.cash, currency);
    entry.cash = leadingWith(entry.cash, entry.currency);
    entry.deals.sort(compareDeskDeals(now));
  }

  const withCash = [...sections.values()].filter((entry) => entry.paymentCount > 0);
  const openOnly = [...sections.values()].filter((entry) => entry.paymentCount === 0);
  const byName = (a: ProgramSection, b: ProgramSection) =>
    (a.name ?? "").localeCompare(b.name ?? "");
  withCash.sort(
    (a, b) =>
      amountIn(b.cash, currency) - amountIn(a.cash, currency) ||
      b.paymentCount - a.paymentCount ||
      b.deals.length - a.deals.length ||
      byName(a, b),
  );
  openOnly.sort(
    (a, b) =>
      Number(a.key === NO_PROGRAM) - Number(b.key === NO_PROGRAM) ||
      b.deals.length - a.deals.length ||
      byName(a, b),
  );
  return [...withCash, ...openOnly];
}
