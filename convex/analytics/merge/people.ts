import type {
  CloserCash,
  CloserRow,
  PeopleClosers,
} from "../../reports/people";
import { mergeRows } from "./helpers";

function cash(a: CloserCash[], b: CloserCash[]) {
  return mergeRows(
    a,
    b,
    (r) => r.currency,
    (x, y) => ({
      currency: y.currency,
      cashMinor: x.cashMinor + y.cashMinor,
      finalMinor: x.finalMinor + y.finalMinor,
    }),
  ).sort((x, y) => x.currency.localeCompare(y.currency));
}
const counts = [
  "due",
  "held",
  "noShow",
  "notRecorded",
  "moved",
  "canceled",
  "firstHeld",
  "firstNoShow",
  "firstNotRecorded",
  "followUpHeld",
  "followUpNoShow",
  "cohortDeals",
  "cohortWon",
  "dealsWon",
  "payments",
] as const;
function row(a: CloserRow, b: CloserRow): CloserRow {
  const merged = {
    ...b,
    cash: cash(a.cash, b.cash),
    recordMinutes: [...a.recordMinutes, ...b.recordMinutes],
  };
  for (const key of counts) merged[key] = a[key] + b[key];
  return merged;
}
export function mergePeopleClosers(
  history: PeopleClosers,
  today: PeopleClosers,
): PeopleClosers {
  const calls = mergeRows(
    history.calls,
    today.calls,
    (r) => r.meetingId,
    (_a, b) => b,
  ).sort(
    (a, b) =>
      b.scheduledAt - a.scheduledAt || a.meetingId.localeCompare(b.meetingId),
  );
  // Old caches retain scalar addition. Only reconcile when both complete sets
  // are present; newer windows invalidate older recipients even if unattributed.
  const reconcile = history.firstPaymentDealIds !== undefined && today.firstPaymentDealIds !== undefined
    && history.rows.every(r => r.wonDealIds !== undefined) && today.rows.every(r => r.wonDealIds !== undefined);
  const newer = new Set(today.firstPaymentDealIds);
  const olderRows = reconcile ? history.rows.map(r => ({ ...r, wonDealIds: r.wonDealIds!.filter(id => !newer.has(id)) })) : history.rows;
  const rows = mergeRows(olderRows, today.rows, r => r.userId, (a, b) => ({ ...row(a, b),
    ...(reconcile ? { wonDealIds: [...new Set([...a.wonDealIds!, ...b.wonDealIds!])].sort() } : {}),
  }));
  if (reconcile) for (const r of rows) r.dealsWon = r.wonDealIds!.length;
  return {
    ...(reconcile ? { firstPaymentDealIds: [...new Set([...history.firstPaymentDealIds!, ...today.firstPaymentDealIds!])].sort() } : {}),
    rows: rows.sort(
      (a, b) =>
        a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId),
    ),
    unattributedCash: cash(history.unattributedCash, today.unattributedCash),
    days: mergeRows(
      history.days,
      today.days,
      (r) => r.dayKey,
      (a, b) => ({
        dayKey: b.dayKey,
        held: a.held + b.held,
        noShow: a.noShow + b.noShow,
        notRecorded: a.notRecorded + b.notRecorded,
        cashMinorByCurrency: mergeRows(
          a.cashMinorByCurrency,
          b.cashMinorByCurrency,
          (r) => r.currency,
          (x, y) => ({
            currency: y.currency,
            cashMinor: x.cashMinor + y.cashMinor,
          }),
        ).sort((x, y) => x.currency.localeCompare(y.currency)),
      }),
    ).sort((a, b) => a.dayKey.localeCompare(b.dayKey)),
    calls: calls.slice(0, 300),
    callsPartial:
      history.callsPartial || today.callsPartial || calls.length > 300,
    partial: history.partial || today.partial,
    cohortPartial: history.cohortPartial || today.cohortPartial,
    paymentsPartial: history.paymentsPartial || today.paymentsPartial,
  };
}
