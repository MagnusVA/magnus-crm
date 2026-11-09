import { v } from "convex/values";
import type { Doc, Id, TableNames } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import type { DealAttributionRole } from "../../lib/attribution/dealAttributions";
import { createLiveReadState, readLiveDocuments, readLiveQueryRows } from "../../lib/liveQueryBounds";
import { getTenantBusinessDay } from "../../lib/tenantBusinessDay";
import { assertValidDateRange } from "../../reporting/lib/helpers";
import type { ResolvedAnalyticsRange } from "../../../lib/analyticsRange";
import { businessDateForInstant } from "../../../lib/businessDay";

export const CREDIT_ROLES = ["lead_gen", "setter", "dm_team", "dm_closer", "closer"] as const;
export type PeopleRole = "setter" | "dm_closer" | "lead_gen";
export type CurrencyAmount = { currency: string; amountMinor: number };
export const currencyAmountsValidator = v.array(v.object({ currency: v.string(), amountMinor: v.number() }));
export const creditIdentityValidator = v.object({
  key: v.string(), teamMemberId: v.union(v.id("teamMembers"), v.null()),
  teamId: v.union(v.id("attributionTeams"), v.null()), name: v.string(), linked: v.boolean(),
});
export type CreditIdentity = {
  key: string; teamMemberId: Id<"teamMembers"> | null; teamId: Id<"attributionTeams"> | null;
  name: string; linked: boolean;
};
export type CreditDimensions = {
  members: Doc<"teamMembers">[]; users: Doc<"users">[]; slackUsers: Doc<"slackUsers">[];
  dmClosers: Doc<"dmClosers">[]; workers: Doc<"leadGenWorkers">[]; teams: Doc<"attributionTeams">[];
};
export type CaptureStat = {
  workerId: Id<"leadGenWorkers">; leadId: Id<"leads"> | null; dayKey: string; captures: number; leadIds?: Id<"leads">[];
};
export type CreditFacts = {
  payments: Doc<"paymentRecords">[]; attributions: Doc<"dealAttributions">[];
  deals: Doc<"opportunities">[]; meetings: Doc<"meetings">[]; firstPayments: Doc<"paymentRecords">[];
  qualifications: Doc<"slackQualificationEvents">[]; captures: Doc<"leadGenSubmissions">[];
  prospects: Doc<"leadGenProspects">[]; resparks: Doc<"resparkBatchItems">[]; people: Doc<"leads">[];
  captureStats?: CaptureStat[];
  isTruncated: boolean;
};

export function emptyCreditFacts(): CreditFacts {
  return { payments: [], attributions: [], deals: [], meetings: [], firstPayments: [],
    qualifications: [], captures: [], prospects: [], resparks: [], people: [], isTruncated: false };
}

export function uniqueIds(ids: readonly string[]): string[] { return [...new Set(ids)].sort(); }

export function addMoney(amounts: CurrencyAmount[], currency: string, amountMinor: number) {
  const found = amounts.find((amount) => amount.currency === currency);
  if (found) found.amountMinor += amountMinor;
  else amounts.push({ currency, amountMinor });
  amounts.sort((a, b) => a.currency.localeCompare(b.currency));
}

export function memberIdentity(dimensions: CreditDimensions, id?: Id<"teamMembers">): CreditIdentity {
  const member = dimensions.members.find((member) => member._id === id);
  return member
    ? { key: member._id, teamMemberId: member._id, teamId: null, name: member.displayName, linked: true }
    : { key: "unlinked", teamMemberId: null, teamId: null, name: "Not linked to a member", linked: false };
}

export function teamIdentity(dimensions: CreditDimensions, id?: Id<"attributionTeams">): CreditIdentity {
  const team = dimensions.teams.find((team) => team._id === id);
  return { key: `team:${id ?? "unlinked"}`, teamMemberId: null, teamId: id ?? null,
    name: team?.displayName ?? "Unknown team", linked: team !== undefined };
}

export function attributionIdentity(dimensions: CreditDimensions, row: Doc<"dealAttributions">): CreditIdentity {
  return row.role === "dm_team" ? teamIdentity(dimensions, row.teamId) : memberIdentity(dimensions, row.teamMemberId);
}

