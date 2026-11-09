import type { AttributionLanes, AttributionPaths } from "../../reports/attribution";
import { mergeRows } from "./helpers";

export function unionCreditIds(history: readonly string[], today: readonly string[]) {
  return [...new Set([...history, ...today])].sort();
}

export function mergeCreditMoney(history: { currency: string; amountMinor: number }[], today: { currency: string; amountMinor: number }[]) {
  return mergeRows(history, today, row => row.currency, (past, current) => ({
    currency: current.currency, amountMinor: past.amountMinor + current.amountMinor,
  })).sort((a, b) => a.currency.localeCompare(b.currency));
}

export function mergeAttributionLanes(history: AttributionLanes, today: AttributionLanes): AttributionLanes {
  const result: AttributionLanes = {
    currencies: unionCreditIds(history.currencies, today.currencies),
    totals: mergeRows(history.totals, today.totals, row => row.currency, (past, current) => ({
      currency: current.currency, cashMinor: past.cashMinor + current.cashMinor,
      finalMinor: past.finalMinor + current.finalMinor, payments: past.payments + current.payments,
    })).sort((a, b) => a.currency.localeCompare(b.currency)),
    lanes: mergeRows(history.lanes, today.lanes, row => row.role, (past, current) => ({
      ...current, dealIds: unionCreditIds(past.dealIds, current.dealIds),
      byCurrency: mergeRows(past.byCurrency, current.byCurrency, row => row.currency, (p, c) => ({
        currency: c.currency, laneMinor: p.laneMinor + c.laneMinor, sharedMinor: p.sharedMinor + c.sharedMinor, coverage: null,
      })).sort((a, b) => a.currency.localeCompare(b.currency)),
      people: mergeRows(past.people, current.people, row => row.key, (p, c) => ({
        ...c, dealIds: unionCreditIds(p.dealIds, c.dealIds), byCurrency: mergeCreditMoney(p.byCurrency, c.byCurrency),
      })).sort((a, b) => a.key.localeCompare(b.key)),
    })),
    uncreditedByRole: mergeRows(history.uncreditedByRole, today.uncreditedByRole, row => row.role, (past, current) => ({
      role: current.role, byCurrency: mergeCreditMoney(past.byCurrency, current.byCurrency),
    })), isTruncated: history.isTruncated || today.isTruncated,
  };
  return { ...result, lanes: result.lanes.map(lane => ({ ...lane, byCurrency: lane.byCurrency.map(money => {
    const total = result.totals.find(total => total.currency === money.currency)?.cashMinor ?? 0;
    return { ...money, coverage: total !== 0 ? money.laneMinor / total : null };
  }) })) };
}

export function mergeAttributionPaths(history: AttributionPaths, today: AttributionPaths): AttributionPaths {
  return { paths: mergeRows(history.paths, today.paths, row => row.key, (past, current) => ({
    ...current, dealIds: unionCreditIds(past.dealIds, current.dealIds), byCurrency: mergeCreditMoney(past.byCurrency, current.byCurrency),
  })).sort((a, b) => a.key.localeCompare(b.key)), isTruncated: history.isTruncated || today.isTruncated };
}
