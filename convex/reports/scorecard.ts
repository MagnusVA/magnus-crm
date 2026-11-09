import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query, type QueryCtx } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { isReplacement } from "../lib/callType";
import { REPORT_ADMIN_ROLES } from "./lib/access";
import {
  assertScorecardRange, buildLifecycle, emptyLifecycle, inRange, loadAnswers, loadLifecycle,
  loadReminders, loadScorecardFacts, privateAnswer, scorecardRangeValidator,
  type AnswerFacts, type LifecycleCounts, type ScorecardFacts, type ScorecardFilters,
} from "./lib/scorecardFacts";
import type { ResolvedAnalyticsRange } from "../../lib/analyticsRange";
import { addBusinessDays, businessDateForInstant, businessDayRange } from "../../lib/businessDay";

export type CashAmounts = { currency: string; cashMinor: number; finalMinor: number };
export type ActivityCounts = { bookingsMade: number; callsHeld: number; dealsWon: number };
export type FunnelOutput = LifecycleCounts & {
  activity: ActivityCounts & { cash: CashAmounts[] };
  byDay: Array<ActivityCounts & { dayKey: string; cash: CashAmounts[] }>;
};
export type CashProgram = {
  programId: Id<"tenantPrograms">; name: string; cashMinor: number; finalMinor: number;
  payments: number; dealsWon: number; finalOnWonDealsMinor: number;
};
export type CashOutput = { currencies: Array<CashAmounts & {
  depositMinor: number; byType: { pif: number; split: number; monthly: number; deposit: number };
  byProgram: CashProgram[]; depositsOnLostDeals: number; finalOnWonDealsMinor: number; dealsWon: number;
}> };
export type TaskCounts = { due: number; onTime: number; late: number; openOverdue: number };
export type FollowThroughOutput = TaskCounts & { byCloser: Array<TaskCounts & { userId: Id<"users">; name: string }> };
export type OriginsOutput = { origins: Array<{ channel: string; dealsWon: number; cash: CashAmounts[] }> };
export type AnswersOutput = { fieldKey: string; label: string; answers: Array<{ answer: string; people: number; held: number; won: number }> };

