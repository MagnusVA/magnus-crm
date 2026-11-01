import type { getOverviewDashboard } from "../../dashboard/overview";
import type { listOverviewLeaderboardRows } from "../../dashboard/overviewLeaderboards";
import type { LeadGenOverview, PhoneCloserOperations, SectionResult, TopDmCloserRow, TopQualifierRow } from "../../dashboard/overviewTypes";
import type { ReaderOutput } from "../definition";
import { mergeRows, rate } from "./helpers";

type Dashboard = ReaderOutput<typeof getOverviewDashboard>;
type Leaderboard = ReaderOutput<typeof listOverviewLeaderboardRows>;
type Worker = LeadGenOverview["topWorkers"][number];

/** The builders rank known efficiency first, then count, then name. */
function efficiency(leftRate: number | null, rightRate: number | null, leftCount: number, rightCount: number, leftName: string, rightName: string) {
  if ((leftRate !== null) !== (rightRate !== null)) return leftRate !== null ? -1 : 1;
  return (rightRate ?? -1) - (leftRate ?? -1) || rightCount - leftCount || leftName.localeCompare(rightName);
}

function workers(history: Worker[], today: Worker[]) {
  return mergeRows(history, today, (row) => row.workerId, (past, current) => {
    const submissions = past.submissions + current.submissions;
    const scheduledHours = past.scheduledHours + current.scheduledHours;
    return { ...current, submissions, scheduledHours, leadsPerHour: rate(submissions, scheduledHours) };
  }).sort((left, right) => efficiency(left.leadsPerHour, right.leadsPerHour, left.submissions, right.submissions, left.displayName, right.displayName));
}

function qualifiers(history: TopQualifierRow[], today: TopQualifierRow[]) {
  // Booked deals are distinct within each answer, but no deal ids survive to
  // deduplicate a deal qualified on both sides. Sum those counts approximately.
  return mergeRows(history, today, (row) => row.slackUserId, (past, current) => {
    const uniqueOpportunityCount = past.uniqueOpportunityCount + current.uniqueOpportunityCount;
    const booked = past.booked + current.booked;
    const scheduledHours = past.scheduledHours + current.scheduledHours;
    return { ...current, total: past.total + current.total, uniqueOpportunityCount, booked, scheduledHours, ratio: rate(booked, uniqueOpportunityCount), qualifiedPerHour: rate(uniqueOpportunityCount, scheduledHours) };
  }).sort((left, right) => efficiency(left.qualifiedPerHour, right.qualifiedPerHour, left.uniqueOpportunityCount, right.uniqueOpportunityCount, left.displayName ?? left.slackUserId, right.displayName ?? right.slackUserId));
}

function dmClosers(history: TopDmCloserRow[], today: TopDmCloserRow[]) {
  return mergeRows(history, today, (row) => row.dmCloserId, (past, current) => {
    const booked = past.booked + current.booked;
    const scheduledHours = past.scheduledHours + current.scheduledHours;
    return { ...current, booked, scheduledHours, bookedPerHour: rate(booked, scheduledHours) };
  }).sort((left, right) => efficiency(left.bookedPerHour, right.bookedPerHour, left.booked, right.booked, left.displayName, right.displayName));
}

function section<Data>(history: SectionResult<Data>, today: SectionResult<Data>, merge: (history: Data, today: Data) => Data): SectionResult<Data> {
  // A failure on either side must remain visible, even when the other is ready.
  for (const status of ["error", "capped", "rebuilding"] as const) {
    if (today.status === status) return today;
    if (history.status === status) return history;
  }
  if (history.data === null) return history;
  if (today.data === null) return today;
  const data = merge(history.data, today.data);
  if (history.status === "empty" && today.status === "empty") return { ...today, data };
  return { status: "ready", data, truncated: history.truncated || today.truncated, message: null, errorCode: null };
}

