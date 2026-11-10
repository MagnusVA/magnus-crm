import type { TestConvex } from "convex-test";
import type schema from "../convex/schema";
import type { Id } from "../convex/_generated/dataModel";
import type { SqlRow } from "../convex/analytics/clickhouse";
import type { ResolvedAnalyticsRange } from "../lib/analyticsRange";
import { businessDateForInstant } from "../lib/businessDay";
import { attributionIdentity, loadCreditDimensions, loadCreditFacts, memberIdentity, paymentCreditResolver, inRange, type PeopleRole } from "../convex/reports/lib/creditFacts";

/** Models the aggregate SQL's output, independently of the Node mapper and
 * finish. This does not execute SQL. Cash uses the existing resolver as oracle. */
export async function roleAggregateRows(t: TestConvex<typeof schema>, tenantId: Id<"tenants">, role: PeopleRole,
  memberId: Id<"teamMembers"> | null, range: ResolvedAnalyticsRange, now: number) {
  return t.run(async ctx => {
    const dimensions = await loadCreditDimensions(ctx, tenantId);
    const facts = await loadCreditFacts(ctx, tenantId, range, role);
    const rows: Record<string, SqlRow[]> = { deals: [], cash: [], wins: [], firstPaymentDeals: [], activity: [], days: [], cashDays: [], items: [] };
    const key = (id?: Id<"teamMembers">) => memberIdentity(dimensions, id).key;
    const worker = (id: Id<"leadGenWorkers">) => key(dimensions.workers.find(w => w._id === id)?.teamMemberId);
    const creditKey = (c: typeof facts.attributions[number]) => attributionIdentity(dimensions, c).key;
    const own = (identity: string) => memberId !== null && identity === memberId;
    const grouped = (name: string, identity: string, discriminator = "") => {
      let found = rows[name].find(r => r.identity_key === identity && (r.discriminator ?? "") === discriminator);
      if (!found) { found = { identity_key: identity, ...(discriminator ? { discriminator } : {}) }; rows[name].push(found); }
      return found;
    };
    const add = (r: SqlRow, column: string, value = 1) => { r[column] = Number(r[column] ?? 0) + value; };
    const set = (r: SqlRow, column: string, value: string) => {
      const list = (r[column] ?? []) as string[];
      if (!list.includes(value)) list.push(value);
      r[column] = list;
    };
    const activityDay = (at: number, kind: string) => {
      const dayKey = businessDateForInstant(at, range);
      let row = rows.days.find(r => r.day_key === dayKey);
      if (!row) { row = { day_key: dayKey }; rows.days.push(row); }
      add(row, kind);
    };
    const eligibleCredits = facts.attributions.filter(c => c.role === role || role === "dm_closer" && c.role === "dm_team");
    for (const c of eligibleCredits) {
      if (!inRange(c.attributedAt, range) || c.role === "dm_team" && (!c.meetingId || eligibleCredits.some(n => n.role === "dm_closer" && n.meetingId === c.meetingId))) continue;
      const r = grouped("deals", creditKey(c));
      set(r, "deal_ids", c.opportunityId);
      if (c.source.kind === "capture") set(r, "capture_deal_ids", c.opportunityId);
      if (c.source.kind === "respark") set(r, "respark_deal_ids", c.opportunityId);
      if (role === "setter") {
        const d = facts.deals.find(d => d._id === c.opportunityId);
        const meetings = facts.meetings.filter(m => m.opportunityId === c.opportunityId);
        if (d?.firstBookedAt !== undefined || meetings.length) set(r, "booked_deal_ids", c.opportunityId);
        if (meetings.some(m => m.status === "held")) set(r, "held_deal_ids", c.opportunityId);
        if (d?.outcome === "won") set(r, "won_deal_ids", c.opportunityId);
      }
    }
    const resolve = paymentCreditResolver(dimensions, facts.attributions);
    for (const p of facts.payments) {
      if (p.status === "disputed" || !inRange(p.recordedAt, range)) continue;
      const named = resolve(p, role);
      const recipients = role === "dm_closer" && !named.length ? resolve(p, "dm_team") : named;
      for (const who of recipients) {
        const r = grouped("cash", who.key, p.currency); r.currency = p.currency; add(r, "amount_minor", p.amountMinor);
        if (role !== "setter" && facts.firstPayments.some(f => f._id === p._id) && p.opportunityId) set(grouped("wins", who.key), "won_deal_ids", p.opportunityId);
        if (own(who.key)) {
          const dayKey = businessDateForInstant(p.recordedAt, range);
          let r = rows.cashDays.find(r => r.day_key === dayKey && r.currency === p.currency);
          if (!r) { r = { day_key: dayKey, currency: p.currency }; rows.cashDays.push(r); }
          add(r, "amount_minor", p.amountMinor);
        }
      }
    }
    for (const p of facts.firstPayments) if (role !== "setter" && p.status !== "disputed" && inRange(p.recordedAt, range) && p.opportunityId &&
      (!memberId || eligibleCredits.some(c => c.opportunityId === p.opportunityId && creditKey(c) === memberId))) rows.firstPaymentDeals.push({ opportunity_id: p.opportunityId });
    if (role === "lead_gen") {
      for (const c of facts.captures) {
        if (c.voidedAt !== undefined || !inRange(c.submittedAt, range)) continue;
        const identity = worker(c.workerId), r = grouped("activity", identity);
        add(r, "captures");
        const prospect = facts.prospects.find(p => p._id === c.prospectId);
        if (prospect?.leadId) set(r, "person_ids", prospect.leadId);
        if (own(identity)) {
          activityDay(c.submittedAt, "captures");
          rows.items.push({ id: c._id, at_ms: c.submittedAt, person_name: facts.people.find(p => p._id === prospect?.leadId)?.fullName ?? "Unknown person",
            lead_id: prospect?.leadId ?? null, opportunity_id: null, result: c.source, outcome: null, scheduled_at_ms: null });
        }
      }
      for (const r of facts.resparks) if (r.result === "resparked" && r.workedAt !== undefined && inRange(r.workedAt, range)) {
        const identity = worker(r.workerId); add(grouped("activity", identity), "resparks");
        if (own(identity)) activityDay(r.workedAt, "resparks");
      }
    }
    if (role === "setter") for (const q of facts.qualifications) {
      if (!inRange(q.submittedAt, range)) continue;
      const identity = key(dimensions.slackUsers.find(u => u.slackUserId === q.slackUserId && u.slackTeamId === q.slackTeamId)?.teamMemberId);
      const r = grouped("activity", identity, q.resultKind); r.result_kind = q.resultKind; add(r, "qualifications");
      if (own(identity)) {
        activityDay(q.submittedAt, "qualifications");
        rows.items.push({ id: q._id, at_ms: q.submittedAt, person_name: q.fullNameSnapshot, lead_id: q.leadId ?? null,
          opportunity_id: q.opportunityId ?? null, result: q.resultKind, outcome: facts.deals.find(d => d._id === q.opportunityId)?.outcome ?? null, scheduled_at_ms: null });
      }
    }
    if (role === "dm_closer") for (const m of facts.meetings) {
      if (!inRange(m.createdAt, range) || m.rescheduledFromMeetingId !== undefined) continue;
      const credits = eligibleCredits.filter(c => c.meetingId === m._id);
      const named = credits.filter(c => c.role === "dm_closer");
      for (const identity of new Set((named.length ? named : credits.filter(c => c.role === "dm_team")).map(creditKey))) {
        const r = grouped("activity", identity); add(r, "bookings");
        if (m.status === "held") add(r, "held");
        if (m.status === "no_show") add(r, "no_show");
        if (m.status === "scheduled" && m.scheduledAt + m.durationMinutes * 60000 <= now) add(r, "not_recorded");
        if (own(identity)) {
          activityDay(m.createdAt, "bookings");
          const deal = facts.deals.find(d => d._id === m.opportunityId);
          rows.items.push({ id: m._id, at_ms: m.createdAt, person_name: facts.people.find(p => p._id === deal?.leadId)?.fullName ?? m.leadName ?? "Unknown person",
            lead_id: deal?.leadId ?? null, opportunity_id: m.opportunityId, result: m.status, outcome: deal?.outcome ?? null, scheduled_at_ms: m.scheduledAt });
        }
      }
    }
    rows.items.sort((a, b) => Number(b.at_ms) - Number(a.at_ms) || String(a.id).localeCompare(String(b.id)));
    rows.items = rows.items.slice(0, 300);
    return rows;
  });
}
