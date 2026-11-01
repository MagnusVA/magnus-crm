import type { getQualificationReport } from "../../reporting/slackQualifications";
import type { ReaderOutput } from "../definition";
import { joinOntoToday, mergeRows, rate } from "./helpers";

type Report = ReaderOutput<typeof getQualificationReport>;

export function mergeSlackQualifications(history: Report, today: Report): Report {
  const past = history.totals;
  const current = today.totals;
  const totalQualified = past.totalQualified + current.totalQualified;
  const businessDayCount = past.businessDayCount + current.businessDayCount;
  const goal = today.teamGoal.dailyTeamQualificationGoal;
  const teamView = today.selectedSlackUserId === null;
  const expectedTeamQualified = teamView && goal !== null ? goal * businessDayCount : null;
  // The answers carry distinct counts without ids. Summing can count a deal
  // again if it has qualification events on both sides of the split.
  const periods = mergeRows(history.periods, today.periods, (row) => row.key, (left, right) => ({
    ...right,
    start: left.start,
    goalDays: left.goalDays + right.goalDays,
    qualifiedCount: left.qualifiedCount + right.qualifiedCount,
    qualificationEventCount: left.qualificationEventCount + right.qualificationEventCount,
    uniqueSlackOpportunityCount: left.uniqueSlackOpportunityCount + right.uniqueSlackOpportunityCount,
  })).map((period) => {
    const expectedTeamCount = goal === null ? null : goal * period.goalDays;
    return { ...period, expectedTeamCount, teamGoalAttainment: expectedTeamCount === null ? null : rate(period.qualifiedCount, expectedTeamCount) };
  });
  const users = joinOntoToday(history.users, today.users, (row) => row.slackUserId, (left, right) => ({
    ...right,
    totalQualified: left.totalQualified + right.totalQualified,
    qualificationEventCount: left.qualificationEventCount + right.qualificationEventCount,
    uniqueSlackOpportunityCount: left.uniqueSlackOpportunityCount + right.uniqueSlackOpportunityCount,
    createdOpportunityEvents: left.createdOpportunityEvents + right.createdOpportunityEvents,
    duplicatePendingEvents: left.duplicatePendingEvents + right.duplicatePendingEvents,
    alreadyBookedEvents: left.alreadyBookedEvents + right.alreadyBookedEvents,
    unlinkedEvents: left.unlinkedEvents + right.unlinkedEvents,
    lastQualifiedAt: left.lastQualifiedAt === null ? right.lastQualifiedAt : right.lastQualifiedAt === null ? left.lastQualifiedAt : Math.max(left.lastQualifiedAt, right.lastQualifiedAt),
  })).map((row) => ({ ...row, contributionShare: teamView ? rate(row.totalQualified, totalQualified) : null }))
    .sort((left, right) => right.totalQualified - left.totalQualified || left.displayName.localeCompare(right.displayName, undefined, { sensitivity: "base" }));
  return {
    ...today,
    startBusinessDate: history.startBusinessDate,
    settersTruncated: history.settersTruncated || today.settersTruncated,
    periods,
    users,
    totals: {
      ...current,
      totalQualified,
      businessDayCount,
      averagePerBusinessDay: rate(totalQualified, businessDayCount),
      expectedTeamQualified,
      teamGoalDelta: expectedTeamQualified === null ? null : totalQualified - expectedTeamQualified,
      teamGoalAttainment: expectedTeamQualified === null ? null : rate(totalQualified, expectedTeamQualified),
      underGoalPeriods: teamView ? periods.filter((row) => row.expectedTeamCount !== null && row.qualifiedCount < row.expectedTeamCount).length : 0,
      setterCount: users.length,
      qualificationEventCount: past.qualificationEventCount + current.qualificationEventCount,
      uniqueLinkedOpportunityCount: past.uniqueLinkedOpportunityCount + current.uniqueLinkedOpportunityCount,
      uniqueSlackOpportunityCount: past.uniqueSlackOpportunityCount + current.uniqueSlackOpportunityCount,
      createdOpportunityEvents: past.createdOpportunityEvents + current.createdOpportunityEvents,
      duplicatePendingEvents: past.duplicatePendingEvents + current.duplicatePendingEvents,
      alreadyBookedEvents: past.alreadyBookedEvents + current.alreadyBookedEvents,
      unlinkedEvents: past.unlinkedEvents + current.unlinkedEvents,
      legacyOpportunityAggregateCount: past.legacyOpportunityAggregateCount + current.legacyOpportunityAggregateCount,
      eventsTruncated: past.eventsTruncated || current.eventsTruncated,
    },
  };
}