function phoneCounts<Row extends PhoneCloserOperations["totals"]>(past: Row, current: Row): Row {
  const held = past.held + current.held;
  const noShows = past.noShows + current.noShows;
  return {
    ...current,
    scheduled: past.scheduled + current.scheduled,
    held,
    noShows,
    reviewRequired: past.reviewRequired + current.reviewRequired,
    resultsRecorded: past.resultsRecorded + current.resultsRecorded,
    pastCalls: past.pastCalls + current.pastCalls,
    // The reader spreads this counter onto rows, though its public row type
    // omits it. Totals omit it at runtime too, so preserve its presence.
    ...("notRecorded" in current ? {
      notRecorded: past.pastCalls + current.pastCalls - past.resultsRecorded - current.resultsRecorded,
    } : {}),
    showRate: rate(held, held + noShows),
    noShowRate: rate(noShows, held + noShows),
  };
}

export function mergeOverviewDashboard(history: Dashboard, today: Dashboard): Dashboard {
  const startBusinessDate = history.range.startBusinessDate;
  const endBusinessDateInclusive = today.range.endBusinessDateInclusive;
  return {
    range: {
      ...today.range,
      startBusinessDate,
      dayCount: history.range.dayCount + today.range.dayCount,
      label: startBusinessDate === endBusinessDateInclusive ? startBusinessDate : `${startBusinessDate} to ${endBusinessDateInclusive}`,
    },
    // Each side has already cut its top lists. Combine available candidates,
    // re-rank, and cut again; omitted counts/hours cannot be recovered.
    leadGen: section(history.leadGen, today.leadGen, (past, current) => ({
      totalSubmissions: past.totalSubmissions + current.totalSubmissions,
      topWorkers: workers(past.topWorkers, current.topWorkers).slice(0, 5),
    })),
    topQualifiers: section(history.topQualifiers, today.topQualifiers, (past, current) => ({
      totalQualified: past.totalQualified + current.totalQualified,
      rows: qualifiers(past.rows, current.rows).slice(0, 5),
    })),
    topDmClosers: section(history.topDmClosers, today.topDmClosers, (past, current) => ({
      totalBooked: past.totalBooked + current.totalBooked,
      rows: dmClosers(past.rows, current.rows).slice(0, 5),
    })),
    phoneCloserOperations: section(history.phoneCloserOperations, today.phoneCloserOperations, (past, current) => ({
      attendanceCountsPartial: past.attendanceCountsPartial || current.attendanceCountsPartial,
      rows: mergeRows(past.rows, current.rows, (row) => row.closerId, phoneCounts)
        .sort((left, right) => right.scheduled - left.scheduled || (left.closer.name ?? left.closer.email ?? "Unknown").localeCompare(right.closer.name ?? right.closer.email ?? "Unknown")),
      totals: phoneCounts(past.totals, current.totals),
    })),
    topOrigins: section(history.topOrigins, today.topOrigins, (past, current) => ({
      rows: mergeRows(past.rows, current.rows, (row) => `${row.source}:${row.originKey}`, (left, right) => ({
        ...right, submissions: left.submissions + right.submissions, uniqueProspects: left.uniqueProspects + right.uniqueProspects,
      })).sort((left, right) => right.submissions - left.submissions || right.uniqueProspects - left.uniqueProspects || left.originValue.localeCompare(right.originValue)).slice(0, 10),
    })),
  };
}

export function mergeOverviewLeaderboard(history: Leaderboard, today: Leaderboard): Leaderboard {
  if ("status" in today) return today;
  if ("status" in history) return history;
  const metadata = {
    truncated: history.truncated || today.truncated,
    cappedMessage: today.cappedMessage ?? history.cappedMessage,
  };
  // Expanded leaderboards list every current candidate; their rows carry the
  // scheduled hours needed to recompute efficiency over the whole range.
  if (history.kind === "lead_gen" && today.kind === "lead_gen") {
    const rows = workers(history.rows, today.rows);
    return { ...today, ...metadata, rows, totalRows: rows.length, filteredRows: rows.length };
  }
  if (history.kind === "qualifiers" && today.kind === "qualifiers") {
    const rows = qualifiers(history.rows, today.rows);
    return { ...today, ...metadata, rows, totalRows: rows.length, filteredRows: rows.length };
  }
  if (history.kind === "dm_closers" && today.kind === "dm_closers") {
    const rows = dmClosers(history.rows, today.rows);
    return { ...today, ...metadata, rows, totalRows: rows.length, filteredRows: rows.length };
  }
  return today;
}
