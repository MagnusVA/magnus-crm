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

// ── The book ──────────────────────────────────────────────────────────────

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
  /** The meeting behind `nextStep.callAt`, where a call that passed with no result is recorded. */
  nextMeetingId?: string | null;
  lastActivityAt: number;
};

/**
 * Where an open deal stands as of `now`. Ahead: it has a next step (a call
 * ahead or an open task). Not recorded: no step, and its last booked call
 * passed with no outcome. No next step: neither.
 */
export type DealState = "ahead" | "no_step" | "not_recorded";

/** How long ago a call that was never recorded took place. */
export type RecordAge = "under_30" | "30_90" | "over_90";

export const RECORD_AGE_LABELS: Record<RecordAge, string> = {
  under_30: "Under 30 days",
  "30_90": "30–90 days",
  over_90: "Over 90 days",
};

const DAY = 86_400_000;

export function recordAgeOf(missedCallAt: number, now: number): RecordAge {
  const days = (now - missedCallAt) / DAY;
  if (days < 30) return "under_30";
  if (days <= 90) return "30_90";
  return "over_90";
}

export type DealStanding = {
  state: DealState;
  step: ShownStep;
  /** The call that passed with no result, if any (set beside a step too). */
  missedCallAt: number | null;
};

export function dealStanding(deal: Pick<DeskDeal, "nextStep">, now: number): DealStanding {
  const { step, missedCallAt } = resolveNextStep(deal.nextStep, now);
  const state: DealState =
    step !== null ? "ahead" : missedCallAt !== null ? "not_recorded" : "no_step";
  return { state, step, missedCallAt };
}

export type BookSummary = {
  total: number;
  positions: Record<DeskDeal["position"], number>;
  ahead: number;
  noStep: number;
  notRecorded: number;
  ages: Record<RecordAge, number>;
  /** The oldest call never recorded, if any. */
  oldestMissedAt: number | null;
};

/** The open book in counts, as of `now`. */
export function summarizeBook(deals: DeskDeal[], now: number): BookSummary {
  const summary: BookSummary = {
    total: deals.length,
    positions: { booked: 0, call_held: 0, follow_up: 0 },
    ahead: 0,
    noStep: 0,
    notRecorded: 0,
    ages: { under_30: 0, "30_90": 0, over_90: 0 },
    oldestMissedAt: null,
  };
  for (const deal of deals) {
    summary.positions[deal.position] += 1;
    const { state, missedCallAt } = dealStanding(deal, now);
    if (state === "ahead") summary.ahead += 1;
    else if (state === "no_step") summary.noStep += 1;
    else if (missedCallAt !== null) {
      summary.notRecorded += 1;
      summary.ages[recordAgeOf(missedCallAt, now)] += 1;
      if (summary.oldestMissedAt === null || missedCallAt < summary.oldestMissedAt) {
        summary.oldestMissedAt = missedCallAt;
      }
    }
  }
  return summary;
}

/** What the open-deals list shows: a state (and, for calls never recorded, an age) and a program. */
export type BookFilter = {
  state: DealState | null;
  age: RecordAge | null;
  programKey: string | null;
};

export const NO_BOOK_FILTER: BookFilter = { state: null, age: null, programKey: null };

export function matchesBookFilter(deal: DeskDeal, filter: BookFilter, now: number): boolean {
  if (filter.programKey !== null && deal.programKey !== filter.programKey) return false;
  if (filter.state === null) return true;
  const { state, missedCallAt } = dealStanding(deal, now);
  if (state !== filter.state) return false;
  if (filter.age === null || missedCallAt === null) return true;
  return recordAgeOf(missedCallAt, now) === filter.age;
}

/**
 * The list's rows: the first `limit` deals the filter matches, in the
 * list's order, plus the open row's deal wherever it went (setting a next
 * step from it can move it out of the filter or past the page, and its
 * dialog must outlive that). `matched` counts the filter's deals only.
 */
export function visibleBookDeals(
  deals: DeskDeal[],
  filter: BookFilter,
  openId: string | null,
  now: number,
  limit: number,
): { rows: DeskDeal[]; matched: number } {
  const matching = deals.filter((deal) => matchesBookFilter(deal, filter, now)).sort(compareBookDeals(now));
  const rows = matching.slice(0, limit);
  const open = openId === null ? undefined : deals.find((deal) => deal.opportunityId === openId);
  if (open && !rows.includes(open)) {
    rows.push(open);
    rows.sort(compareBookDeals(now));
  }
  return { rows, matched: matching.length };
}

