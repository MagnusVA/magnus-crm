import type { TestConvex } from "convex-test";
import type { Doc, Id } from "../convex/_generated/dataModel";
import type schema from "../convex/schema";
import type { SqlRow } from "../convex/analytics/clickhouse";
import { businessDateForInstant } from "../lib/businessDay";
import { from, now, range, to } from "./callsReportFixtures";

/** Fixture projection of the aggregate SQL's output. Does not execute SQL. */
export async function closerAggregateRows(t: TestConvex<typeof schema>, tenantId: Id<"tenants">, memberId: Id<"teamMembers"> | null, window = { fromMs: from, toMs: to }) {
  return t.run(async ctx => {
    const from = window.fromMs, to = window.toMs;
    const all = (await ctx.db.query("meetings").take(2000)).filter(m => m.tenantId === tenantId);
    const credits = (await ctx.db.query("dealAttributions").take(2000)).filter(c => c.tenantId === tenantId && c.role === "closer");
    const users = (await ctx.db.query("users").take(100)).filter(u => u.tenantId === tenantId);
    const deals = (await ctx.db.query("opportunities").take(2000)).filter(d => d.tenantId === tenantId);
    const people = await ctx.db.query("leads").take(100);
    const allPayments = (await ctx.db.query("paymentRecords").take(2000)).filter(p => p.tenantId === tenantId);
    const eligible = allPayments.filter(p => p.status !== "disputed");
    const payments = eligible.filter(p => p.recordedAt >= from && p.recordedAt < to);
    const memberUsers = new Set(users.filter(u => u.teamMemberId === memberId).map(u => u._id));
    const firstPayments = new Map<Id<"opportunities">, Doc<"paymentRecords">>();
    for (const p of [...eligible].sort((a, b) => a.recordedAt - b.recordedAt || a._creationTime - b._creationTime || a._id.localeCompare(b._id)))
      if (p.opportunityId && !firstPayments.has(p.opportunityId)) firstPayments.set(p.opportunityId, p);
    const firstHeld = new Map<Id<"opportunities">, Id<"meetings">>();
    for (const m of [...all].sort((a, b) => a.scheduledAt - b.scheduledAt || a._creationTime - b._creationTime || a._id.localeCompare(b._id)))
      if (m.status === "held" && !firstHeld.has(m.opportunityId)) firstHeld.set(m.opportunityId, m._id);
    const rows: Record<string, SqlRow[]> = { totals: [], cash: [], cohort: [], firstPaymentDeals: [], callDays: [], cashDays: [], calls: [] };
    const totals = new Map<string, SqlRow>();
    const cohort = new Map<string, SqlRow>();
    const callDays = new Map<string, SqlRow>();
    const meetings = all.filter(m => m.scheduledAt >= from && m.scheduledAt < to)
      .sort((a, b) => a.scheduledAt - b.scheduledAt || a._creationTime - b._creationTime || a._id.localeCompare(b._id));
    const facts = meetings.map(m => {
      const credit = credits.filter(c => c.meetingId === m._id)
        .sort((a, b) => b.attributedAt - a.attributedAt || b._creationTime - a._creationTime || b._id.localeCompare(a._id))[0];
      const closer = credit && "userId" in credit.source ? credit.source.userId : m.assignedCloserId;
      const due = m.status !== "canceled" && (m.status === "held" || m.status === "no_show" || m.scheduledAt + m.durationMinutes * 60000 <= now);
      const moved = m.status === "canceled" && all.some(s => s.rescheduledFromMeetingId === m._id);
      const status = moved ? "moved" : m.status === "scheduled" ? due ? "not_recorded" : "upcoming" : m.status;
      const type = m.callClassification ?? "new";
      let row = totals.get(closer);
      if (!row) {
        row = { closer_id: closer, due: 0, held: 0, no_show: 0, not_recorded: 0, moved: 0, canceled: 0,
          first_held: 0, first_no_show: 0, first_not_recorded: 0, follow_up_held: 0, follow_up_no_show: 0, record_minutes: [] };
        totals.set(closer, row);
      }
      if (due) row.due = Number(row.due) + 1;
      if (status !== "upcoming") row[status] = Number(row[status]) + 1;
      if (type === "new" && ["held", "no_show", "not_recorded"].includes(status)) row[`first_${status}`] = Number(row[`first_${status}`]) + 1;
      if (type !== "new" && ["held", "no_show"].includes(status)) row[`follow_up_${status}`] = Number(row[`follow_up_${status}`]) + 1;
      const recorded = m.heldMarkedAt ?? m.noShowMarkedAt;
      if (!moved && recorded !== undefined) (row.record_minutes as number[]).push(Math.trunc((recorded - m.scheduledAt - m.durationMinutes * 60000) / 60000));
      const deal = deals.find(d => d._id === m.opportunityId);
      if (firstHeld.get(m.opportunityId) === m._id && deal) {
        const c = cohort.get(closer) ?? { closer_id: closer, cohort_deals: 0, cohort_won: 0 };
        c.cohort_deals = Number(c.cohort_deals) + 1;
        c.cohort_won = Number(c.cohort_won) + Number(deal.outcome === "won");
        cohort.set(closer, c);
      }
      if (memberId && memberUsers.has(closer)) {
        const dayKey = businessDateForInstant(m.scheduledAt, range);
        const day = callDays.get(dayKey) ?? { day_key: dayKey, held: 0, no_show: 0, not_recorded: 0 };
        if (["held", "no_show", "not_recorded"].includes(status)) day[status] = Number(day[status]) + 1;
        callDays.set(dayKey, day);
      }
      const paid = new Map<string, number>();
      for (const p of eligible.filter(p => p.meetingId === m._id)) paid.set(p.currency, (paid.get(p.currency) ?? 0) + p.amountMinor);
      return { closer, meeting_id: m._id, opportunity_id: m.opportunityId, scheduled_at_ms: m.scheduledAt,
        lead_name: m.leadName ?? people.find(p => p._id === deal?.leadId)?.fullName ?? "Unknown person",
        program_name: m.bookingProgramName ?? "Unknown program", call_status: status, call_type: type,
        deal_outcome: deal?.outcome ?? null, paid_minor: [...paid.entries()] };
    });
    const cash = new Map<string, SqlRow>();
    const cashDays = new Map<string, SqlRow>();
    for (const p of payments) {
      const closer = p.attributedCloserId ?? "";
      const key = JSON.stringify([closer, p.currency]);
      const row = cash.get(key) ?? { closer_id: closer, currency: p.currency, cash_minor: 0, final_minor: 0, payments: 0, won_deal_ids: [] };
      row.cash_minor = Number(row.cash_minor) + p.amountMinor;
      row.final_minor = Number(row.final_minor) + (p.paymentType === "deposit" ? 0 : p.amountMinor);
      row.payments = Number(row.payments) + 1;
      if (p.opportunityId && firstPayments.get(p.opportunityId)?._id === p._id) (row.won_deal_ids as string[]).push(p.opportunityId);
      cash.set(key, row);
      if (memberId && p.attributedCloserId && memberUsers.has(p.attributedCloserId)) {
        const dayKey = businessDateForInstant(p.recordedAt, range), key = JSON.stringify([dayKey, p.currency]);
        const row = cashDays.get(key) ?? { day_key: dayKey, currency: p.currency, cash_minor: 0 };
        row.cash_minor = Number(row.cash_minor) + p.amountMinor; cashDays.set(key, row);
      }
    }
    rows.totals = [...totals.values()]; rows.cash = [...cash.values()]; rows.cohort = [...cohort.values()];
    rows.firstPaymentDeals = [...firstPayments.entries()].filter(([id, p]) => p.recordedAt >= from && p.recordedAt < to &&
      (!memberId || allPayments.some(other => other.opportunityId === id && other.attributedCloserId && memberUsers.has(other.attributedCloserId))))
      .map(([id]) => ({ opportunity_id: id }));
    rows.callDays = [...callDays.values()]; rows.cashDays = [...cashDays.values()];
    rows.calls = memberId ? facts.filter(f => memberUsers.has(f.closer)).sort((a, b) => b.scheduled_at_ms - a.scheduled_at_ms || a.meeting_id.localeCompare(b.meeting_id))
      .slice(0, 301).map(({ closer, ...r }) => { void closer; return r; }) : [];
    return rows;
  });
}
