import { v, type Infer } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { query, type QueryCtx } from "../_generated/server";
import { requireTenantUser, type TenantUserResult } from "../requireTenantUser";
import { isReplacement } from "../lib/callType";
import { businessDateForInstant } from "../../lib/businessDay";
import type { ResolvedAnalyticsRange } from "../../lib/analyticsRange";
import { hoursOverDays } from "../lib/workSchedule";
import { createLiveReadState } from "../lib/liveQueryBounds";
import { readScheduleRows, type ScheduleOwner } from "../workSchedules/datedRows";
import { businessDatesInInclusiveRange } from "../workSchedules/rangeHours";
import { MEMBER_REPORT_ROLES, resolveMemberFilter } from "./lib/access";
import {
  addMoney, attributionIdentity, creditIdentityValidator, currencyAmountsValidator, paymentCreditResolver,
  inRange, loadCreditDimensions, loadCreditFacts, memberIdentity, paymentsInRange, reportRange,
  summarizeCaptures, uniqueIds, type CreditDimensions, type CreditFacts, type CreditIdentity, type PeopleRole,
} from "./lib/creditFacts";

const roleValidator = v.union(v.literal("setter"), v.literal("dm_closer"), v.literal("lead_gen"));
const ids = v.array(v.string());
export const peopleRoleRowValidator = v.object({
  ...creditIdentityValidator.fields,
  teams: v.array(v.object({ id: v.id("attributionTeams"), name: v.string() })),
  qualifications: v.number(), qualificationsByResult: v.record(v.string(), v.number()),
  dealsCredited: v.number(), dealIds: ids, booked: v.number(), bookedDealIds: ids, held: v.number(), heldDealIds: ids,
  won: v.number(), wonDealIds: ids, bookRate: v.object({ numerator: v.number(), denominator: v.number(), rate: v.union(v.number(), v.null()) }),
  bookings: v.number(), noShow: v.number(), notRecorded: v.number(), dealsWon: v.number(),
  captures: v.number(), uniquePeople: v.number(), personIds: ids, resparks: v.number(),
  dealsCreditedBySource: v.object({ capture: v.number(), respark: v.number() }), captureDealIds: ids, resparkDealIds: ids,
  byCurrency: currencyAmountsValidator, scheduledHours: v.number(),
});
export const peopleRoleDayValidator = v.object({
  dayKey: v.string(), qualifications: v.number(), bookings: v.number(), captures: v.number(), resparks: v.number(),
  cashMinorByCurrency: currencyAmountsValidator,
});
export const peopleRoleItemValidator = v.object({
  id: v.string(), at: v.number(), personName: v.string(), leadId: v.union(v.id("leads"), v.null()),
  opportunityId: v.union(v.id("opportunities"), v.null()), result: v.string(), outcome: v.union(v.string(), v.null()),
  scheduledAt: v.union(v.number(), v.null()),
});
export const peopleRoleReportValidator = v.object({
  role: roleValidator, memberId: v.union(v.id("teamMembers"), v.null()), rows: v.array(peopleRoleRowValidator),
  days: v.array(peopleRoleDayValidator), items: v.array(peopleRoleItemValidator), isTruncated: v.boolean(),
});
export type PeopleRoleRow = Infer<typeof peopleRoleRowValidator>;
export type PeopleRoleDay = Infer<typeof peopleRoleDayValidator>;
export type PeopleRoleItem = Infer<typeof peopleRoleItemValidator>;
export type PeopleRoleReport = Infer<typeof peopleRoleReportValidator>;
export type RoleHours = { byKey: Map<string, number>; isTruncated: boolean };

function newRow(identity: CreditIdentity): PeopleRoleRow {
  return { ...identity, teams: [], qualifications: 0, qualificationsByResult: {}, dealsCredited: 0,
    dealIds: [], booked: 0, bookedDealIds: [], held: 0, heldDealIds: [], won: 0, wonDealIds: [],
    bookRate: { numerator: 0, denominator: 0, rate: null }, bookings: 0, noShow: 0, notRecorded: 0, dealsWon: 0,
    captures: 0, uniquePeople: 0, personIds: [], resparks: 0, dealsCreditedBySource: { capture: 0, respark: 0 },
    captureDealIds: [], resparkDealIds: [], byCurrency: [], scheduledHours: 0 };
}

