import type { CashAmounts, CashOutput, FollowThroughOutput, FunnelOutput, OriginsOutput, TaskCounts } from "../../reports/scorecard";
import { addCounts, mergeRows } from "./helpers";

const byCurrency = (a: CashAmounts[], b: CashAmounts[]): CashAmounts[] => mergeRows(a, b, r => r.currency, (a, b) => ({
  currency: b.currency, cashMinor: a.cashMinor + b.cashMinor, finalMinor: a.finalMinor + b.finalMinor,
})).sort((a, b) => a.currency.localeCompare(b.currency));
export function mergeFunnel(history: FunnelOutput, today: FunnelOutput): FunnelOutput {
  return { stages: addCounts(history.stages, today.stages), cohort: addCounts(history.cohort, today.cohort),
    activity: { bookingsMade: history.activity.bookingsMade + today.activity.bookingsMade,
      callsHeld: history.activity.callsHeld + today.activity.callsHeld, dealsWon: history.activity.dealsWon + today.activity.dealsWon,
      cash: byCurrency(history.activity.cash, today.activity.cash) },
    byDay: mergeRows(history.byDay, today.byDay, r => r.dayKey, (a, b) => ({ dayKey: b.dayKey,
      bookingsMade: a.bookingsMade + b.bookingsMade, callsHeld: a.callsHeld + b.callsHeld,
      dealsWon: a.dealsWon + b.dealsWon, cash: byCurrency(a.cash, b.cash) })).sort((a, b) => a.dayKey.localeCompare(b.dayKey)),
  };
}
export function mergeCash(history: CashOutput, today: CashOutput): CashOutput {
  return { currencies: mergeRows(history.currencies, today.currencies, r => r.currency, (a, b) => ({
    currency: b.currency, cashMinor: a.cashMinor + b.cashMinor, finalMinor: a.finalMinor + b.finalMinor,
    depositMinor: a.depositMinor + b.depositMinor, byType: addCounts(a.byType, b.byType),
    depositsOnLostDeals: a.depositsOnLostDeals + b.depositsOnLostDeals,
    finalOnWonDealsMinor: a.finalOnWonDealsMinor + b.finalOnWonDealsMinor, dealsWon: a.dealsWon + b.dealsWon,
    byProgram: mergeRows(a.byProgram, b.byProgram, r => r.programId, (a, b) => ({ ...b,
      cashMinor: a.cashMinor + b.cashMinor, finalMinor: a.finalMinor + b.finalMinor, payments: a.payments + b.payments,
      dealsWon: a.dealsWon + b.dealsWon, finalOnWonDealsMinor: a.finalOnWonDealsMinor + b.finalOnWonDealsMinor,
    })).sort((a, b) => a.programId.localeCompare(b.programId)),
  })).sort((a, b) => a.currency.localeCompare(b.currency)) };
}
const tasks = (a: TaskCounts, b: TaskCounts): TaskCounts => ({ due: a.due + b.due, onTime: a.onTime + b.onTime,
  late: a.late + b.late, openOverdue: a.openOverdue + b.openOverdue });
export function mergeFollowThrough(history: FollowThroughOutput, today: FollowThroughOutput): FollowThroughOutput {
  return { ...tasks(history, today), byCloser: mergeRows(history.byCloser, today.byCloser, r => r.userId,
    (a, b) => ({ ...b, ...tasks(a, b) })).sort((a, b) => a.userId.localeCompare(b.userId)) };
}
export function mergeOrigins(history: OriginsOutput, today: OriginsOutput): OriginsOutput {
  return { origins: mergeRows(history.origins, today.origins, r => r.channel, (a, b) => ({
    channel: b.channel, dealsWon: a.dealsWon + b.dealsWon, cash: byCurrency(a.cash, b.cash),
  })).sort((a, b) => a.channel.localeCompare(b.channel)) };
}
// Distinct answering people and their current deals can span both windows.
// The page must request the whole range from ClickHouse for this panel.
export const mergeAnswers = null;
