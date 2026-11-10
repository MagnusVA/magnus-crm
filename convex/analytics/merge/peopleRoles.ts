import type { PeopleRoleReport, PeopleRoleRow } from "../../reports/peopleRoles";
import { addCounts, mergeRows, rate } from "./helpers";
import { mergeCreditMoney, unionCreditIds } from "./attribution";

function mergeRow(past: PeopleRoleRow, current: PeopleRoleRow, role: PeopleRoleReport["role"]): PeopleRoleRow {
  const dealIds = unionCreditIds(past.dealIds, current.dealIds);
  const bookedDealIds = unionCreditIds(past.bookedDealIds, current.bookedDealIds);
  const heldDealIds = unionCreditIds(past.heldDealIds, current.heldDealIds);
  const wonDealIds = unionCreditIds(past.wonDealIds, current.wonDealIds);
  const personIds = unionCreditIds(past.personIds, current.personIds);
  const captureDealIds = unionCreditIds(past.captureDealIds, current.captureDealIds);
  const resparkDealIds = unionCreditIds(past.resparkDealIds, current.resparkDealIds);
  return { ...current, dealIds, bookedDealIds, heldDealIds, wonDealIds, personIds, captureDealIds, resparkDealIds,
    qualifications: past.qualifications + current.qualifications,
    qualificationsByResult: addCounts(past.qualificationsByResult, current.qualificationsByResult),
    dealsCredited: dealIds.length, booked: bookedDealIds.length,
    held: role === "dm_closer" ? past.held + current.held : heldDealIds.length,
    won: wonDealIds.length, dealsWon: wonDealIds.length,
    bookings: past.bookings + current.bookings, noShow: past.noShow + current.noShow, notRecorded: past.notRecorded + current.notRecorded,
    captures: past.captures + current.captures, uniquePeople: personIds.length, resparks: past.resparks + current.resparks,
    dealsCreditedBySource: { capture: captureDealIds.length, respark: resparkDealIds.length },
    bookRate: { numerator: bookedDealIds.length, denominator: dealIds.length, rate: rate(bookedDealIds.length, dealIds.length) },
    byCurrency: mergeCreditMoney(past.byCurrency, current.byCurrency), scheduledHours: past.scheduledHours + current.scheduledHours };
}

export function mergePeopleRoles(history: PeopleRoleReport, today: PeopleRoleReport): PeopleRoleReport {
  if (history.role !== today.role || history.memberId !== today.memberId) throw new Error("Cannot merge different member reports.");
  const reconcile = history.role !== "setter" && history.firstPaymentDealIds !== undefined && today.firstPaymentDealIds !== undefined;
  const newer = new Set(today.firstPaymentDealIds);
  const olderRows = reconcile ? history.rows.map(row => {
    const wonDealIds = row.wonDealIds.filter(id => !newer.has(id));
    return { ...row, wonDealIds, won: wonDealIds.length, dealsWon: wonDealIds.length };
  }) : history.rows;
  const { firstPaymentDealIds: _newerIds, ...current } = today;
  return { ...current,
    ...(history.firstPaymentDealIds !== undefined && today.firstPaymentDealIds !== undefined
      ? { firstPaymentDealIds: unionCreditIds(history.firstPaymentDealIds, today.firstPaymentDealIds) }
      : {}),
    rows: mergeRows(olderRows, today.rows, row => row.key, (past, current) => mergeRow(past, current, today.role))
      .sort((a, b) => a.key.localeCompare(b.key)),
    days: mergeRows(history.days, today.days, day => day.dayKey, (past, current) => ({
      dayKey: current.dayKey, qualifications: past.qualifications + current.qualifications,
      bookings: past.bookings + current.bookings, captures: past.captures + current.captures, resparks: past.resparks + current.resparks,
      cashMinorByCurrency: mergeCreditMoney(past.cashMinorByCurrency, current.cashMinorByCurrency),
    })).sort((a, b) => a.dayKey.localeCompare(b.dayKey)),
    items: mergeRows(history.items, today.items, item => item.id, (_past, current) => current)
      .sort((a, b) => b.at - a.at || a.id.localeCompare(b.id)).slice(0, 300),
    isTruncated: history.isTruncated || today.isTruncated,
  };
}

export const mergeSetters = mergePeopleRoles;
export const mergeDmClosers = mergePeopleRoles;
export const mergeLeadGen = mergePeopleRoles;