/** Credit is full per person, once per payment, and only after the fact happened. */
export function creditedPeople(
  dimensions: CreditDimensions, attributions: readonly Doc<"dealAttributions">[],
  payment: Doc<"paymentRecords">, role: DealAttributionRole,
): CreditIdentity[] {
  if (role === "closer") {
    if (!payment.attributedCloserId) return [];
    const user = dimensions.users.find((user) => user._id === payment.attributedCloserId);
    return [memberIdentity(dimensions, user?.teamMemberId)];
  }
  const people = new Map<string, CreditIdentity>();
  for (const row of attributions) {
    if (row.opportunityId !== payment.opportunityId || row.role !== role || row.attributedAt > payment.recordedAt) continue;
    const person = attributionIdentity(dimensions, row);
    people.set(person.key, person);
  }
  return [...people.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export function paymentCreditResolver(dimensions: CreditDimensions, attributions: readonly Doc<"dealAttributions">[]) {
  const byDeal = new Map<string, Doc<"dealAttributions">[]>();
  for (const row of attributions) {
    const rows = byDeal.get(row.opportunityId) ?? [];
    rows.push(row); byDeal.set(row.opportunityId, rows);
  }
  return (payment: Doc<"paymentRecords">, role: DealAttributionRole) =>
    creditedPeople(dimensions, payment.opportunityId ? byDeal.get(payment.opportunityId) ?? [] : [], payment, role);
}

export function paymentsInRange(facts: CreditFacts, range: ResolvedAnalyticsRange) {
  return facts.payments.filter((payment) => payment.status !== "disputed" && inRange(payment.recordedAt, range));
}
export function inRange(at: number, range: ResolvedAnalyticsRange) { return at >= range.fromMs && at < range.toMs; }

/** Warehouse captures are reduced to the count, person and day the report needs. */
export function summarizeCaptures(facts: CreditFacts, range: ResolvedAnalyticsRange): CaptureStat[] {
  const prospects = new Map(facts.prospects.map(prospect => [prospect._id, prospect]));
  const stats = new Map<string, CaptureStat>();
  for (const capture of facts.captures) {
    if (capture.voidedAt !== undefined || !inRange(capture.submittedAt, range)) continue;
    const leadId = prospects.get(capture.prospectId)?.leadId ?? null;
    const dayKey = businessDateForInstant(capture.submittedAt, range);
    const key = `${capture.workerId}:${leadId}:${dayKey}`;
    const stat = stats.get(key) ?? { workerId: capture.workerId, leadId, dayKey, captures: 0 };
    stat.captures++; stats.set(key, stat);
  }
  return [...stats.values()];
}

export async function reportRange(ctx: QueryCtx, tenantId: Id<"tenants">, fromMs: number, toMs: number): Promise<ResolvedAnalyticsRange> {
  assertValidDateRange(fromMs, toMs);
  const setting = await getTenantBusinessDay(ctx, tenantId);
  return { fromMs, toMs, ...setting, startDate: businessDateForInstant(fromMs, setting),
    endDateInclusive: businessDateForInstant(toMs - 1, setting) };
}

/** Small current directories are shared by live readers and warehouse finalizers. */
export async function loadCreditDimensions(ctx: QueryCtx, tenantId: Id<"tenants">): Promise<CreditDimensions> {
  async function directory<Table extends TableNames>(table: Table, rows: AsyncIterable<Doc<Table>>) {
    const scan = await readLiveQueryRows(rows, 1000);
    if (scan.capped) throw new Error(`The ${table} directory is too large for this report.`);
    return scan.rows;
  }
  const [members, users, slackUsers, dmClosers, workers, teams] = await Promise.all([
    directory("teamMembers", ctx.db.query("teamMembers").withIndex("by_tenantId", q => q.eq("tenantId", tenantId))),
    directory("users", ctx.db.query("users").withIndex("by_tenantId", q => q.eq("tenantId", tenantId))),
    directory("slackUsers", ctx.db.query("slackUsers").withIndex("by_tenantId", q => q.eq("tenantId", tenantId))),
    directory("dmClosers", ctx.db.query("dmClosers").withIndex("by_tenantId_and_teamId", q => q.eq("tenantId", tenantId))),
    directory("leadGenWorkers", ctx.db.query("leadGenWorkers").withIndex("by_tenantId_and_isActive", q => q.eq("tenantId", tenantId))),
    directory("attributionTeams", ctx.db.query("attributionTeams").withIndex("by_tenantId", q => q.eq("tenantId", tenantId))),
  ]);
  return { members, users, slackUsers, dmClosers, workers, teams };
}

/** Related history is bounded too, so a long deal can't exhaust a live query. */
export async function loadCreditFacts(
  ctx: QueryCtx, tenantId: Id<"tenants">, range: ResolvedAnalyticsRange, role?: PeopleRole,
): Promise<CreditFacts> {
  const facts = emptyCreditFacts();
  const state = createLiveReadState();
  async function rows<T>(query: AsyncIterable<T>, limit = 2500) {
    return (await readLiveQueryRows(query, limit, state)).rows;
  }
  async function documents<Table extends TableNames>(table: Table, ids: Id<Table>[]) {
    return (await readLiveDocuments([...new Set(ids)], async id => {
      const doc = await ctx.db.get(table, id);
      return doc && "tenantId" in doc && doc.tenantId === tenantId ? doc : null;
    }, state)).rows;
  }
  facts.payments = await rows(ctx.db.query("paymentRecords").withIndex("by_tenantId_and_recordedAt", q =>
    q.eq("tenantId", tenantId).gte("recordedAt", range.fromMs).lt("recordedAt", range.toMs)));
  if (role) {
    facts.attributions = await rows(ctx.db.query("dealAttributions").withIndex("by_tenantId_and_role_and_attributedAt", q =>
      q.eq("tenantId", tenantId).eq("role", role).gte("attributedAt", range.fromMs).lt("attributedAt", range.toMs)));
    if (role === "setter") facts.qualifications = await rows(ctx.db.query("slackQualificationEvents")
      .withIndex("by_tenantId_and_submittedAt", q => q.eq("tenantId", tenantId).gte("submittedAt", range.fromMs).lt("submittedAt", range.toMs)));
    if (role === "dm_closer") facts.meetings = await rows(ctx.db.query("meetings")
      .withIndex("by_tenantId_and_createdAt", q => q.eq("tenantId", tenantId).gte("createdAt", range.fromMs).lt("createdAt", range.toMs)));
    if (role === "lead_gen") {
      facts.captures = await rows(ctx.db.query("leadGenSubmissions").withIndex("by_tenantId_and_submittedAt", q =>
        q.eq("tenantId", tenantId).gte("submittedAt", range.fromMs).lt("submittedAt", range.toMs)));
      facts.resparks = await rows(ctx.db.query("resparkBatchItems").withIndex("by_tenantId_and_workedAt", q =>
        q.eq("tenantId", tenantId).gte("workedAt", range.fromMs).lt("workedAt", range.toMs)));
      facts.prospects = await documents("leadGenProspects", facts.captures.map(capture => capture.prospectId));
    }
  }
  const dealIds = [...new Set([
    ...facts.payments.flatMap(payment => payment.opportunityId ? [payment.opportunityId] : []),
    ...facts.attributions.map(row => row.opportunityId), ...facts.meetings.map(meeting => meeting.opportunityId),
    ...facts.qualifications.flatMap(row => row.opportunityId ? [row.opportunityId] : []),
  ])];
  facts.deals = await documents("opportunities", dealIds);
  const attributionMap = new Map(facts.attributions.map(row => [row._id, row]));
  const meetingMap = new Map(facts.meetings.map(row => [row._id, row]));
  for (const id of dealIds) {
    if (state.capped) break;
    for (const row of await rows(ctx.db.query("dealAttributions").withIndex("by_tenantId_and_opportunityId_and_role", q =>
      q.eq("tenantId", tenantId).eq("opportunityId", id)), 200)) attributionMap.set(row._id, row);
    if (!role) continue;
    for (const meeting of await rows(ctx.db.query("meetings").withIndex("by_opportunityId", q => q.eq("opportunityId", id)), 200)) {
      if (meeting.tenantId === tenantId) meetingMap.set(meeting._id, meeting);
    }
    const first = await Promise.all((["recorded", "verified"] as const).map(status => ctx.db.query("paymentRecords")
      .withIndex("by_opportunityId_and_status_and_recordedAt", q => q.eq("opportunityId", id).eq("status", status)).first()));
    const payment = first.filter((p): p is Doc<"paymentRecords"> => p !== null && p.tenantId === tenantId)
      .sort((a, b) => a.recordedAt - b.recordedAt || a._id.localeCompare(b._id))[0];
    if (payment) facts.firstPayments.push(payment);
  }
  facts.attributions = [...attributionMap.values()];
  facts.meetings = [...meetingMap.values()];
  if (role) facts.people = await documents("leads", [
    ...facts.deals.map(deal => deal.leadId), ...facts.prospects.flatMap(p => p.leadId ? [p.leadId] : []),
    ...facts.qualifications.flatMap(q => q.leadId ? [q.leadId] : []),
  ]);
  facts.isTruncated = state.capped;
  return facts;
}
