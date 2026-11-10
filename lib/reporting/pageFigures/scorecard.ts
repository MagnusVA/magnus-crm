import type {
  AnswersOutput,
  CashAmounts,
  CashOutput,
  FollowThroughOutput,
  FunnelOutput,
  OriginsOutput,
} from "../../../convex/reports/scorecard";
import { LIFECYCLE_STAGE_LABELS } from "../../../convex/leads/lifecycle";
import { businessPeriodDate } from "../../businessDay";
import type { ReportDocument, ReportRecord } from "../../operations-reports/document";
import { REPORT_TERMS } from "../definitions";
import { definitionsTable } from "../export";
import { formatCount, formatMoney } from "./money";

// The Scorecard's page-side shaping (docs/reviews/reports-overhaul.html §08):
// the funnel's steps, business weeks from the readers' days, one currency's
// cash, and the export document built from exactly what the page shows.

export type CashCurrency = CashOutput["currencies"][number];

export const FUNNEL_STAGES = ["prospect", "in_conversation", "qualified", "booked", "showed", "customer"] as const;

/** The cohort's steps: people who entered In conversation in the range, followed to today. */
export const COHORT_STEPS = [
  { key: "entered", label: "Entered In conversation" },
  { key: "qualified", label: LIFECYCLE_STAGE_LABELS.qualified },
  { key: "booked", label: LIFECYCLE_STAGE_LABELS.booked },
  { key: "showed", label: LIFECYCLE_STAGE_LABELS.showed },
  { key: "customer", label: LIFECYCLE_STAGE_LABELS.customer },
] as const;

export const PAYMENT_TYPES = [
  { key: "pif", label: "Paid in full" },
  { key: "split", label: "Split" },
  { key: "monthly", label: "Monthly" },
  { key: "deposit", label: "Deposit" },
] as const;

/** A deal's first-touch channel in words. */
export const CHANNEL_LABELS: Record<string, string> = {
  lead_gen: "Lead gen",
  dm_portal: "DM portal",
  slack: "Slack",
  calendly: "Calendly",
  side_deal: "Side deal",
  unknown: "No first touch",
};

export function channelLabel(channel: string) {
  return CHANNEL_LABELS[channel] ?? channel;
}

