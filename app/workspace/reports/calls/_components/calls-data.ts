import type { CallsSummary } from "@/convex/reports/calls";
import type { ReportDocument, ReportTable } from "@/lib/operations-reports/document";
import { definitionsTable } from "@/lib/reporting/export";
import type { ReportTermKey } from "@/lib/reporting/definitions";
import {
  formatCount,
  formatMinutes,
  formatRate,
  formatWhen,
  median,
  ofWords,
  plural,
  rate,
} from "../../people/_components/report-format";

// What the Calls page shows, shaped from `CallsSummary` without React, so the
// cards and the export read the same numbers.

type Attendance = { held: number; noShow: number; notRecorded: number };

/** Show rate and Recorded for one set of calls. Recorded is never shown without its show rate, nor the reverse. */
export function attendanceRates(row: Attendance & { due?: number }) {
  const recorded = row.held + row.noShow;
  const due = row.due ?? recorded + row.notRecorded;
  return {
    recorded,
    due,
    showRate: rate(row.held, recorded),
    recordedRate: rate(recorded, due),
  };
}

export type ShowRateWay = {
  key: "overall" | "floor" | "first" | "followUp";
  label: string;
  question: string;
  rate: number | null;
  /** "141 of 193", or why there's no base. */
  of: string;
  /** Recorded beside it: the share of these calls that got a result. */
  recordedRate: number | null;
  recordedOf: string;
  term: ReportTermKey;
};

/** The four show rates, each with the Recorded figure for the same calls. */
export function showRateWays(summary: CallsSummary): ShowRateWay[] {
  const { counts, byType } = summary;
  const overall = attendanceRates({ ...counts });
  const first = attendanceRates(byType.new);
  const follow = attendanceRates(byType.follow_up);
  return [
    {
      key: "overall",
      label: "Show rate",
      question: "held ÷ (held + no-show)",
      rate: overall.showRate,
      of: ofWords(counts.held, overall.recorded, "No call has a result yet"),
      recordedRate: overall.recordedRate,
      recordedOf: ofWords(overall.recorded, counts.due, "No calls due yet"),
      term: "showRate",
    },
    {
      key: "floor",
      label: "Floor",
      question: "every unrecorded call counted as a no-show",
      rate: rate(counts.held, counts.due),
      of: ofWords(counts.held, counts.due, "No calls due yet"),
      recordedRate: overall.recordedRate,
      recordedOf: ofWords(overall.recorded, counts.due, "No calls due yet"),
      term: "showRateFloor",
    },
    {
      key: "first",
      label: "First calls",
      question: "until one is held, moves and rebooks included",
      rate: first.showRate,
      of: ofWords(byType.new.held, first.recorded, "No first call has a result yet"),
      recordedRate: first.recordedRate,
      recordedOf: ofWords(first.recorded, byType.new.due, "No first calls due yet"),
      term: "firstCallShowRate",
    },
    {
      key: "followUp",
      label: "Follow-up calls",
      question: "after a held call on the deal",
      rate: follow.showRate,
      of: ofWords(byType.follow_up.held, follow.recorded, "No follow-up call has a result yet"),
      recordedRate: follow.recordedRate,
      recordedOf: ofWords(follow.recorded, byType.follow_up.due, "No follow-up calls due yet"),
      term: "followUpCall",
    },
  ];
}

export type LedgerStep = { key: string; label: string; value: number };

/** Where every slot went: slots split into moved, canceled, upcoming and due; due into held, no-show, not recorded. */
export function callsLedger(counts: CallsSummary["counts"]) {
  const slots = counts.scheduled + counts.moved;
  return {
    slots,
    slotSteps: [
      { key: "moved", label: "Moved", value: counts.moved },
      { key: "canceled", label: "Canceled", value: counts.canceled },
      { key: "upcoming", label: "Upcoming", value: counts.upcoming },
      { key: "due", label: "Due", value: counts.due },
    ] satisfies LedgerStep[],
    dueSteps: [
      { key: "held", label: "Held", value: counts.held },
      { key: "noShow", label: "No-show", value: counts.noShow },
      { key: "notRecorded", label: "Not recorded", value: counts.notRecorded },
    ] satisfies LedgerStep[],
    sentence: `${plural(slots, "slot")}: ${formatCount(counts.moved)} moved, ${formatCount(counts.canceled)} canceled, ${formatCount(
      counts.upcoming,
    )} still to come and ${formatCount(counts.due)} due. Of those due, ${formatCount(counts.held)} held, ${formatCount(
      counts.noShow,
    )} no-show and ${formatCount(counts.notRecorded)} not recorded.`,
  };
}