/** Distinct counts and rates are derived from the IDs that also cross a split range. */
export function finishPeopleRoleRow(row: PeopleRoleRow, role: PeopleRole): PeopleRoleRow {
  const dealIds = uniqueIds(row.dealIds), bookedDealIds = uniqueIds(row.bookedDealIds), heldDealIds = uniqueIds(row.heldDealIds);
  const wonDealIds = uniqueIds(row.wonDealIds), personIds = uniqueIds(row.personIds);
  const captureDealIds = uniqueIds(row.captureDealIds), resparkDealIds = uniqueIds(row.resparkDealIds);
  const numerator = bookedDealIds.length, denominator = dealIds.length;
  return { ...row, dealIds, bookedDealIds, heldDealIds, wonDealIds, personIds, captureDealIds, resparkDealIds,
    dealsCredited: dealIds.length, booked: bookedDealIds.length,
    held: role === "dm_closer" ? row.held : heldDealIds.length,
    won: wonDealIds.length, dealsWon: wonDealIds.length, uniquePeople: personIds.length,
    dealsCreditedBySource: { capture: captureDealIds.length, respark: resparkDealIds.length },
    bookRate: { numerator, denominator, rate: denominator > 0 ? numerator / denominator : null } };
}

export async function loadRoleHours(ctx: QueryCtx, tenantId: Id<"tenants">, dimensions: CreditDimensions,
  role: PeopleRole, range: ResolvedAnalyticsRange): Promise<RoleHours> {
  const owners: { key: string; owner: ScheduleOwner }[] = role === "setter"
    ? dimensions.slackUsers.map(user => ({ key: memberIdentity(dimensions, user.teamMemberId).key,
      owner: { table: "slackQualifierSchedules", slackUserId: user.slackUserId } }))
    : role === "dm_closer" ? dimensions.dmClosers.map(closer => ({ key: memberIdentity(dimensions, closer.teamMemberId).key,
      owner: { table: "dmCloserSchedules", dmCloserId: closer._id } }))
      : dimensions.workers.map(worker => ({ key: memberIdentity(dimensions, worker.teamMemberId).key,
        owner: { table: "leadGenWorkerSchedules", workerId: worker._id } }));
  const days = businessDatesInInclusiveRange({ startBusinessDate: range.startDate, endBusinessDateInclusive: range.endDateInclusive });
  const result = new Map<string, number>();
  const state = createLiveReadState();
  const seenOwners = new Set<string>();
  for (const { key, owner } of owners) {
    const ownerKey = JSON.stringify(owner);
    if (seenOwners.has(ownerKey)) continue;
    seenOwners.add(ownerKey);
    const scan = await readScheduleRows(ctx, tenantId, owner, state);
    if (scan.capped) break;
    result.set(key, (result.get(key) ?? 0) + hoursOverDays(scan.rows, days));
  }
  return { byKey: result, isTruncated: state.capped };
}