/** Adds one list of per-currency amounts into another, keeping currencies apart. */
export function addCash(into: readonly CashAmounts[], rows: readonly CashAmounts[]): CashAmounts[] {
  const byCurrency = new Map(into.map((row) => [row.currency, { ...row }]));
  for (const row of rows) {
    const total = byCurrency.get(row.currency) ?? { currency: row.currency, cashMinor: 0, finalMinor: 0 };
    total.cashMinor += row.cashMinor;
    total.finalMinor += row.finalMinor;
    byCurrency.set(row.currency, total);
  }
  return [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

export type WeekRow = {
  /** The Monday that starts the business week, or the range's first day in it. */
  weekStart: string;
  /** The last day of the week inside the range. */
  weekEnd: string;
  days: number;
  /** The week is cut by the range's start or end. */
  partial: boolean;
  bookingsMade: number;
  callsHeld: number;
  dealsWon: number;
  cash: CashAmounts[];
};

/**
 * The readers' days grouped into business weeks, Monday to Sunday. The days
 * arrive in order, one per business date in the range, so a week with fewer
 * than seven was cut by the range's edge.
 */
export function groupByWeek(byDay: FunnelOutput["byDay"]): WeekRow[] {
  const weeks = new Map<string, WeekRow>();
  for (const day of [...byDay].sort((a, b) => a.dayKey.localeCompare(b.dayKey))) {
    const monday = businessPeriodDate(day.dayKey, "week");
    const week = weeks.get(monday) ?? {
      weekStart: day.dayKey,
      weekEnd: day.dayKey,
      days: 0,
      partial: false,
      bookingsMade: 0,
      callsHeld: 0,
      dealsWon: 0,
      cash: [],
    };
    week.weekEnd = day.dayKey;
    week.days += 1;
    week.bookingsMade += day.bookingsMade;
    week.callsHeld += day.callsHeld;
    week.dealsWon += day.dealsWon;
    week.cash = addCash(week.cash, day.cash);
    weeks.set(monday, week);
  }
  return [...weeks.values()].map((week) => ({ ...week, partial: week.days < 7 }));
}

/** "Oct 27 – Nov 2" for a week's days. */
export function weekLabel(week: Pick<WeekRow, "weekStart" | "weekEnd">) {
  const format = (key: string) =>
    new Date(`${key}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return week.weekStart === week.weekEnd ? format(week.weekStart) : `${format(week.weekStart)} – ${format(week.weekEnd)}`;
}

/** Final cash on won deals over deals won, in one currency; null with no deal won. */
export function cashPerWonDeal(entry: Pick<CashCurrency, "finalOnWonDealsMinor" | "dealsWon">): number | null {
  return entry.dealsWon > 0 ? Math.round(entry.finalOnWonDealsMinor / entry.dealsWon) : null;
}

/** How much weight each currency carries for picking the main one: its payments. */
export function scorecardCurrencyWeights(
  cash: CashOutput | undefined,
  funnel: FunnelOutput | undefined,
  origins: OriginsOutput | undefined,
) {
  const weights = new Map<string, number>();
  for (const row of funnel?.activity.cash ?? []) weights.set(row.currency, 0);
  for (const origin of origins?.origins ?? []) for (const row of origin.cash) weights.set(row.currency, 0);
  for (const entry of cash?.currencies ?? []) {
    weights.set(entry.currency, entry.byProgram.reduce((sum, program) => sum + program.payments, 0));
  }
  return [...weights.entries()].map(([currency, weight]) => ({ currency, weight }));
}

const percentOrNull = (numerator: number, denominator: number) => (denominator > 0 ? numerator / denominator : null);

/**
 * Said on the funnel card and in the export when a program is picked: a
 * person has no program until they book, so the funnel's people counts
 * (stages and cohort) can't be filtered by one.
 */
export const FUNNEL_PROGRAM_NOTE =
  "People are counted across every program; the Program filter applies to bookings, calls, deals and cash.";

export type ScorecardDocumentInput = {
  words: string;
  dayLine: string;
  /** The picked program's name, or null for all programs. */
  programName: string | null;
  generatedAt: number;
  funnel: FunnelOutput;
  cash: CashOutput;
  followThrough: FollowThroughOutput;
  origins: OriginsOutput;
  /** Null when no booking-form field is picked or the answers haven't loaded. */
  answers: AnswersOutput | null;
};

const money = (key: string, label: string) => ({ key, label, format: "money" as const, currencyKey: "currency" });

/**
 * The page as a document for the export menu: the band's figures, then one
 * table per card, every currency in its own rows, then the definitions.
 */
export function buildScorecardDocument(input: ScorecardDocumentInput): ReportDocument {
  const { funnel, cash, followThrough, origins, answers } = input;
  const summary: ReportDocument["summary"] = [
    { label: "People in conversation", value: formatCount(funnel.stages.in_conversation) },
    { label: LIFECYCLE_STAGE_LABELS.qualified, value: formatCount(funnel.stages.qualified) },
    { label: REPORT_TERMS.bookingsMade.label, value: formatCount(funnel.activity.bookingsMade) },
    { label: "Calls held", value: formatCount(funnel.activity.callsHeld) },
    { label: REPORT_TERMS.dealsWon.label, value: formatCount(funnel.activity.dealsWon) },
  ];
  for (const row of funnel.activity.cash) {
    summary.push({ label: `${REPORT_TERMS.cash.label} (${row.currency})`, value: formatMoney(row.cashMinor, row.currency) });
    summary.push({ label: `${REPORT_TERMS.finalCash.label} (${row.currency})`, value: formatMoney(row.finalMinor, row.currency) });
  }

  const weeks = groupByWeek(funnel.byDay);
  const tables: ReportDocument["tables"] = [
    {
      title: "The funnel · in this range",
      columns: [
        { key: "stage", label: "Stage" },
        { key: "people", label: "People entering", format: "number" },
      ],
      rows: FUNNEL_STAGES.map((stage) => ({ stage: LIFECYCLE_STAGE_LABELS[stage], people: funnel.stages[stage] })),
    },
    {
      title: "The funnel · cohort",
      columns: [
        { key: "step", label: "Step" },
        { key: "people", label: "People by now", format: "number" },
        { key: "share", label: "Of those who entered", format: "percent" },
      ],
      rows: COHORT_STEPS.map((step) => ({
        step: step.label,
        people: funnel.cohort[step.key],
        share: percentOrNull(funnel.cohort[step.key], funnel.cohort.entered),
      })),
    },
    {
      title: "Cash",
      columns: [
        { key: "currency", label: "Currency" },
        money("cash", REPORT_TERMS.cash.label),
        money("final", REPORT_TERMS.finalCash.label),
        money("deposits", "Deposits"),
        money("depositsOnLost", "Deposits on lost deals"),
        { key: "dealsWon", label: REPORT_TERMS.dealsWon.label, format: "number" },
        money("perWonDeal", REPORT_TERMS.cashPerWonDeal.label),
      ],
      rows: cash.currencies.map((entry) => ({
        currency: entry.currency,
        cash: entry.cashMinor,
        final: entry.finalMinor,
        deposits: entry.depositMinor,
        depositsOnLost: entry.depositsOnLostDeals,
        dealsWon: entry.dealsWon,
        perWonDeal: cashPerWonDeal(entry),
      })),
    },
    {
      title: "Cash by payment type",
      columns: [{ key: "currency", label: "Currency" }, { key: "type", label: "Payment type" }, money("amount", REPORT_TERMS.cash.label)],
      rows: cash.currencies.flatMap((entry) =>
        PAYMENT_TYPES.map((type) => ({ currency: entry.currency, type: type.label, amount: entry.byType[type.key] })),
      ),
    },
    {
      title: "Programs",
      columns: [
        { key: "currency", label: "Currency" },
        { key: "program", label: "Program" },
        { key: "payments", label: "Payments", format: "number" },
        { key: "dealsWon", label: REPORT_TERMS.dealsWon.label, format: "number" },
        money("cash", REPORT_TERMS.cash.label),
        money("final", REPORT_TERMS.finalCash.label),
        money("perWonDeal", REPORT_TERMS.cashPerWonDeal.label),
      ],
      rows: cash.currencies.flatMap((entry) =>
        entry.byProgram.map((program) => ({
          currency: entry.currency,
          program: program.name,
          payments: program.payments,
          dealsWon: program.dealsWon,
          cash: program.cashMinor,
          final: program.finalMinor,
          perWonDeal: cashPerWonDeal(program),
        })),
      ),
    },
    {
      title: "Week by week",
      columns: [
        { key: "week", label: "Week" },
        { key: "partial", label: "Cut by the range" },
        { key: "bookings", label: REPORT_TERMS.bookingsMade.label, format: "number" },
        { key: "held", label: "Calls held", format: "number" },
        { key: "won", label: REPORT_TERMS.dealsWon.label, format: "number" },
      ],
      rows: weeks.map((week) => ({
        week: weekLabel(week),
        partial: week.partial ? "Yes" : "No",
        bookings: week.bookingsMade,
        held: week.callsHeld,
        won: week.dealsWon,
      })),
    },
    {
      title: "Cash by week",
      columns: [
        { key: "week", label: "Week" },
        { key: "currency", label: "Currency" },
        money("cash", REPORT_TERMS.cash.label),
        money("final", REPORT_TERMS.finalCash.label),
      ],
      rows: weeks.flatMap((week) =>
        week.cash.map((row) => ({ week: weekLabel(week), currency: row.currency, cash: row.cashMinor, final: row.finalMinor })),
      ),
    },
    {
      title: "Follow-through",
      columns: [
        { key: "closer", label: "Closer" },
        { key: "due", label: "Reminders due", format: "number" },
        { key: "onTime", label: "On time", format: "number" },
        { key: "late", label: "Late", format: "number" },
        { key: "overdue", label: "Overdue now", format: "number" },
        { key: "share", label: REPORT_TERMS.tasksOnTime.label, format: "percent" },
      ],
      rows: [
        { name: "All closers", ...followThrough },
        ...[...followThrough.byCloser].sort((a, b) => a.name.localeCompare(b.name)),
      ].map((row) => ({
        closer: row.name,
        due: row.due,
        onTime: row.onTime,
        late: row.late,
        overdue: row.openOverdue,
        share: percentOrNull(row.onTime, row.due),
      })),
    },
    {
      title: "Where the business came from",
      columns: [
        { key: "channel", label: "First touch" },
        { key: "dealsWon", label: REPORT_TERMS.dealsWon.label, format: "number" },
        { key: "currency", label: "Currency" },
        money("cash", REPORT_TERMS.cash.label),
      ],
      rows: origins.origins.flatMap((origin): ReportRecord[] =>
        origin.cash.length === 0
          ? [{ channel: channelLabel(origin.channel), dealsWon: origin.dealsWon, currency: null, cash: null }]
          : origin.cash.map((row) => ({
              channel: channelLabel(origin.channel),
              dealsWon: origin.dealsWon,
              currency: row.currency,
              cash: row.cashMinor,
            })),
      ),
    },
  ];
  if (answers) {
    tables.push({
      title: `What predicts a sale · ${answers.label}`,
      columns: [
        { key: "answer", label: "Answer" },
        { key: "people", label: "People", format: "number" },
        { key: "held", label: "People with a held call", format: "number" },
        { key: "heldShare", label: "Held share", format: "percent" },
        { key: "won", label: "People who bought", format: "number" },
        { key: "wonShare", label: "Won share", format: "percent" },
      ],
      rows: answers.answers.map((row) => ({
        answer: row.answer,
        people: row.people,
        held: row.held,
        heldShare: percentOrNull(row.held, row.people),
        won: row.won,
        wonShare: percentOrNull(row.won, row.people),
      })),
    });
  }
  tables.push(definitionsTable(["bookingsMade", "dealsWon", "cash", "finalCash", "cashPerWonDeal", "tasksOnTime"]));

  return {
    title: "Scorecard",
    period: input.words,
    generatedAt: input.generatedAt,
    boundary: input.dayLine,
    filters: input.programName ? `Program: ${input.programName} · ${FUNNEL_PROGRAM_NOTE}` : "All programs",
    summary,
    tables,
  };
}

/** The page's rankings, applied to the full answer before pagination. */
export function orderPrograms(rows: CashCurrency["byProgram"]) {
  return [...rows].sort((a, b) => b.cashMinor - a.cashMinor || a.name.localeCompare(b.name));
}
export function orderOrigins(rows: OriginsOutput["origins"], currency: string) {
  const amount = (row: OriginsOutput["origins"][number]) => row.cash.find(c => c.currency === currency)?.cashMinor ?? 0;
  const byCash = rows.some(row => amount(row) !== 0);
  return [...rows].sort((a, b) => (byCash ? amount(b) - amount(a) : 0) || b.dealsWon - a.dealsWon);
}
export function orderFollowThrough(rows: FollowThroughOutput["byCloser"]) {
  return [...rows].sort((a, b) => b.due - a.due || a.name.localeCompare(b.name));
}
export function answerShares(row: AnswersOutput["answers"][number]) {
  return { heldShare: percentOrNull(row.held, row.people), wonShare: percentOrNull(row.won, row.people) };
}
export function funnelFigures(data: FunnelOutput) {
  const weeks = groupByWeek(data.byDay);
  return {
    bookingsMade: data.activity.bookingsMade, dealsWon: data.activity.dealsWon,
    callsHeld: data.activity.callsHeld,
    cohortShares: Object.fromEntries(COHORT_STEPS.map(({ key }) => [key, percentOrNull(data.cohort[key], data.cohort.entered)])),
    weeks,
    weekTotals: { bookingsMade: weeks.reduce((s, w) => s + w.bookingsMade, 0), callsHeld: weeks.reduce((s, w) => s + w.callsHeld, 0), dealsWon: weeks.reduce((s, w) => s + w.dealsWon, 0), cash: weeks.reduce((s, w) => addCash(s, w.cash), [] as CashAmounts[]) },
  };
}
export function cashFigures(data: CashOutput, currency: string) {
  const entry = data.currencies.find(row => row.currency === currency);
  return { currency, cash: entry?.cashMinor ?? 0, finalCash: entry?.finalMinor ?? 0,
    dealsWon: entry?.dealsWon ?? 0, cashPerWonDeal: entry ? cashPerWonDeal(entry) : null };
}
export function followThroughFigures(data: FollowThroughOutput) {
  return { tasksOnTime: percentOrNull(data.onTime, data.due), byCloser: orderFollowThrough(data.byCloser).map(row => ({ userId: row.userId, tasksOnTime: percentOrNull(row.onTime, row.due) })) };
}