export const LEAD_TIME_LABEL: Record<CallsSummary["leadTime"][number]["bucket"], string> = {
  same_day: "Same day",
  next_day: "Next day",
  "2_3_days": "2–3 days ahead",
  "4_7_days": "4–7 days ahead",
  "8_plus_days": "8 or more days ahead",
};

export const MARKER_LABEL: Record<keyof CallsSummary["noShowMarkers"], string> = {
  closer: "Closer",
  calendly: "Calendly",
  admin: "Admin",
  unknown: "Not recorded who",
};

const REASON_LABEL: Record<string, string> = {
  no_response: "No response",
  late_cancel: "Canceled late",
  technical_issues: "Technical issues",
  other: "Other",
  unknown: "No reason given",
};

export function reasonLabel(reason: string) {
  return REASON_LABEL[reason] ?? reason;
}

/** Median time to record, and how many results came a day or more after the call. */
export function recordTiming(minutes: readonly number[]) {
  return {
    count: minutes.length,
    median: median(minutes),
    late: minutes.filter((value) => value >= 1440).length,
  };
}

/** The owed card's meta and footer: the total, and whether the list stops at the oldest 200. */
export function owedWords(owedTotal: number, shown: number, phrase: string) {
  if (owedTotal === 0) return { meta: "Nothing owed", footer: null, empty: `Every call due ${phrase} has a result.` };
  const meta = `${plural(owedTotal, "call")} with no result`;
  const footer =
    owedTotal > shown
      ? `Showing the oldest ${formatCount(shown)} of ${formatCount(owedTotal)} calls still owed a result.`
      : `${owedTotal === 1 ? "This call is" : `All ${formatCount(owedTotal)} calls are`} still owed a result.`;
  return { meta, footer, empty: null };
}

export const CALLS_TERMS: readonly ReportTermKey[] = [
  "callsScheduled",
  "moved",
  "canceled",
  "callsDue",
  "notRecorded",
  "showRate",
  "recorded",
  "showRateFloor",
  "firstCallShowRate",
  "followUpCall",
  "rebooked",
  "bookingLeadTime",
  "timeToRecord",
];

/** The figures the band shows, as label and words, for the export's summary. */
export function callsSummaryFigures(summary: CallsSummary) {
  const { counts } = summary;
  const overall = attendanceRates({ ...counts });
  return [
    { label: "Calls scheduled", value: formatCount(counts.scheduled) },
    { label: "Calls due", value: formatCount(counts.due) },
    { label: "Show rate", value: formatRate(overall.showRate) },
    { label: "Recorded", value: formatRate(overall.recordedRate) },
    { label: "Not recorded", value: formatCount(counts.notRecorded) },
    { label: "Moved", value: formatCount(counts.moved) },
    { label: "Canceled", value: formatCount(counts.canceled) },
  ];
}

