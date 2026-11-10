import type { ReaderArgs } from "../analytics/assistantTypes";
import { v, type Infer } from "convex/values";
import { query, type QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { dealAttributionRoleValidator } from "../lib/attribution/validators";
import { isMovedSlot, isReplacement } from "../lib/callType";
import { createLiveReadState, readLiveDocuments, readLiveQueryRows } from "../lib/liveQueryBounds";
import { requireTenantUser } from "../requireTenantUser";
import { REPORT_ADMIN_ROLES } from "./lib/access";
import {
  CREDIT_ROLES, addMoney, attributionIdentity, creditIdentityValidator, paymentCreditResolver,
  currencyAmountsValidator, loadCreditDimensions, loadCreditFacts, memberIdentity,
  paymentsInRange, reportRange, uniqueIds,
  type CreditDimensions, type CreditFacts, type CreditIdentity, type CurrencyAmount,
} from "./lib/creditFacts";
import type { ResolvedAnalyticsRange } from "../../lib/analyticsRange";

const personValidator = v.object({ ...creditIdentityValidator.fields, dealIds: v.array(v.string()), byCurrency: currencyAmountsValidator });
const laneMoney = v.array(v.object({ currency: v.string(), laneMinor: v.number(), sharedMinor: v.number(), coverage: v.union(v.number(), v.null()) }));
const uncreditedMoney = v.array(v.object({ currency: v.string(), amountMinor: v.number() }));
export const attributionLanesValidator = v.object({
  currencies: v.array(v.string()),
  totals: v.array(v.object({ currency: v.string(), cashMinor: v.number(), finalMinor: v.number(), payments: v.number() })),
  lanes: v.array(v.object({ role: dealAttributionRoleValidator, byCurrency: laneMoney,
    dealIds: v.array(v.string()), people: v.array(personValidator) })),
  uncreditedByRole: v.array(v.object({ role: dealAttributionRoleValidator, byCurrency: uncreditedMoney })),
  isTruncated: v.boolean(),
});
export type AttributionLanes = Infer<typeof attributionLanesValidator>;
export const attributionPathsValidator = v.object({
  paths: v.array(v.object({ key: v.string(), roles: v.array(dealAttributionRoleValidator),
    dealIds: v.array(v.string()), byCurrency: currencyAmountsValidator })), isTruncated: v.boolean(),
});
export type AttributionPaths = Infer<typeof attributionPathsValidator>;

export function buildAttributionLanes(dimensions: CreditDimensions, facts: CreditFacts, range: ResolvedAnalyticsRange): AttributionLanes {
  const payments = paymentsInRange(facts, range);
  const creditsForPayment = paymentCreditResolver(dimensions, facts.attributions);
  const totals: AttributionLanes["totals"] = [];
  for (const payment of payments) {
    let total = totals.find(total => total.currency === payment.currency);
    if (!total) { total = { currency: payment.currency, cashMinor: 0, finalMinor: 0, payments: 0 }; totals.push(total); }
    total.cashMinor += payment.amountMinor;
    if (payment.paymentType !== "deposit") total.finalMinor += payment.amountMinor;
    total.payments++;
  }
  totals.sort((a, b) => a.currency.localeCompare(b.currency));
  const lanes = CREDIT_ROLES.map(role => {
    const people = new Map<string, CreditIdentity & { dealIds: string[]; byCurrency: CurrencyAmount[] }>();
    const lane: AttributionLanes["lanes"][number] = { role, byCurrency: totals.map(total =>
      ({ currency: total.currency, laneMinor: 0, sharedMinor: 0, coverage: total.cashMinor === 0 ? null : 0 })), dealIds: [], people: [] };
    for (const payment of payments) {
      const credited = creditsForPayment(payment, role);
      if (credited.length === 0) continue;
      const money = lane.byCurrency.find(money => money.currency === payment.currency)!;
      money.laneMinor += payment.amountMinor;
      money.sharedMinor += (credited.length - 1) * payment.amountMinor;
      if (payment.opportunityId) lane.dealIds.push(payment.opportunityId);
      for (const identity of credited) {
        const person = people.get(identity.key) ?? { ...identity, dealIds: [], byCurrency: [] };
        if (payment.opportunityId) person.dealIds.push(payment.opportunityId);
        addMoney(person.byCurrency, payment.currency, payment.amountMinor);
        people.set(identity.key, person);
      }
    }
    lane.dealIds = uniqueIds(lane.dealIds);
    for (const money of lane.byCurrency) {
      const total = totals.find(total => total.currency === money.currency)!.cashMinor;
      money.coverage = total !== 0 ? money.laneMinor / total : null;
    }
    lane.people = [...people.values()].map(person => ({ ...person, dealIds: uniqueIds(person.dealIds) }))
      .sort((a, b) => a.key.localeCompare(b.key));
    return lane;
  });
  return { currencies: totals.map(total => total.currency), totals, lanes,
    uncreditedByRole: lanes.map(lane => ({ role: lane.role, byCurrency: totals.map(total => ({
      currency: total.currency, amountMinor: total.cashMinor - lane.byCurrency.find(money => money.currency === total.currency)!.laneMinor,
    })) })), isTruncated: facts.isTruncated };
}

export function buildAttributionPaths(dimensions: CreditDimensions, facts: CreditFacts, range: ResolvedAnalyticsRange): AttributionPaths {
  const paths = new Map<string, AttributionPaths["paths"][number]>();
  const creditsForPayment = paymentCreditResolver(dimensions, facts.attributions);
  for (const payment of paymentsInRange(facts, range)) {
    if (!payment.opportunityId) continue;
    const roles = CREDIT_ROLES.filter(role => creditsForPayment(payment, role).length > 0);
    const key = roles.join("+");
    const path = paths.get(key) ?? { key, roles, dealIds: [], byCurrency: [] };
    path.dealIds.push(payment.opportunityId);
    addMoney(path.byCurrency, payment.currency, payment.amountMinor);
    paths.set(key, path);
  }
  return { paths: [...paths.values()].map(path => ({ ...path, dealIds: uniqueIds(path.dealIds) }))
    .sort((a, b) => a.key.localeCompare(b.key)), isTruncated: facts.isTruncated };
}

const rangeArgs = { startDate: v.number(), endDate: v.number() };
export const getLanes = query({
  args: rangeArgs, returns: attributionLanesValidator,
  handler: async (ctx, args): Promise<AttributionLanes> => {
    const { tenantId } = await requireTenantUser(ctx, [...REPORT_ADMIN_ROLES]);
    return readLanes(ctx, tenantId, args);
  },
});
export const getPaths = query({
  args: rangeArgs, returns: attributionPathsValidator,
  handler: async (ctx, args): Promise<AttributionPaths> => {
    const { tenantId } = await requireTenantUser(ctx, [...REPORT_ADMIN_ROLES]);
    return readPaths(ctx, tenantId, args);
  },
});

export const dealChainValidator = v.object({
  opportunityId: v.id("opportunities"), stage: v.string(), outcome: v.string(), personName: v.string(),
  credits: v.array(v.object({ id: v.id("dealAttributions"), role: dealAttributionRoleValidator,
    ...creditIdentityValidator.fields, sourceKind: v.string(), attributedAt: v.number(), meetingId: v.union(v.id("meetings"), v.null()),
    creditedFor: currencyAmountsValidator })),
  meetings: v.array(v.object({ id: v.id("meetings"), scheduledAt: v.number(), status: v.string(),
    closer: creditIdentityValidator, moved: v.boolean(), rebooked: v.boolean(), replacesMeetingId: v.union(v.id("meetings"), v.null()) })),
  payments: v.array(v.object({ id: v.id("paymentRecords"), amountMinor: v.number(), currency: v.string(),
    type: v.string(), status: v.string(), closer: v.union(creditIdentityValidator, v.null()), recordedAt: v.number() })),
  isTruncated: v.boolean(),
});
export type DealChain = Infer<typeof dealChainValidator>;

export function buildDealChain(dimensions: CreditDimensions, facts: CreditFacts, deal: Doc<"opportunities">, personName: string): DealChain {
  const payments = facts.payments.filter(payment => payment.opportunityId === deal._id);
  const currencies = uniqueIds(payments.map(payment => payment.currency));
  const credits = facts.attributions.filter(row => row.opportunityId === deal._id);
  const creditsForPayment = paymentCreditResolver(dimensions, credits);
  return {
    opportunityId: deal._id, stage: deal.stage, outcome: deal.outcome, personName,
    credits: [...credits].sort((a, b) => a.attributedAt - b.attributedAt || a._id.localeCompare(b._id)).map(row => {
      const identity = attributionIdentity(dimensions, row);
      const creditedFor = currencies.map(currency => ({ currency, amountMinor: 0 }));
      for (const payment of payments) {
        if (payment.status !== "disputed" && creditsForPayment(payment, row.role).some(person => person.key === identity.key)) {
          addMoney(creditedFor, payment.currency, payment.amountMinor);
        }
      }
      return { id: row._id, role: row.role, ...identity, sourceKind: row.source.kind,
        attributedAt: row.attributedAt, meetingId: row.meetingId ?? null, creditedFor };
    }),
    meetings: facts.meetings.filter(meeting => meeting.opportunityId === deal._id)
      .sort((a, b) => a.scheduledAt - b.scheduledAt || a._id.localeCompare(b._id)).map(meeting => {
        const latest = credits.filter(row => row.role === "closer" && row.meetingId === meeting._id)
          .sort((a, b) => b.attributedAt - a.attributedAt || b._creationTime - a._creationTime || b._id.localeCompare(a._id))[0];
        const user = dimensions.users.find(user => user._id === meeting.assignedCloserId);
        const previous = facts.meetings.find(row => row._id === meeting.rescheduledFromMeetingId);
        const successor = facts.meetings.find(row => row.rescheduledFromMeetingId === meeting._id) ?? null;
        return { id: meeting._id, scheduledAt: meeting.scheduledAt, status: meeting.status,
          closer: latest ? attributionIdentity(dimensions, latest) : memberIdentity(dimensions, user?.teamMemberId),
          moved: isMovedSlot(meeting, successor), rebooked: isReplacement(meeting) && previous?.status === "no_show",
          replacesMeetingId: meeting.rescheduledFromMeetingId ?? null };
      }),
    payments: [...payments].sort((a, b) => a.recordedAt - b.recordedAt || a._id.localeCompare(b._id)).map(payment => ({
      id: payment._id, amountMinor: payment.amountMinor, currency: payment.currency, type: payment.paymentType,
      status: payment.status, closer: payment.attributedCloserId ? memberIdentity(dimensions,
        dimensions.users.find(user => user._id === payment.attributedCloserId)?.teamMemberId) : null,
      recordedAt: payment.recordedAt,
    })), isTruncated: facts.isTruncated,
  };
}

/** The most deals one call names. A page lists far fewer, since only paid deals appear. */
export const MAX_DEAL_NAMES = 500;

/**
 * The person each deal belongs to, for the deal buttons on Attribution.
 * Deals of another tenant, or deleted ones, are left out.
 */
export const getDealNames = query({
  args: { opportunityIds: v.array(v.id("opportunities")) },
  returns: v.array(v.object({ opportunityId: v.id("opportunities"), name: v.string() })),
  handler: async (ctx, { opportunityIds }) => {
    const { tenantId } = await requireTenantUser(ctx, [...REPORT_ADMIN_ROLES]);
    const ids = [...new Set(opportunityIds)].slice(0, MAX_DEAL_NAMES);
    const names = await Promise.all(ids.map(async (opportunityId) => {
      const deal = await ctx.db.get("opportunities", opportunityId);
      if (!deal || deal.tenantId !== tenantId) return null;
      const person = await ctx.db.get("leads", deal.leadId);
      const name = person?.tenantId === tenantId ? person.fullName?.trim() : undefined;
      return { opportunityId, name: name || "Unknown person" };
    }));
    return names.filter((entry) => entry !== null);
  },
});

export const getDealChain = query({
  args: { opportunityId: v.id("opportunities") }, returns: dealChainValidator,
  handler: async (ctx, { opportunityId }): Promise<DealChain> => {
    const { tenantId } = await requireTenantUser(ctx, [...REPORT_ADMIN_ROLES]);
    const deal = await ctx.db.get("opportunities", opportunityId);
    if (!deal || deal.tenantId !== tenantId) throw new Error("Deal not found.");
    const [creditScan, meetingScan, paymentScan, dimensions, person] = await Promise.all([
      readLiveQueryRows(ctx.db.query("dealAttributions").withIndex("by_tenantId_and_opportunityId_and_role", q =>
        q.eq("tenantId", tenantId).eq("opportunityId", opportunityId)), 200),
      readLiveQueryRows(ctx.db.query("meetings").withIndex("by_opportunityId", q => q.eq("opportunityId", opportunityId)), 200),
      readLiveQueryRows(ctx.db.query("paymentRecords").withIndex("by_opportunityId_and_recordedAt", q => q.eq("opportunityId", opportunityId)), 1000),
      loadCreditDimensions(ctx, tenantId), ctx.db.get("leads", deal.leadId),
    ]);
    const facts: CreditFacts = { payments: paymentScan.rows.filter(p => p.tenantId === tenantId), attributions: creditScan.rows,
      meetings: meetingScan.rows.filter(m => m.tenantId === tenantId), deals: [deal], firstPayments: [], qualifications: [],
      captures: [], prospects: [], resparks: [], people: [], isTruncated: creditScan.capped || meetingScan.capped || paymentScan.capped };
    // A successor or predecessor can have moved to another deal. The chain
    // still describes this slot's reschedule history, through explicit links.
    const relatedState = createLiveReadState();
    const previousIds = facts.meetings.flatMap(meeting => meeting.rescheduledFromMeetingId ? [meeting.rescheduledFromMeetingId] : []);
    const previous = await readLiveDocuments([...new Set(previousIds)], id => ctx.db.get("meetings", id), relatedState);
    const successors = await readLiveDocuments(facts.meetings, meeting => ctx.db.query("meetings")
      .withIndex("by_rescheduledFromMeetingId", q => q.eq("rescheduledFromMeetingId", meeting._id)).first(), relatedState);
    const meetings = new Map(facts.meetings.map(meeting => [meeting._id, meeting]));
    for (const meeting of [...previous.rows, ...successors.rows]) {
      if (meeting.tenantId === tenantId) meetings.set(meeting._id, meeting);
    }
    facts.meetings = [...meetings.values()];
    facts.isTruncated ||= relatedState.capped;
    return buildDealChain(dimensions, facts, deal, person?.tenantId === tenantId ? person.fullName ?? "Unknown person" : "Unknown person");
  },
});

/** Shared load/build path. Trusted callers must authorize the tenant first. */
export async function readLanes(ctx: QueryCtx, tenantId: Id<"tenants">, args: ReaderArgs<typeof getLanes>): Promise<AttributionLanes> {
  const range = await reportRange(ctx, tenantId, args.startDate, args.endDate);
  return buildAttributionLanes(await loadCreditDimensions(ctx, tenantId), await loadCreditFacts(ctx, tenantId, range), range);
}

/** Shared load/build path. Trusted callers must authorize the tenant first. */
export async function readPaths(ctx: QueryCtx, tenantId: Id<"tenants">, args: ReaderArgs<typeof getPaths>): Promise<AttributionPaths> {
  const range = await reportRange(ctx, tenantId, args.startDate, args.endDate);
  return buildAttributionPaths(await loadCreditDimensions(ctx, tenantId), await loadCreditFacts(ctx, tenantId, range), range);
}