export function buildPeopleRole(dimensions: CreditDimensions, facts: CreditFacts, range: ResolvedAnalyticsRange,
  role: PeopleRole, memberId: Id<"teamMembers"> | null, hours: RoleHours, now: number): PeopleRoleReport {
  const rows = new Map<string, PeopleRoleRow>();
  const creditsForPayment = paymentCreditResolver(dimensions, facts.attributions);
  const cashRecipients = (payment: CreditFacts["payments"][number]) => {
    const people = creditsForPayment(payment, role);
    return role === "dm_closer" && people.length === 0 ? creditsForPayment(payment, "dm_team") : people;
  };
  function row(identity: CreditIdentity) {
    const found = rows.get(identity.key) ?? newRow(identity);
    rows.set(identity.key, found);
    return found;
  }
  const roleRecords = role === "setter" ? dimensions.slackUsers : role === "dm_closer" ? dimensions.dmClosers : dimensions.workers;
  for (const record of roleRecords) {
    const person = row(memberIdentity(dimensions, record.teamMemberId));
    if ("teamId" in record && record.teamId) {
      const team = dimensions.teams.find(team => team._id === record.teamId);
      if (team && !person.teams.some(t => t.id === team._id)) person.teams.push({ id: team._id, name: team.displayName });
    }
  }
  const days = new Map<string, PeopleRoleDay>();
  const items: PeopleRoleItem[] = [];
  function dayByKey(dayKey: string) {
    const found = days.get(dayKey) ?? { dayKey, qualifications: 0, bookings: 0, captures: 0, resparks: 0, cashMinorByCurrency: [] };
    days.set(dayKey, found);
    return found;
  }
  function day(at: number) { return dayByKey(businessDateForInstant(at, range)); }
  function own(identity: CreditIdentity) { return memberId !== null && identity.teamMemberId === memberId; }
  const dealById = new Map(facts.deals.map(deal => [deal._id, deal]));
  const meetingsByDeal = new Map<string, typeof facts.meetings>();
  for (const meeting of facts.meetings) {
    const list = meetingsByDeal.get(meeting.opportunityId) ?? [];
    list.push(meeting); meetingsByDeal.set(meeting.opportunityId, list);
  }
  // Credits by meeting, built once: a year has thousands of each.
  const creditsByMeeting = new Map<string, typeof facts.attributions>();
  for (const credit of facts.attributions) {
    if (credit.meetingId === undefined) continue;
    const list = creditsByMeeting.get(credit.meetingId) ?? [];
    list.push(credit); creditsByMeeting.set(credit.meetingId, list);
  }
  for (const credit of facts.attributions) {
    const teamOnly = role === "dm_closer" && credit.role === "dm_team" && credit.meetingId !== undefined &&
      !(creditsByMeeting.get(credit.meetingId) ?? []).some(row => row.role === "dm_closer");
    if ((credit.role !== role && !teamOnly) || !inRange(credit.attributedAt, range)) continue;
    const person = row(attributionIdentity(dimensions, credit));
    person.dealIds.push(credit.opportunityId);
    if (credit.source.kind === "capture") person.captureDealIds.push(credit.opportunityId);
    if (credit.source.kind === "respark") person.resparkDealIds.push(credit.opportunityId);
    if (role === "setter") {
      const deal = dealById.get(credit.opportunityId);
      const meetings = meetingsByDeal.get(credit.opportunityId) ?? [];
      if (deal?.firstBookedAt !== undefined || meetings.length > 0) person.bookedDealIds.push(credit.opportunityId);
      if (meetings.some(meeting => meeting.status === "held")) person.heldDealIds.push(credit.opportunityId);
      if (deal?.outcome === "won") person.wonDealIds.push(credit.opportunityId);
    }
  }
  if (role !== "setter") {
    for (const payment of facts.firstPayments) {
      if (!inRange(payment.recordedAt, range) || payment.status === "disputed" || !payment.opportunityId) continue;
      for (const identity of cashRecipients(payment)) row(identity).wonDealIds.push(payment.opportunityId);
    }
  }
  for (const payment of paymentsInRange(facts, range)) {
    for (const identity of cashRecipients(payment)) {
      addMoney(row(identity).byCurrency, payment.currency, payment.amountMinor);
      if (own(identity)) addMoney(day(payment.recordedAt).cashMinorByCurrency, payment.currency, payment.amountMinor);
    }
  }
  if (role === "setter") for (const qualification of facts.qualifications) {
    if (!inRange(qualification.submittedAt, range)) continue;
    const slackUser = dimensions.slackUsers.find(user => user.slackUserId === qualification.slackUserId && user.slackTeamId === qualification.slackTeamId);
    const identity = memberIdentity(dimensions, slackUser?.teamMemberId);
    const person = row(identity);
    person.qualifications++;
    person.qualificationsByResult[qualification.resultKind] = (person.qualificationsByResult[qualification.resultKind] ?? 0) + 1;
    if (own(identity)) {
      day(qualification.submittedAt).qualifications++;
      items.push({ id: qualification._id, at: qualification.submittedAt, personName: qualification.fullNameSnapshot,
        leadId: qualification.leadId ?? null, opportunityId: qualification.opportunityId ?? null,
        result: qualification.resultKind, outcome: qualification.opportunityId ? dealById.get(qualification.opportunityId)?.outcome ?? null : null,
        scheduledAt: null });
    }
  }
  if (role === "dm_closer") for (const meeting of facts.meetings) {
    if (!inRange(meeting.createdAt, range) || isReplacement(meeting)) continue;
    const credits = creditsByMeeting.get(meeting._id) ?? [];
    const named = credits.filter(credit => credit.role === "dm_closer");
    const bookingCredits = named.length > 0 ? named : credits.filter(credit => credit.role === "dm_team");
    const identities = new Map(bookingCredits.map(credit => {
      const identity = attributionIdentity(dimensions, credit); return [identity.key, identity];
    }));
    for (const identity of identities.values()) {
      const person = row(identity); person.bookings++;
      if (meeting.status === "held") person.held++;
      if (meeting.status === "no_show") person.noShow++;
      if (meeting.status === "scheduled" && meeting.scheduledAt + meeting.durationMinutes * 60_000 <= now) person.notRecorded++;
      if (own(identity)) {
        day(meeting.createdAt).bookings++;
        const deal = dealById.get(meeting.opportunityId);
        items.push({ id: meeting._id, at: meeting.createdAt, personName: facts.people.find(p => p._id === deal?.leadId)?.fullName ?? meeting.leadName ?? "Unknown person",
          leadId: deal?.leadId ?? null, opportunityId: meeting.opportunityId, result: meeting.status,
          outcome: deal?.outcome ?? null, scheduledAt: meeting.scheduledAt });
      }
    }
  }
  if (role === "lead_gen") {
    for (const stat of facts.captureStats ?? summarizeCaptures(facts, range)) {
      const worker = dimensions.workers.find(worker => worker._id === stat.workerId);
      const identity = memberIdentity(dimensions, worker?.teamMemberId);
      const person = row(identity);
      person.captures += stat.captures;
      if (stat.leadId) person.personIds.push(stat.leadId);
      if (own(identity)) dayByKey(stat.dayKey).captures += stat.captures;
    }
    for (const capture of facts.captures) {
      if (capture.voidedAt !== undefined || !inRange(capture.submittedAt, range)) continue;
      const worker = dimensions.workers.find(worker => worker._id === capture.workerId);
      const identity = memberIdentity(dimensions, worker?.teamMemberId);
      const prospect = facts.prospects.find(prospect => prospect._id === capture.prospectId);
      if (own(identity)) {
        items.push({ id: capture._id, at: capture.submittedAt,
          personName: facts.people.find(person => person._id === prospect?.leadId)?.fullName ?? "Unknown person",
          leadId: prospect?.leadId ?? null, opportunityId: null, result: capture.source, outcome: null, scheduledAt: null });
      }
    }
    for (const respark of facts.resparks) {
      // A respark is an item worked to "resparked"; skipped and not-a-fit
      // items were worked without one.
      if (respark.result !== "resparked") continue;
      if (respark.workedAt === undefined || !inRange(respark.workedAt, range)) continue;
      const worker = dimensions.workers.find(worker => worker._id === respark.workerId);
      const identity = memberIdentity(dimensions, worker?.teamMemberId);
      row(identity).resparks++;
      if (own(identity)) day(respark.workedAt).resparks++;
    }
  }
  return { role, memberId,
    rows: [...rows.values()].filter(row => memberId === null || row.teamMemberId === memberId)
      .map(row => finishPeopleRoleRow({ ...row, scheduledHours: hours.byKey.get(row.key) ?? 0,
        teams: row.teams.sort((a, b) => a.id.localeCompare(b.id)) }, role)).sort((a, b) => a.key.localeCompare(b.key)),
    days: [...days.values()].sort((a, b) => a.dayKey.localeCompare(b.dayKey)),
    items: items.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id)).slice(0, 300), isTruncated: facts.isTruncated || hours.isTruncated };
}