export function cashAmounts(payments: readonly Doc<"paymentRecords">[]): CashAmounts[] {
  const currencies = new Map<string, CashAmounts>();
  for (const p of payments) {
    if (p.status === "disputed") continue;
    const row = currencies.get(p.currency) ?? { currency: p.currency, cashMinor: 0, finalMinor: 0 };
    row.cashMinor += p.amountMinor;
    if (p.paymentType !== "deposit") row.finalMinor += p.amountMinor;
    currencies.set(p.currency, row);
  }
  return [...currencies.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}
function selectedPayments(facts: ScorecardFacts, range: ResolvedAnalyticsRange, filters: ScorecardFilters) {
  return facts.payments.filter(p => p.status !== "disputed" && inRange(p.recordedAt, range) && (!filters.programId || p.programId === filters.programId));
}
function winners(facts: ScorecardFacts, range: ResolvedAnalyticsRange, filters: ScorecardFilters) {
  return [...new Map(facts.deals.filter(d => inRange(d.paymentReceivedAt, range) &&
    (!filters.programId || d.firstBookingProgramId === filters.programId)).map(d => [d._id, d])).values()];
}
export function buildFunnel(facts: ScorecardFacts, range: ResolvedAnalyticsRange, filters: ScorecardFilters, lifecycle: LifecycleCounts = emptyLifecycle()): FunnelOutput {
  const payments = selectedPayments(facts, range, filters);
  const meetings = [...new Map(facts.meetings.filter(m => !filters.programId || m.bookingProgramId === filters.programId).map(m => [m._id, m])).values()];
  const won = winners(facts, range, filters);
  // Each item's day is worked out once: the time zone conversion is slow, and
  // a year has hundreds of days and thousands of meetings.
  const days = new Map<string, Omit<FunnelOutput["byDay"][number], "cash"> & { payments: Doc<"paymentRecords">[] }>();
  for (let dayKey = range.startDate; dayKey <= range.endDateInclusive; dayKey = addBusinessDays(dayKey, 1)) {
    days.set(dayKey, { dayKey, bookingsMade: 0, callsHeld: 0, dealsWon: 0, payments: [] });
  }
  const day = (at: number) => days.get(businessDateForInstant(at, range));
  for (const m of meetings) {
    if (inRange(m.createdAt, range) && !isReplacement(m)) { const found = day(m.createdAt); if (found) found.bookingsMade++; }
    if (m.status === "held" && inRange(m.scheduledAt, range)) { const found = day(m.scheduledAt); if (found) found.callsHeld++; }
  }
  for (const d of won) { const found = day(d.paymentReceivedAt!); if (found) found.dealsWon++; }
  for (const p of payments) day(p.recordedAt)?.payments.push(p);
  const byDay: FunnelOutput["byDay"] = [...days.values()].map(({ payments: onDay, ...counts }) => ({ ...counts, cash: cashAmounts(onDay) }));
  return { ...lifecycle, activity: {
    bookingsMade: byDay.reduce((sum, d) => sum + d.bookingsMade, 0),
    callsHeld: byDay.reduce((sum, d) => sum + d.callsHeld, 0), dealsWon: won.length, cash: cashAmounts(payments),
  }, byDay };
}

export function buildCash(facts: ScorecardFacts, range: ResolvedAnalyticsRange, filters: ScorecardFilters, programNames: ReadonlyMap<string, string> = new Map()): CashOutput {
  const payments = selectedPayments(facts, range, filters);
  const deals = new Map(facts.deals.map(d => [d._id, d]));
  const firstPayments = new Map<string, Doc<"paymentRecords">>();
  for (const p of facts.payments) {
    if (p.status === "disputed" || !p.opportunityId || deals.get(p.opportunityId)?.paymentReceivedAt !== p.recordedAt) continue;
    const previous = firstPayments.get(p.opportunityId);
    if (!previous || p._creationTime < previous._creationTime ||
      (p._creationTime === previous._creationTime && p._id.localeCompare(previous._id) < 0)) firstPayments.set(p.opportunityId, p);
  }
  const result: CashOutput = { currencies: [] };
  for (const amounts of cashAmounts(payments)) {
    const rows = payments.filter(p => p.currency === amounts.currency);
    const byType = { pif: 0, split: 0, monthly: 0, deposit: 0 };
    const programs = new Map<Id<"tenantPrograms">, CashProgram>();
    const won = new Set<string>();
    let depositsOnLostDeals = 0;
    let finalOnWonDealsMinor = 0;
    for (const p of rows) {
      const deal = p.opportunityId ? deals.get(p.opportunityId) : undefined;
      const final = p.paymentType !== "deposit";
      byType[p.paymentType] += p.amountMinor;
      const program = programs.get(p.programId) ?? { programId: p.programId, name: programNames.get(p.programId) ?? p.programName,
        cashMinor: 0, finalMinor: 0, payments: 0, dealsWon: 0, finalOnWonDealsMinor: 0 };
      program.cashMinor += p.amountMinor;
      program.finalMinor += final ? p.amountMinor : 0;
      program.payments++;
      // Current won deals' final payments in range: additive even when a later
      // installment lands in a different window from the first payment.
      if (deal?.outcome === "won" && final) {
        program.finalOnWonDealsMinor += p.amountMinor;
        finalOnWonDealsMinor += p.amountMinor;
      }
      if (deal?.outcome === "lost" && !final) depositsOnLostDeals += p.amountMinor;
      // Attribute the win to its first payment's currency and sold program.
      // An equal-time tie is resolved by creation time and id below.
      if (deal && deal.paymentReceivedAt === p.recordedAt && !won.has(deal._id)) {
        if (firstPayments.get(deal._id)?._id === p._id) { won.add(deal._id); program.dealsWon++; }
      }
      programs.set(p.programId, program);
    }
    result.currencies.push({ ...amounts, depositMinor: amounts.cashMinor - amounts.finalMinor, byType,
      byProgram: [...programs.values()].sort((a, b) => a.programId.localeCompare(b.programId)),
      depositsOnLostDeals, finalOnWonDealsMinor, dealsWon: won.size });
  }
  return result;
}
export function buildFollowThrough(reminders: readonly Doc<"followUps">[], users: readonly Doc<"users">[], range: ResolvedAnalyticsRange, now: number): FollowThroughOutput {
  const zero = (): TaskCounts => ({ due: 0, onTime: 0, late: 0, openOverdue: 0 });
  const result: FollowThroughOutput = { ...zero(), byCloser: [] };
  const names = new Map(users.map(u => [u._id, u.fullName ?? "Unknown"]));
  const closers = new Map<Id<"users">, FollowThroughOutput["byCloser"][number]>();
  for (const r of reminders) {
    if (r.type !== "manual_reminder" || !inRange(r.reminderScheduledAt, range)) continue;
    const end = businessDayRange(businessDateForInstant(r.reminderScheduledAt!, range), range).end;
    const counts: TaskCounts = { due: 1, onTime: 0, late: 0, openOverdue: 0 };
    if (r.completedAt !== undefined) counts[r.completedAt < end ? "onTime" : "late"]++;
    else if (now > r.reminderScheduledAt!) counts.openOverdue++;
    const closer = closers.get(r.closerId) ?? { userId: r.closerId, name: names.get(r.closerId) ?? "Unknown", ...zero() };
    for (const key of ["due", "onTime", "late", "openOverdue"] as const) { result[key] += counts[key]; closer[key] += counts[key]; }
    closers.set(r.closerId, closer);
  }
  result.byCloser = [...closers.values()].sort((a, b) => a.userId.localeCompare(b.userId));
  return result;
}
export function buildOrigins(facts: ScorecardFacts, range: ResolvedAnalyticsRange, filters: ScorecardFilters): OriginsOutput {
  const deals = new Map(facts.deals.map(d => [d._id, d]));
  const channels = new Map<string, { dealsWon: number; payments: Doc<"paymentRecords">[] }>();
  const group = (channel: string) => {
    let row = channels.get(channel);
    if (!row) { row = { dealsWon: 0, payments: [] }; channels.set(channel, row); }
    return row;
  };
  for (const deal of winners(facts, range, filters)) group(deal.firstTouch?.channel ?? "unknown").dealsWon++;
  for (const payment of selectedPayments(facts, range, filters)) {
    const deal = payment.opportunityId ? deals.get(payment.opportunityId) : undefined;
    group(deal?.firstTouch?.channel ?? "unknown").payments.push(payment);
  }
  return { origins: [...channels.entries()].map(([channel, row]) => ({ channel, dealsWon: row.dealsWon, cash: cashAmounts(row.payments) }))
    .sort((a, b) => a.channel.localeCompare(b.channel)) };
}
export function buildAnswers(facts: AnswerFacts, fieldKey: string, label = fieldKey): AnswersOutput {
  const groups = new Map<string, Set<string>>();
  for (const response of facts.responses) {
    if (response.fieldKey !== fieldKey) continue;
    const answer = privateAnswer(response.answerText, response.questionLabelSnapshot, facts.contactLabels);
    if (!answer) continue;
    const people = groups.get(answer) ?? new Set<string>(); people.add(response.leadId); groups.set(answer, people);
  }
  const held = new Set(facts.heldDealIds);
  return { fieldKey, label, answers: [...groups.entries()].map(([answer, people]) => {
    const deals = facts.deals.filter(d => people.has(d.leadId));
    return { answer, people: people.size, held: new Set(deals.filter(d => held.has(d._id)).map(d => d._id)).size,
      won: new Set(deals.filter(d => d.outcome === "won").map(d => d._id)).size };
  }).sort((a, b) => b.people - a.people || a.answer.localeCompare(b.answer)) };
}
export function normalizeFieldKey(fieldKey: string) {
  const key = fieldKey.trim(); if (!key || key.length > 500) throw new Error("Choose a form field."); return key;
}
export async function answerLabel(ctx: QueryCtx, tenantId: Id<"tenants">, fieldKey: string) {
  const fields = await ctx.db.query("eventTypeFieldCatalog").withIndex("by_tenantId_and_fieldKey", q => q.eq("tenantId", tenantId).eq("fieldKey", fieldKey)).take(201);
  if (fields.length > 200) throw new Error("Choose a shorter range");
  return fields.sort((a, b) => b.lastSeenAt - a.lastSeenAt || a._id.localeCompare(b._id))[0]?.currentLabel ?? fieldKey;
}
const cashValidator = v.object({ currency: v.string(), cashMinor: v.number(), finalMinor: v.number() });
const activityValidator = { bookingsMade: v.number(), callsHeld: v.number(), dealsWon: v.number() };
const taskValidator = { due: v.number(), onTime: v.number(), late: v.number(), openOverdue: v.number() };
const funnelValidator = v.object({
  stages: v.object({ prospect: v.number(), in_conversation: v.number(), qualified: v.number(), booked: v.number(), showed: v.number(), customer: v.number() }),
  cohort: v.object({ entered: v.number(), qualified: v.number(), booked: v.number(), showed: v.number(), customer: v.number() }),
  activity: v.object({ ...activityValidator, cash: v.array(cashValidator) }),
  byDay: v.array(v.object({ ...activityValidator, dayKey: v.string(), cash: v.array(cashValidator) })),
});
const cashOutputValidator = v.object({ currencies: v.array(v.object({
  currency: v.string(), cashMinor: v.number(), finalMinor: v.number(), depositMinor: v.number(),
  byType: v.object({ pif: v.number(), split: v.number(), monthly: v.number(), deposit: v.number() }),
  byProgram: v.array(v.object({ programId: v.id("tenantPrograms"), name: v.string(), cashMinor: v.number(), finalMinor: v.number(),
    payments: v.number(), dealsWon: v.number(), finalOnWonDealsMinor: v.number() })),
  depositsOnLostDeals: v.number(), finalOnWonDealsMinor: v.number(), dealsWon: v.number(),
})) });
const followThroughValidator = v.object({ ...taskValidator,
  byCloser: v.array(v.object({ ...taskValidator, userId: v.id("users"), name: v.string() })),
});
const originsValidator = v.object({ origins: v.array(v.object({ channel: v.string(), dealsWon: v.number(), cash: v.array(cashValidator) })) });
const answersValidator = v.object({ fieldKey: v.string(), label: v.string(),
  answers: v.array(v.object({ answer: v.string(), people: v.number(), held: v.number(), won: v.number() })),
});
const args = { range: scorecardRangeValidator, programId: v.optional(v.id("tenantPrograms")) };
export const funnel = query({ args, returns: funnelValidator, handler: async (ctx, args): Promise<FunnelOutput> => {
  const { tenantId } = await requireTenantUser(ctx, [...REPORT_ADMIN_ROLES]);
  await assertScorecardRange(ctx, tenantId, args.range);
  return buildFunnel(await loadScorecardFacts(ctx, tenantId, args.range, true), args.range, args, await loadLifecycle(ctx, tenantId, args.range));
} });
export const cash = query({ args, returns: cashOutputValidator, handler: async (ctx, args): Promise<CashOutput> => {
  const { tenantId } = await requireTenantUser(ctx, [...REPORT_ADMIN_ROLES]);
  await assertScorecardRange(ctx, tenantId, args.range);
  const facts = await loadScorecardFacts(ctx, tenantId, args.range, false);
  const names = new Map<string, string>();
  for (const id of new Set(facts.payments.map(p => p.programId))) {
    const program = await ctx.db.get("tenantPrograms", id); if (program?.tenantId === tenantId) names.set(id, program.name);
  }
  return buildCash(facts, args.range, args, names);
} });
export const followThrough = query({ args, returns: followThroughValidator, handler: async (ctx, args): Promise<FollowThroughOutput> => {
  const { tenantId } = await requireTenantUser(ctx, [...REPORT_ADMIN_ROLES]);
  await assertScorecardRange(ctx, tenantId, args.range);
  const { reminders, users } = await loadReminders(ctx, tenantId, args.range);
  const deals = new Map<string, Doc<"opportunities"> | null>();
  if (args.programId) for (const r of reminders) if (!deals.has(r.opportunityId)) deals.set(r.opportunityId, await ctx.db.get("opportunities", r.opportunityId));
  return buildFollowThrough(reminders.filter(r => !args.programId || deals.get(r.opportunityId)?.firstBookingProgramId === args.programId), users, args.range, Date.now());
} });
export const origins = query({ args, returns: originsValidator, handler: async (ctx, args): Promise<OriginsOutput> => {
  const { tenantId } = await requireTenantUser(ctx, [...REPORT_ADMIN_ROLES]);
  await assertScorecardRange(ctx, tenantId, args.range);
  return buildOrigins(await loadScorecardFacts(ctx, tenantId, args.range, false), args.range, args);
} });
export const answers = query({ args: { ...args, fieldKey: v.string() }, returns: answersValidator, handler: async (ctx, args): Promise<AnswersOutput> => {
  const { tenantId } = await requireTenantUser(ctx, [...REPORT_ADMIN_ROLES]);
  await assertScorecardRange(ctx, tenantId, args.range); const key = normalizeFieldKey(args.fieldKey);
  return buildAnswers(await loadAnswers(ctx, tenantId, args.range, args, key), key, await answerLabel(ctx, tenantId, key));
} });

// Export the pure lifecycle builder beside the other builders for parity fixtures.
export { buildLifecycle };
