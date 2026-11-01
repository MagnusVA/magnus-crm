import type { getSalesCallsDashboard } from "../../operations/salesCallsDashboard";
import type { getBookedCallsDashboard } from "../../operations/bookedCallsDashboard";
import type { getQualificationsDashboard } from "../../operations/qualificationsDashboard";
import type { ReaderOutput } from "../definition";
import { mergeRows, rate } from "./helpers";

type SalesCalls = ReaderOutput<typeof getSalesCallsDashboard>;
type BookedCalls = ReaderOutput<typeof getBookedCallsDashboard>;
type Qualifications = ReaderOutput<typeof getQualificationsDashboard>;

function compareLabels(left: string, right: string) {
  return left.localeCompare(right, undefined, { sensitivity: "base" });
}

function compareIds(left: string | null, right: string | null) {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left < right ? -1 : 1;
}

function addFields<Row, Key extends keyof Row>(past: Row, current: Row, keys: readonly Key[]): Row {
  const result = { ...current };
  for (const key of keys) {
    result[key] = ((past[key] as number) + (current[key] as number)) as Row[Key];
  }
  return result;
}

function mergeMoney(
  past: SalesCalls["teamTotal"]["moneyByCurrency"],
  current: SalesCalls["teamTotal"]["moneyByCurrency"],
) {
  return mergeRows(
    past,
    current,
    (row) => row.currency,
    (left, right) => {
      const paymentSales = left.paymentSales + right.paymentSales;
      const paymentRevenueMinor = left.paymentRevenueMinor + right.paymentRevenueMinor;
      return {
        ...right,
        paymentSales,
        paymentRevenueMinor,
        avgPaymentDealMinor: rate(paymentRevenueMinor, paymentSales),
      };
    },
  ).sort((left, right) => left.currency.localeCompare(right.currency));
}

function mergeAttendance<
  Row extends {
    showed: number;
    noShows: number;
    cohortDeals: number;
    wonDeals: number;
    showUpRate: number | null;
    closeRate: number | null;
  },
>(past: Row, current: Row, keys: readonly (keyof Row)[], capped: boolean): Row {
  const total = addFields(past, current, keys);
  return {
    ...total,
    showUpRate: rate(total.showed, total.showed + total.noShows),
    closeRate: capped ? null : rate(total.wonDeals, total.cohortDeals),
  };
}

export function mergeSalesCallsDashboard(history: SalesCalls, today: SalesCalls): SalesCalls {
  const capped = history.capped || today.capped;
  const meetingKeys = [
    "showed",
    "canceled",
    "noShows",
    "resultsRecorded",
    "pastCalls",
    "cohortDeals",
    "wonDeals",
  ] as const;
  const closerKeys = [...meetingKeys, "booked", "notRecorded"] as const;
  const summary = mergeAttendance(
    history.stats,
    today.stats,
    [...meetingKeys, "totalCalls"],
    capped,
  );
  const summaryMoney = mergeRows(
    history.stats.moneyByCurrency,
    today.stats.moneyByCurrency,
    (row) => row.currency,
    (past, current) => {
      const paymentSalesCount = past.paymentSalesCount + current.paymentSalesCount;
      const cashCollectedMinor = past.cashCollectedMinor + current.cashCollectedMinor;
      return {
        ...current,
        paymentSalesCount,
        cashCollectedMinor,
        avgCashPerSaleMinor: rate(cashCollectedMinor, paymentSalesCount),
      };
    },
  ).sort((left, right) => left.currency.localeCompare(right.currency));
  return {
    stats: { ...summary, moneyByCurrency: summaryMoney },
    perProgram: mergeRows(
      history.perProgram,
      today.perProgram,
      (row) => row.programId ?? "",
      (past, current) => ({
        ...mergeAttendance(past, current, [...meetingKeys, "calls"], capped),
        moneyByCurrency: mergeMoney(past.moneyByCurrency, current.moneyByCurrency),
      }),
    ).sort(
      (left, right) =>
        right.calls - left.calls ||
        compareLabels(left.label, right.label) ||
        compareIds(left.programId, right.programId),
    ),
    // The builder also includes former closers with activity in the range.
    closers: mergeRows(
      history.closers,
      today.closers,
      (row) => row.closerId,
      (past, current) => ({
        ...mergeAttendance(past, current, closerKeys, capped),
        moneyByCurrency: mergeMoney(past.moneyByCurrency, current.moneyByCurrency),
      }),
    ).sort(
      (left, right) =>
        right.booked - left.booked ||
        compareLabels(left.label, right.label) ||
        compareIds(left.closerId, right.closerId),
    ),
    teamTotal: {
      ...mergeAttendance(history.teamTotal, today.teamTotal, closerKeys, capped),
      moneyByCurrency: mergeMoney(
        history.teamTotal.moneyByCurrency,
        today.teamTotal.moneyByCurrency,
      ),
    },
    window: { start: history.window.start, end: today.window.end },
    attendanceCountsPartial: history.attendanceCountsPartial || today.attendanceCountsPartial,
    capped,
  };
}