// Keep named builders for callers and parity fixtures of each definition.
export const buildSetters = (dimensions: CreditDimensions, facts: CreditFacts, range: ResolvedAnalyticsRange,
  memberId: Id<"teamMembers"> | null, hours: RoleHours, now: number) => buildPeopleRole(dimensions, facts, range, "setter", memberId, hours, now);
export const buildDmClosers = (dimensions: CreditDimensions, facts: CreditFacts, range: ResolvedAnalyticsRange,
  memberId: Id<"teamMembers"> | null, hours: RoleHours, now: number) => buildPeopleRole(dimensions, facts, range, "dm_closer", memberId, hours, now);
export const buildLeadGen = (dimensions: CreditDimensions, facts: CreditFacts, range: ResolvedAnalyticsRange,
  memberId: Id<"teamMembers"> | null, hours: RoleHours, now: number) => buildPeopleRole(dimensions, facts, range, "lead_gen", memberId, hours, now);

const argsValidator = { startDate: v.number(), endDate: v.number(), memberId: v.optional(v.id("teamMembers")) };
async function readRole(ctx: QueryCtx, args: { startDate: number; endDate: number; memberId?: Id<"teamMembers"> }, role: PeopleRole,
  viewer: TenantUserResult): Promise<PeopleRoleReport> {
  const memberId = await resolveMemberFilter(ctx, args.memberId, viewer);
  const range = await reportRange(ctx, viewer.tenantId, args.startDate, args.endDate);
  const dimensions = await loadCreditDimensions(ctx, viewer.tenantId);
  return buildPeopleRole(dimensions, await loadCreditFacts(ctx, viewer.tenantId, range, role), range, role, memberId,
    await loadRoleHours(ctx, viewer.tenantId, dimensions, role, range), Date.now());
}
export const getSetters = query({ args: argsValidator, returns: peopleRoleReportValidator,
  handler: async (ctx, args): Promise<PeopleRoleReport> => {
    const viewer = await requireTenantUser(ctx, [...MEMBER_REPORT_ROLES]);
    return readRole(ctx, args, "setter", viewer);
  } });
export const getDmClosers = query({ args: argsValidator, returns: peopleRoleReportValidator,
  handler: async (ctx, args): Promise<PeopleRoleReport> => {
    const viewer = await requireTenantUser(ctx, [...MEMBER_REPORT_ROLES]);
    return readRole(ctx, args, "dm_closer", viewer);
  } });
export const getLeadGen = query({ args: argsValidator, returns: peopleRoleReportValidator,
  handler: async (ctx, args): Promise<PeopleRoleReport> => {
    const viewer = await requireTenantUser(ctx, [...MEMBER_REPORT_ROLES]);
    return readRole(ctx, args, "lead_gen", viewer);
  } });