const STATE_ORDER: Record<DealState, number> = { ahead: 0, no_step: 1, not_recorded: 2 };

/** When a step happens: calls and tasks by time (an overdue one first), then links. */
function stepTime(step: ShownStep): [number, number] {
  if (step === null) return [0, 0];
  if (step.kind === "call") return [0, step.at];
  if (step.kind === "task") return [0, step.dueAt ?? Number.MAX_SAFE_INTEGER];
  return [1, step.sentAt];
}

/**
 * The list's order as of `now`, by what's next: deals with a step by its
 * time (links after calls and tasks), then deals with no next step, the most
 * recent activity first, then calls never recorded, the oldest call first.
 */
export function compareBookDeals(now: number) {
  return (a: DeskDeal, b: DeskDeal): number => {
    const sa = dealStanding(a, now);
    const sb = dealStanding(b, now);
    const byState = STATE_ORDER[sa.state] - STATE_ORDER[sb.state];
    if (byState !== 0) return byState;
    if (sa.state === "ahead") {
      const [groupA, timeA] = stepTime(sa.step);
      const [groupB, timeB] = stepTime(sb.step);
      if (groupA !== groupB || timeA !== timeB) return groupA - groupB || timeA - timeB;
    } else if (sa.state === "not_recorded") {
      const byCall = (sa.missedCallAt ?? 0) - (sb.missedCallAt ?? 0);
      if (byCall !== 0) return byCall;
    } else if (a.lastActivityAt !== b.lastActivityAt) {
      return b.lastActivityAt - a.lastActivityAt;
    }
    return a.personName.localeCompare(b.personName);
  };
}

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

/** One program in the book's table. */
export type BookProgram = {
  key: string;
  /** Null for the deals with no program. */
  name: string | null;
  open: number;
  notRecorded: number;
  won: number;
  /** The month's cash, by currency, its own main currency first. */
  cash: CurrencyAmount[];
  /** The program's own currency from its settings, else its most-paid one, else the page's. */
  currency: string;
  paymentCount: number;
};

/**
 * The programs with open deals, cash or wins in the month: the most cash in
 * the page's main currency first (a tie goes to more payments), then the
 * most open deals, with the deals that have no program last. A program with
 * only closed deals and nothing this month is left out; its deals stay in
 * All deals.
 */
export function buildBookPrograms(input: DeskInput, currency: string, now: number): BookProgram[] {
  const rows = new Map<string, BookProgram>();
  const owned = new Map<string, string | null>();
  const row = (key: string, name: string | null) => {
    let entry = rows.get(key);
    if (!entry) {
      entry = { key, name, open: 0, notRecorded: 0, won: 0, cash: [], currency, paymentCount: 0 };
      rows.set(key, entry);
    }
    if (entry.name === null && name !== null) entry.name = name;
    return entry;
  };

  for (const program of input.cash.programs) {
    if (program.paymentCount === 0) continue;
    const entry = row(program.programKey, program.programName);
    entry.cash = program.currencies;
    entry.paymentCount = program.paymentCount;
    owned.set(program.programKey, program.defaultCurrency);
  }
  for (const deal of input.open.deals) {
    const entry = row(deal.programKey, null);
    entry.open += 1;
    if (dealStanding(deal, now).state === "not_recorded") entry.notRecorded += 1;
  }
  for (const program of input.wins.programs) {
    if (program.won > 0) row(program.programKey, null).won = program.won;
  }
  for (const program of input.open.programs) {
    const entry = rows.get(program.programKey);
    if (entry && entry.name === null) entry.name = program.programName;
  }
  for (const entry of rows.values()) {
    entry.currency = owned.get(entry.key) ?? mainCurrency(entry.cash, currency);
    entry.cash = leadingWith(entry.cash, entry.currency);
  }

  return [...rows.values()].sort(
    (a, b) =>
      Number(a.key === NO_PROGRAM) - Number(b.key === NO_PROGRAM) ||
      amountIn(b.cash, currency) - amountIn(a.cash, currency) ||
      b.paymentCount - a.paymentCount ||
      b.open - a.open ||
      (a.name ?? "").localeCompare(b.name ?? ""),
  );
}

/** The program's name, or the words for the deals with none. */
export function programLabel(name: string | null) {
  return name ?? "No program";
}