export function mergeBookedCallsDashboard(history: BookedCalls, today: BookedCalls): BookedCalls {
  const businessDayCount = history.goal.businessDayCount + today.goal.businessDayCount;
  const teams = mergeRows(
    history.goal.teams,
    today.goal.teams,
    (row) => row.teamId,
    (past, current) => ({
      ...current,
      progress: past.progress + current.progress,
    }),
  )
    .map((team) => ({
      ...team,
      target: team.dailyQuota === null ? null : team.dailyQuota * businessDayCount,
    }))
    .sort((left, right) => compareLabels(left.label, right.label));
  const targets = teams.flatMap((team) => (team.target === null ? [] : [team.target]));
  return {
    totalBooked: history.totalBooked + today.totalBooked,
    dmClosers: mergeRows(
      history.dmClosers,
      today.dmClosers,
      (row) => row.key,
      (past, current) => {
        const booked = past.booked + current.booked;
        const hours = (past.scheduledHours ?? 0) + (current.scheduledHours ?? 0);
        return {
          ...current,
          booked,
          scheduledHours: hours > 0 ? hours : null,
          bookedPerHour: rate(booked, hours),
        };
      },
    ).sort((left, right) => right.booked - left.booked || compareLabels(left.label, right.label)),
    goal: {
      businessDayCount,
      teams,
      totalTarget: targets.length ? targets.reduce((sum, target) => sum + target, 0) : null,
      progress: history.goal.progress + today.goal.progress,
    },
    window: { start: history.window.start, end: today.window.end },
    capped: history.capped || today.capped,
  };
}

export function mergeQualificationsDashboard(
  history: Qualifications,
  today: Qualifications,
): Qualifications {
  const businessDayCount = history.goal.businessDayCount + today.goal.businessDayCount;
  return {
    totalQualified: history.totalQualified + today.totalQualified,
    openers: mergeRows(
      history.openers,
      today.openers,
      (row) => row.key,
      (past, current) => {
        const qualified = past.qualified + current.qualified;
        const scheduledHours =
          past.scheduledHours === null && current.scheduledHours === null
            ? null
            : (past.scheduledHours ?? 0) + (current.scheduledHours ?? 0);
        return {
          ...current,
          qualified,
          scheduledHours,
          qualifiedPerHour: rate(qualified, scheduledHours ?? 0),
          lastEventAt:
            past.lastEventAt === null && current.lastEventAt === null
              ? null
              : Math.max(past.lastEventAt ?? 0, current.lastEventAt ?? 0),
        };
      },
    ).sort(
      (left, right) => right.qualified - left.qualified || compareLabels(left.label, right.label),
    ),
    goal: {
      ...today.goal,
      businessDayCount,
      target: today.goal.dailyQuota === null ? null : today.goal.dailyQuota * businessDayCount,
      progress: history.goal.progress + today.goal.progress,
    },
    window: {
      qualifiedAfter: history.window.qualifiedAfter,
      qualifiedBefore: today.window.qualifiedBefore,
    },
    capped: history.capped || today.capped,
  };
}