/** The page as a `ReportDocument`: the band's figures, one table per card, then Definitions. */
export function buildCallsDocument(input: {
  summary: CallsSummary;
  period: string;
  boundary: string;
  filters: string;
  generatedAt: number;
}): ReportDocument {
  const { summary } = input;
  const { counts } = summary;
  const ledger = callsLedger(counts);
  const attendanceColumns = [
    { key: "held", label: "Held", format: "number" as const },
    { key: "noShow", label: "No-show", format: "number" as const },
    { key: "notRecorded", label: "Not recorded", format: "number" as const },
    { key: "showRate", label: "Show rate", format: "percent" as const },
    { key: "recorded", label: "Recorded", format: "percent" as const },
  ];
  const attendanceCells = (row: Attendance) => {
    const rates = attendanceRates(row);
    return { held: row.held, noShow: row.noShow, notRecorded: row.notRecorded, showRate: rates.showRate, recorded: rates.recordedRate };
  };
  const timing = recordTiming(summary.recordMinutes);
  const tables: ReportTable[] = [
    {
      title: "Where every call went",
      columns: [
        { key: "group", label: "Group" },
        { key: "bucket", label: "Bucket" },
        { key: "calls", label: "Calls", format: "number" },
      ],
      rows: [
        { group: "Slots", bucket: "All slots", calls: ledger.slots },
        ...ledger.slotSteps.map((step) => ({ group: "Slots", bucket: step.label, calls: step.value })),
        ...ledger.dueSteps.map((step) => ({ group: "Calls due", bucket: step.label, calls: step.value })),
      ],
    },
    {
      title: "Show rate, four ways",
      columns: [
        { key: "way", label: "Show rate" },
        { key: "rate", label: "Rate", format: "percent" },
        { key: "of", label: "Calls" },
        { key: "recorded", label: "Recorded", format: "percent" },
        { key: "recordedOf", label: "Recorded calls" },
      ],
      rows: showRateWays(summary).map((way) => ({
        way: `${way.label} (${way.question})`,
        rate: way.rate,
        of: way.of,
        recorded: way.recordedRate,
        recordedOf: way.recordedOf,
      })),
    },
    {
      title: "First calls by booking lead time",
      columns: [{ key: "leadTime", label: "Booked" }, ...attendanceColumns],
      rows: summary.leadTime.map((row) => ({ leadTime: LEAD_TIME_LABEL[row.bucket], ...attendanceCells(row) })),
    },
    {
      title: "Who marked the no-shows",
      columns: [
        { key: "marker", label: "Marked by" },
        { key: "noShows", label: "No-shows", format: "number" },
      ],
      rows: (Object.keys(MARKER_LABEL) as Array<keyof typeof MARKER_LABEL>).map((key) => ({
        marker: MARKER_LABEL[key],
        noShows: summary.noShowMarkers[key],
      })),
    },
    {
      title: "Why they didn't show",
      columns: [
        { key: "reason", label: "Reason" },
        { key: "noShows", label: "No-shows", format: "number" },
      ],
      rows: summary.noShowReasons.map((row) => ({ reason: reasonLabel(row.reason), noShows: row.count })),
    },
    {
      title: "Priority and Standard",
      columns: [{ key: "mode", label: "Scheduling mode" }, ...attendanceColumns],
      rows: [
        { mode: "Priority", ...attendanceCells(summary.mode.priority) },
        { mode: "Standard", ...attendanceCells(summary.mode.standard) },
      ],
    },
    {
      title: "Rebooked and time to record",
      columns: [
        { key: "figure", label: "Figure" },
        { key: "value", label: "Value" },
      ],
      rows: [
        { figure: "Rebooked after a no-show", value: formatCount(counts.rebooked) },
        { figure: "Rebooked and held", value: formatCount(counts.rebookedHeld) },
        { figure: "Rebooked and missed again", value: formatCount(counts.rebookedNoShow) },
        { figure: "Median time to record", value: formatMinutes(timing.median) },
        { figure: "Results recorded a day or more later", value: formatCount(timing.late) },
      ],
    },
    {
      title: "By day",
      columns: [
        { key: "day", label: "Business day" },
        ...attendanceColumns.slice(0, 3),
        { key: "canceled", label: "Canceled", format: "number" },
        { key: "moved", label: "Moved", format: "number" },
      ],
      rows: summary.byDay.map((day) => ({
        day: day.dayKey,
        held: day.held,
        noShow: day.noShow,
        notRecorded: day.notRecorded,
        canceled: day.canceled,
        moved: day.moved,
      })),
    },
    {
      title: summary.owedTotal > summary.owed.length ? `Still owed a result (oldest ${summary.owed.length} of ${summary.owedTotal})` : "Still owed a result",
      columns: [
        { key: "when", label: "Call" },
        { key: "person", label: "Person" },
        { key: "closer", label: "Closer" },
        { key: "program", label: "Program" },
        { key: "meetingId", label: "Meeting id" },
        { key: "opportunityId", label: "Deal id" },
      ],
      rows: summary.owed.map((row) => ({
        when: formatWhen(row.scheduledAt),
        person: row.leadName,
        closer: row.closerName,
        program: row.programName,
        meetingId: row.meetingId,
        opportunityId: row.opportunityId,
      })),
    },
    definitionsTable(CALLS_TERMS),
  ];
  return {
    title: "Calls",
    period: input.period,
    generatedAt: input.generatedAt,
    boundary: input.boundary,
    filters: summary.partial ? `${input.filters} · Partial: some calls couldn't be read` : input.filters,
    summary: callsSummaryFigures(summary),
    tables,
  };
}
