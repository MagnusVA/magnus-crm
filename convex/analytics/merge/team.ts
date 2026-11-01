import type { getActionsPerCloserPerDay } from "../../reporting/teamActions";
import type { getTeamOutcomeMix } from "../../reporting/teamOutcomes";
import type { getTeamOperationsDimensions, getTeamPerformanceMetrics } from "../../reporting/teamPerformance";
import type { ReaderOutput } from "../definition";
import { addCounts, joinOntoToday, mergeRows, rate } from "./helpers";

type Metrics = ReaderOutput<typeof getTeamPerformanceMetrics>;
type Outcomes = ReaderOutput<typeof getTeamOutcomeMix>;
type Actions = ReaderOutput<typeof getActionsPerCloserPerDay>;
type Operations = ReaderOutput<typeof getTeamOperationsDimensions>;

/** Adds numeric counters, retaining today's identity; callers replace derived rates. */
function addNumbers<Row extends object>(history: Row, today: Row): Row {
  const result = { ...today };
  for (const key of Object.keys(today) as Array<keyof Row>) {
    const past = history[key];
    const current = today[key];
    if (typeof past === "number" && typeof current === "number") {
      result[key] = (past + current) as Row[keyof Row];
    }
  }
  return result;
}

export function mergeTeamMetrics(history: Metrics, today: Metrics): Metrics {
  const capped = history.isCloseRateCohortTruncated || today.isCloseRateCohortTruncated;
  const cohort = (past: { cohortDeals: number | null; wonDeals: number | null }, current: typeof past) => {
    const cohortDeals = capped || past.cohortDeals === null || current.cohortDeals === null
      ? null : past.cohortDeals + current.cohortDeals;
    const wonDeals = capped || past.wonDeals === null || current.wonDeals === null
      ? null : past.wonDeals + current.wonDeals;
    return { cohortDeals, wonDeals, closeRate: cohortDeals === null || wonDeals === null ? null : rate(wonDeals, cohortDeals) };
  };
  const calls = (past: Metrics["closers"][number]["newCalls"], current: typeof past) => {
    const total = addNumbers(past, current);
    return { ...total, showUpRate: rate(total.callsShowed, total.confirmedAttendanceDenominator) };
  };
  const total = addNumbers(history.teamTotals, today.teamTotals);
  const totalCohort = cohort(history.teamTotals, today.teamTotals);
  return {
    closers: joinOntoToday(history.closers, today.closers, (row) => row.closerId, (past, current) => {
      const combined = addNumbers(past, current);
      return {
        ...combined,
        ...cohort(past, current),
        newCalls: calls(past.newCalls, current.newCalls),
        followUpCalls: calls(past.followUpCalls, current.followUpCalls),
        avgCashCollectedMinor: rate(combined.cashCollectedMinor, combined.sales),
      };
    }).map((row) => capped ? { ...row, cohortDeals: null, wonDeals: null, closeRate: null } : row),
    teamTotals: {
      ...total,
      cohortDeals: totalCohort.cohortDeals,
      wonDeals: totalCohort.wonDeals,
      overallCloseRate: totalCohort.closeRate,
      newShowUpRate: rate(total.newShowed, total.newConfirmedAttendanceDenominator),
      followUpShowUpRate: rate(total.followUpShowed, total.followUpConfirmedAttendanceDenominator),
      overallShowUpRate: rate(total.newShowed + total.followUpShowed, total.overallConfirmedDenominator),
      avgCashCollectedMinor: rate(total.totalRevenue, total.totalSales),
    },
    attendanceCountsPartial: history.attendanceCountsPartial || today.attendanceCountsPartial,
    isPaymentDataTruncated: history.isPaymentDataTruncated || today.isPaymentDataTruncated,
    isCloseRateCohortTruncated: capped,
  };
}

export function mergeTeamOutcomes(history: Outcomes, today: Outcomes): Outcomes {
  // Payment and reschedule evidence can cross the split. The aggregate answer
  // has no meeting/deal ids to reclassify those historical outcomes.
  const teamOutcome = addCounts(history.teamOutcome, today.teamOutcome);
  const rebookDenominator = teamOutcome.canceled + teamOutcome.no_show;
  return {
    teamOutcome,
    displayOutcome: addCounts(history.displayOutcome, today.displayOutcome),
    closerOutcomes: joinOntoToday(history.closerOutcomes, today.closerOutcomes, (row) => row.closerId, (past, current) => ({
      ...current, outcomes: addCounts(past.outcomes, current.outcomes),
    })),
    derived: {
      lostDeals: teamOutcome.lost,
      rebookNumerator: teamOutcome.rescheduled,
      rebookDenominator,
      rebookRate: rate(teamOutcome.rescheduled, rebookDenominator),
    },
    isTruncated: history.isTruncated || today.isTruncated,
  };
}

export function mergeTeamActions(history: Actions, today: Actions): Actions {
  // Every closer is listed in the order of their first action: history's,
  // then today's new ones, as the whole range would list them. An answer
  // cached before the list existed has only its top three until the next
  // sync replaces it.
  const closerActors = mergeRows(
    (history.closerActors as Actions["closerActors"] | undefined) ?? history.topCloserActors,
    today.closerActors,
    (row) => row.userId,
    (past, current) => ({ ...current, count: past.count + current.count }),
  );
  const totalCloserActions = history.totalCloserActions + today.totalCloserActions;
  const distinctCloserActors = closerActors.length;
  const daySpanDays = history.daySpanDays + today.daySpanDays;
  return {
    totalCloserActions,
    distinctCloserActors,
    daySpanDays,
    actionsPerCloserPerDay:
      distinctCloserActors > 0 ? totalCloserActions / distinctCloserActors / daySpanDays : null,
    closerActors,
    topCloserActors: [...closerActors].sort((left, right) => right.count - left.count).slice(0, 3),
    isTruncated: history.isTruncated || today.isTruncated,
  };
}

export function mergeTeamOperations(history: Operations, today: Operations): Operations {
  const combine = <Row extends Operations["totals"]>(past: Row, current: Row): Row => {
    const total = addNumbers(past, current);
    return { ...total, showRate: rate(total.completed, total.resultsRecorded), noShowRate: rate(total.noShows, total.resultsRecorded) };
  };
  return {
    rows: mergeRows(history.rows, today.rows, (row) => row.closerId, combine)
      .sort((left, right) => right.scheduled - left.scheduled || left.closerName.localeCompare(right.closerName)),
    totals: combine(history.totals, today.totals),
    attendanceCountsPartial: history.attendanceCountsPartial || today.attendanceCountsPartial,
    truncated: history.truncated || today.truncated,
  };
}
