/**
 * Polluted-lead split, phase 5 (docs/plans/polluted-lead-split.md §5.6 to
 * §5.9): apply an approved plan, verify it, and roll it back.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { isActiveOpportunityStatus } from "../lib/tenantStatsHelper";
import {
  insertLeadAggregate,
  insertMeetingAggregate,
  insertOpportunityAggregate,
} from "../reporting/writeHooks";
import { extractPerson, finalizePlan, movePerson, readPlanPersons } from "./apply";
import { assertPersonApplied } from "./verify";
import { bookingHarness } from "../../tests/bookingHarness";
import { forceOpportunityState } from "../../tests/opportunityFixtures";
import {
  AT,
  DAY,
  book,
  build,
  discover,
  insertLead,
  insertOpportunity,
  planFor,
  seedTierA,
  setup,
  snapshot,
  type Harness,
} from "../../tests/leadSplitFixtures";

afterEach(() => {
  vi.useRealTimers();
});

/**
 * The fixtures insert rows directly. Production rows are in the reporting
 * aggregates and counted in tenantStats, which apply and rollback update.
 */
async function asInProduction(harness: Harness, limit = 500) {
  const { t, tenantId } = harness;
  await t.run(async (ctx) => {
    for (const lead of await ctx.db.query("leads").take(limit)) await insertLeadAggregate(ctx, lead._id);
    for (const opportunity of await ctx.db.query("opportunities").take(limit)) {
      await insertOpportunityAggregate(ctx, opportunity._id);
    }
    for (const meeting of await ctx.db.query("meetings").take(limit)) await insertMeetingAggregate(ctx, meeting._id);
  });
  await t.mutation(internal.admin.migrations.seedTenantStatsInternal, { tenantId });
}

/** tenantStats against a recount, as seedTenantStatsInternal counts. */
async function expectStatsMatchRecount(harness: Harness, limit = 100) {
  const { stats, leads, opportunities } = await harness.t.run(async (ctx) => ({
    stats: await ctx.db.query("tenantStats").withIndex("by_tenantId", (q) => q.eq("tenantId", harness.tenantId)).unique(),
    leads: await ctx.db.query("leads").take(limit),
    opportunities: await ctx.db.query("opportunities").take(limit),
  }));
  expect({
    totalLeads: stats?.totalLeads,
    totalOpportunities: stats?.totalOpportunities,
    activeOpportunities: stats?.activeOpportunities,
    wonDeals: stats?.wonDeals,
    lostDeals: stats?.lostDeals,
  }).toEqual({
    totalLeads: leads.filter((lead) => lead.status === "active").length,
    totalOpportunities: opportunities.length,
    activeOpportunities: opportunities.filter((opportunity) => isActiveOpportunityStatus(opportunity.status)).length,
    wonDeals: opportunities.filter((opportunity) => opportunity.status === "payment_received").length,
    lostDeals: opportunities.filter((opportunity) => opportunity.status === "lost").length,
  });
}

async function approve(harness: Harness, planId: Id<"leadSplitPlans">) {
  const plan = await harness.t.run((ctx) => ctx.db.get("leadSplitPlans", planId));
  await harness.t.mutation(internal.leadSplit.plan.approve, {
    planId,
    planVersion: plan!.planVersion,
    reviewer: "Reviewer Name",
  });
}

/** The three migrations, each person or plan in its own transaction. */
async function apply(harness: Harness, planId: Id<"leadSplitPlans">) {
  const { t } = harness;
  const persons = await t.run((ctx) => readPlanPersons(ctx, planId));
  for (const person of persons) await t.run((ctx) => extractPerson(ctx, person._id));
  for (const person of persons) await t.run((ctx) => movePerson(ctx, person._id));
  const result = await t.run((ctx) => finalizePlan(ctx, planId));
  // Status changes reach meetings through the projection queue; the asserts
  // run once it drains.
  await t.finishAllScheduledFunctions(vi.runAllTimers, 2_000);
  return result;
}

async function rollback(harness: Harness, planId: Id<"leadSplitPlans">, batchSize = 100) {
  for (let calls = 0; calls < 50; calls += 1) {
    const result = await harness.t.mutation(internal.leadSplit.rollback.rollbackPlan, { planId, batchSize });
    if (!result.continues) return calls + 1;
  }
  throw new Error("Rollback didn't finish");
}

/** The fields the split changes, for comparing before and after a rollback. */
async function state(harness: Harness, limit = 100) {
  return await harness.t.run(async (ctx) => {
    const { tenantId } = harness;
    const leads = await ctx.db.query("leads").withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId)).take(limit);
    const opportunities = await ctx.db
      .query("opportunities")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .take(limit);
    const meetings = await ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_scheduledAt", (q) => q.eq("tenantId", tenantId))
      .take(limit);
    const identifiers = await ctx.db
      .query("leadIdentifiers")
      .withIndex("by_tenantId_and_type_and_value", (q) => q.eq("tenantId", tenantId))
      .take(limit);
    const responses = await ctx.db
      .query("meetingFormResponses")
      .withIndex("by_tenantId_and_fieldKey", (q) => q.eq("tenantId", tenantId))
      .take(limit * 5);
    const events = await ctx.db
      .query("slackQualificationEvents")
      .withIndex("by_tenantId_and_leadId_and_submittedAt", (q) => q.eq("tenantId", tenantId))
      .take(limit);
    const stats = await ctx.db.query("tenantStats").withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId)).unique();
    return {
      leads: leads.map((lead) => ({
        _id: lead._id,
        email: lead.email,
        fullName: lead.fullName,
        phone: lead.phone,
        status: lead.status,
        country: lead.country,
        customFields: lead.customFields,
        firstSeenAt: lead.firstSeenAt,
        splitLockedAt: lead.splitLockedAt,
      })),
      opportunities: opportunities.map((opportunity) => ({
        _id: opportunity._id,
        leadId: opportunity.leadId,
        status: opportunity.status,
        createdAt: opportunity.createdAt,
        firstMeetingId: opportunity.firstMeetingId,
        canceledAt: opportunity.canceledAt,
        noShowAt: opportunity.noShowAt,
        potentialDuplicateLeadId: opportunity.potentialDuplicateLeadId,
      })),
      meetings: meetings.map((meeting) => ({
        _id: meeting._id,
        opportunityId: meeting.opportunityId,
        callClassification: meeting.callClassification,
      })),
      identifiers: identifiers
        .map((identifier) => `${identifier.leadId}:${identifier.type}:${identifier.value}`)
        .sort(),
      responses: responses.map((response) => ({
        _id: response._id,
        leadId: response.leadId,
        opportunityId: response.opportunityId,
      })),
      events: events.map((event) => ({ _id: event._id, leadId: event.leadId, opportunityId: event.opportunityId })),
      stats: {
        totalLeads: stats?.totalLeads ?? 0,
        totalOpportunities: stats?.totalOpportunities ?? 0,
        activeOpportunities: stats?.activeOpportunities ?? 0,
      },
    };
  });
}

const meetingOf = (meetingId: Id<"meetings">) => (harness: Harness) =>
  harness.t.run((ctx) => ctx.db.get("meetings", meetingId));

async function verifyTenant(harness: Harness) {
  const results = await harness.t.action(internal.leadSplit.verify.verifyTenant, {
    tenantId: harness.tenantId,
    pageSize: 7,
  });
  return Object.fromEntries(results.map((result) => [result.check, result.failed]));
}

describe("apply", () => {
  it("splits a Tier A lead, verifies it, and rolls it back", async () => {
    const harness = await setup();
    const { t } = harness;
    const { leadId, piaLeadId, mixed, whole, meetings } = await seedTierA(harness);
    // The pipeline flagged Pia's booking as a possible duplicate of her lead.
    await t.run((ctx) => ctx.db.patch("opportunities", whole, { potentialDuplicateLeadId: piaLeadId }));
    await asInProduction(harness);
    await discover(harness);
    const plan = await planFor(harness, leadId);
    await build(harness, plan._id);
    await approve(harness, plan._id);
    const before = await state(harness);

    expect(await apply(harness, plan._id)).toEqual({ applied: true });
    expect(await planFor(harness, leadId)).toMatchObject({ status: "applied" });
    const persons = await t.run((ctx) => readPlanPersons(ctx, plan._id));
    expect(persons.every((person) => person.status === "applied")).toBe(true);
    const pedro = persons.find((person) => person.meetingIds.includes(meetings.pedro))!;
    const paula = persons.find((person) => person.role === "original")!;
    const pedroLeadId = pedro.targetLeadId!;
    const paulaDealId = paula.opportunityPlan[0].newOpportunityId!;

    const after = await t.run(async (ctx) => ({
      source: await ctx.db.get("leads", leadId),
      pedroLead: await ctx.db.get("leads", pedroLeadId),
      mixed: await ctx.db.get("opportunities", mixed),
      whole: await ctx.db.get("opportunities", whole),
      paulaDeal: await ctx.db.get("opportunities", paulaDealId),
      pedroIdentifiers: await ctx.db
        .query("leadIdentifiers")
        .withIndex("by_leadId", (q) => q.eq("leadId", pedroLeadId))
        .take(10),
      sourceIdentifiers: await ctx.db
        .query("leadIdentifiers")
        .withIndex("by_leadId", (q) => q.eq("leadId", leadId))
        .take(10),
      pedroResponses: await ctx.db
        .query("meetingFormResponses")
        .withIndex("by_meetingId", (q) => q.eq("meetingId", meetings.pedro))
        .take(10),
    }));
    // F2: the source lead is Paula's, without the placeholder phone.
    expect(after.source).toMatchObject({ email: "paula@x.com", fullName: "Paula One", status: "active" });
    expect(after.source?.phone).toBeUndefined();
    expect(after.source?.splitLockedAt).toBeUndefined();
    expect(after.sourceIdentifiers.map((identifier) => identifier.value)).toEqual(["paula@x.com"]);
    // Pedro keeps the mixed deal's document on his own lead.
    expect(after.pedroLead).toMatchObject({ email: "pedro@x.com", fullName: "Pedro Two", status: "active" });
    expect(after.pedroLead?.splitLockedAt).toBeUndefined();
    expect(after.pedroIdentifiers.map((identifier) => identifier.value)).toEqual(["pedro@x.com"]);
    expect(after.mixed).toMatchObject({ leadId: pedroLeadId, status: "no_show", firstMeetingId: meetings.pedro });
    expect(after.pedroResponses.every((response) => response.leadId === pedroLeadId)).toBe(true);
    // Paula's booking left for a new deal on her lead, dated from her meeting.
    const paulaMeeting = await meetingOf(meetings.paula)(harness);
    expect(after.paulaDeal).toMatchObject({
      leadId,
      status: "canceled",
      source: "calendly",
      createdAt: paulaMeeting!.createdAt,
      firstMeetingId: meetings.paula,
    });
    expect(paulaMeeting).toMatchObject({ opportunityId: paulaDealId, callClassification: "new", opportunityStatus: "canceled" });
    // Pia's whole deal merged into her own lead, which clears the flag.
    expect(after.whole?.leadId).toBe(piaLeadId);
    expect(after.whole?.potentialDuplicateLeadId).toBeUndefined();
    // The split's writes aren't activity: moved deals keep their own times,
    // and Paula's new deal is as recent as its own cancellation.
    expect([after.whole?.updatedAt, after.mixed?.updatedAt]).toEqual([AT, AT]);
    expect(after.paulaDeal?.updatedAt).toBe(after.paulaDeal?.canceledAt);

    // A deal still at the split's write time, as on plans finalized before
    // finalize restored them, is fixed by the one-off.
    const moveRow = await t.run(async (ctx) =>
      (await ctx.db.query("leadSplitAudit").withIndex("by_planId_and_revertedAt", (q) => q.eq("planId", plan._id)).take(500)).find(
        (row) => row.step === `move:${whole}`,
      ),
    );
    await t.run((ctx) => ctx.db.patch("opportunities", whole, { updatedAt: moveRow!.createdAt }));
    expect(await t.mutation(internal.leadSplit.apply.restoreAppliedActivityTimes, { planId: plan._id })).toEqual({
      planId: plan._id,
      restored: 1,
    });
    expect((await t.run((ctx) => ctx.db.get("opportunities", whole)))?.updatedAt).toBe(AT);

    const applied = await state(harness);
    expect(applied.stats).toEqual({
      totalLeads: before.stats.totalLeads + 1,
      totalOpportunities: before.stats.totalOpportunities + 1,
      activeOpportunities: before.stats.activeOpportunities,
    });
    await expectStatsMatchRecount(harness);
    for (const person of persons) await t.run((ctx) => assertPersonApplied(ctx, person));
    expect(await verifyTenant(harness)).toEqual({
      identifier_meeting_consistency: 0,
      placeholder_identifiers: 0,
      placeholder_lead_emails: 0,
      form_response_refs: 0,
      follow_up_refs: 0,
      slack_event_refs: 0,
      customer_refs: 0,
      meeting_opportunity_status: 0,
    });

    // A booking on a deal the split created stops rollback before it starts.
    const rebooked = await t.run(async (ctx) => {
      const meeting = (await ctx.db.get("meetings", meetings.paula))!;
      const { _id, _creationTime, ...fields } = meeting;
      return await ctx.db.insert("meetings", { ...fields, calendlyInviteeUri: `${fields.calendlyInviteeUri}-2` });
    });
    await expect(
      t.mutation(internal.leadSplit.rollback.rollbackPlan, { planId: plan._id }),
    ).rejects.toThrow(`Meeting ${rebooked} was added to new opportunity ${paulaDealId} after the split`);
    await t.run((ctx) => ctx.db.delete("meetings", rebooked));

    // Rollback, a few rows per call, restores every field the split changed.
    expect(await rollback(harness, plan._id, 4)).toBeGreaterThan(1);
    expect(await planFor(harness, leadId)).toMatchObject({ status: "rolled_back" });
    const restored = await state(harness);
    expect(restored).toEqual(before);
    await expectStatsMatchRecount(harness);
    expect(await t.run((ctx) => ctx.db.get("leads", pedroLeadId))).toBeNull();
    expect(await t.run((ctx) => ctx.db.get("opportunities", paulaDealId))).toBeNull();
    // A rolled-back plan can be rebuilt and applied again.
    expect(await build(harness, plan._id)).toMatchObject({ status: "draft" });
  });

  it("moves a Slack deal's status for its keeper, and a reverted one back", async () => {
    const harness = await setup();
    const { t, tenantId } = harness;
    const seeded = await t.run(async (ctx) => {
      const leadId = await insertLead(ctx, tenantId, { country: "US" });
      const installationId = await ctx.db.insert("slackInstallations", {
        tenantId,
        teamId: "T1",
        teamName: "Team",
        isEnterpriseInstall: false,
        appId: "A1",
        botUserId: "B1",
        botAccessToken: "xoxb-test",
        scopes: [],
        installedByWorkosUserId: "user_admin",
        installedAt: AT,
        tokenExpiresAt: AT,
        refreshToken: "refresh",
        status: "active",
      });
      const qualifiedBy = { slackUserId: "U1", slackTeamId: "T1", submittedAt: AT };
      const deal = await insertOpportunity(ctx, tenantId, leadId, {
        source: "slack_qualified",
        status: "no_show",
        qualifiedBy,
        noShowAt: AT + 5,
      });
      const eventId = await ctx.db.insert("slackQualificationEvents", {
        tenantId,
        installationId,
        leadId,
        opportunityId: deal,
        resultKind: "already_booked",
        qualifiedBy,
        slackUserId: "U1",
        slackTeamId: "T1",
        fullNameSnapshot: "Sam",
        platform: "instagram",
        handleSnapshot: "@SamOne",
        submittedAt: AT,
        createdAt: AT,
      });
      const sam = await book(ctx, { tenantId, leadId, opportunityId: deal }, {
        day: 1,
        status: "canceled",
        email: "sam@x.com",
        identifierPhone: "+12342342342",
        instagramAnswer: "samone",
      });
      const tom = await book(ctx, { tenantId, leadId, opportunityId: deal }, {
        day: 3,
        status: "no_show",
        email: "tom@x.com",
        instagramAnswer: "tomtwo",
      });
      await snapshot(ctx, tenantId, sam, { email: "sam@x.com", name: "Sam One" });
      await snapshot(ctx, tenantId, tom, { email: "tom@x.com", name: "Tom Two" });
      return { leadId, deal, eventId, sam, tom };
    });
    await asInProduction(harness);
    await discover(harness);
    const plan = await planFor(harness, seeded.leadId);
    await build(harness, plan._id);
    await approve(harness, plan._id);
    const before = await state(harness);

    await apply(harness, plan._id);
    const persons = await t.run((ctx) => readPlanPersons(ctx, plan._id));
    const tom = persons.find((person) => person.role === "new")!;
    const tomDealId = tom.opportunityPlan[0].newOpportunityId!;
    const after = await t.run(async (ctx) => ({
      deal: await ctx.db.get("opportunities", seeded.deal),
      tomDeal: await ctx.db.get("opportunities", tomDealId),
      event: await ctx.db.get("slackQualificationEvents", seeded.eventId),
      source: await ctx.db.get("leads", seeded.leadId),
      tomLead: await ctx.db.get("leads", tom.targetLeadId!),
    }));
    // Sam keeps the Slack document, canceled like his own booking (lead_split).
    expect(after.deal).toMatchObject({ leadId: seeded.leadId, status: "canceled", source: "slack_qualified" });
    expect(after.deal?.noShowAt).toBeUndefined();
    // Tom, the latest booker, takes the no-show outcome to a new deal.
    expect(after.tomDeal).toMatchObject({ leadId: tom.targetLeadId, status: "no_show", noShowAt: AT + 5, source: "calendly" });
    expect(after.event).toMatchObject({ leadId: seeded.leadId, opportunityId: seeded.deal });
    // Sam holds the lead's Slack fields.
    expect(after.source).toMatchObject({ country: "US", email: "sam@x.com" });
    expect(after.tomLead?.country).toBeUndefined();
    for (const person of persons) await t.run((ctx) => assertPersonApplied(ctx, person));

    // A closer rebooking the kept deal after the split stops rollback before it starts.
    await t.run((ctx) => forceOpportunityState(ctx, seeded.deal, { status: "scheduled" }));
    await expect(
      t.mutation(internal.leadSplit.rollback.rollbackPlan, { planId: plan._id }),
    ).rejects.toThrow(`Opportunity ${seeded.deal} moved from canceled to scheduled after the split`);
    await t.run((ctx) => forceOpportunityState(ctx, seeded.deal, { status: "canceled" }));

    await rollback(harness, plan._id);
    expect(await state(harness)).toEqual(before);
  });

  it("leaves a converted lead and its customer with the buyer", async () => {
    const harness = await setup();
    const { t, tenantId } = harness;
    const seeded = await t.run(async (ctx) => {
      const leadId = await insertLead(ctx, tenantId, { status: "converted", email: "shared@x.com", fullName: "July Person" });
      const july = await insertOpportunity(ctx, tenantId, leadId, { status: "canceled" });
      const october = await insertOpportunity(ctx, tenantId, leadId, { status: "payment_received" });
      const julyMeeting = await book(ctx, { tenantId, leadId, opportunityId: july }, {
        day: 1,
        status: "canceled",
        email: "shared@x.com",
        phoneAnswer: "7789559253",
        instagramAnswer: "julyperson",
      });
      const octoberMeeting = await book(ctx, { tenantId, leadId, opportunityId: october }, {
        day: 100,
        status: "completed",
        phoneAnswer: "6045550101",
        instagramAnswer: "octperson",
      });
      await snapshot(ctx, tenantId, julyMeeting, { email: "shared@x.com", name: "July Person" });
      await snapshot(ctx, tenantId, octoberMeeting, { email: "shared@x.com", name: "October Buyer" });
      const adminId = (await ctx.db
        .query("users")
        .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
        .take(10)).find((user) => user.role === "tenant_admin")!._id;
      const programId = await ctx.db.insert("tenantPrograms", {
        tenantId,
        name: "Program",
        normalizedName: "program",
        createdAt: AT,
        createdByUserId: adminId,
        updatedAt: AT,
      });
      const customerId = await ctx.db.insert("customers", {
        tenantId,
        leadId,
        fullName: "July Person",
        email: "shared@x.com",
        convertedAt: AT + 100 * DAY,
        convertedByUserId: adminId,
        winningOpportunityId: october,
        winningMeetingId: octoberMeeting,
        programId,
        programName: "Program",
        status: "active",
        createdAt: AT + 100 * DAY,
      });
      return { leadId, july, october, customerId, julyMeeting, octoberMeeting };
    });
    await asInProduction(harness);
    await discover(harness);
    const plan = await planFor(harness, seeded.leadId);
    await build(harness, plan._id);
    await approve(harness, plan._id);
    const before = await state(harness);

    await apply(harness, plan._id);
    const julyPerson = (await t.run((ctx) => readPlanPersons(ctx, plan._id))).find((person) =>
      person.meetingIds.includes(seeded.julyMeeting),
    )!;
    const after = await t.run(async (ctx) => ({
      source: await ctx.db.get("leads", seeded.leadId),
      customer: await ctx.db.get("customers", seeded.customerId),
      julyLead: await ctx.db.get("leads", julyPerson.targetLeadId!),
      julyDeal: await ctx.db.get("opportunities", seeded.july),
    }));
    // The lead stays converted with its customer, now named for the buyer.
    expect(after.source).toMatchObject({ status: "converted", email: "shared@x.com", fullName: "October Buyer" });
    expect(after.customer).toMatchObject({ leadId: seeded.leadId, fullName: "October Buyer", email: "shared@x.com" });
    // The July booker leaves without the reused email (Q5).
    expect(after.julyLead).toMatchObject({ status: "active", fullName: "July Person" });
    expect(after.julyLead?.email).toBeUndefined();
    expect(after.julyDeal?.leadId).toBe(julyPerson.targetLeadId);
    await expectStatsMatchRecount(harness);
    // The buyer keeps the email the July booking sourced; it is re-sourced to
    // the buyer's own booking, which used it too.
    const sharedEmail = await t.run(async (ctx) =>
      (await ctx.db.query("leadIdentifiers").withIndex("by_leadId", (q) => q.eq("leadId", seeded.leadId)).take(10)).find(
        (identifier) => identifier.type === "email",
      ),
    );
    expect(sharedEmail?.sourceMeetingId).toBe(seeded.octoberMeeting);
    expect(await verifyTenant(harness)).toMatchObject({ customer_refs: 0, identifier_meeting_consistency: 0 });
    // A plan applied before apply re-sourced identifiers is fixed by the one-off.
    await t.run((ctx) => ctx.db.patch("leadIdentifiers", sharedEmail!._id, { sourceMeetingId: seeded.julyMeeting }));
    expect(await verifyTenant(harness)).toMatchObject({ identifier_meeting_consistency: 1 });
    expect(await t.mutation(internal.leadSplit.apply.resourceAppliedIdentifiers, { planId: plan._id })).toEqual({
      planId: plan._id,
      resourced: 1,
    });
    expect(await verifyTenant(harness)).toMatchObject({ identifier_meeting_consistency: 0 });
    expect((await t.run((ctx) => ctx.db.get("leadIdentifiers", sharedEmail!._id)))?.sourceMeetingId).toBe(
      seeded.octoberMeeting,
    );

    await rollback(harness, plan._id);
    expect(await state(harness)).toEqual(before);
    expect(await t.run((ctx) => ctx.db.get("customers", seeded.customerId))).toMatchObject({ fullName: "July Person" });
  });

  it("finds a deal that changed after the build, and stops on it", async () => {
    const harness = await setup();
    const { t } = harness;
    const { leadId, whole } = await seedTierA(harness);
    await asInProduction(harness);
    await discover(harness);
    const plan = await planFor(harness, leadId);
    await build(harness, plan._id);
    await approve(harness, plan._id);
    const preflight = () => t.query(internal.leadSplit.apply.preflight, { planId: plan._id });
    expect((await preflight()).problems).toEqual([]);
    await t.run((ctx) => forceOpportunityState(ctx, whole, { status: "canceled" }));
    expect((await preflight()).problems).toEqual([{ code: "status_changed", opportunityId: whole }]);
    await t.run((ctx) => forceOpportunityState(ctx, whole, { status: "scheduled" }));

    const persons = await t.run((ctx) => readPlanPersons(ctx, plan._id));
    for (const person of persons) await t.run((ctx) => extractPerson(ctx, person._id));
    await t.run((ctx) => forceOpportunityState(ctx, whole, { status: "canceled" }));

    const pia = persons.find((person) => person.role === "merge_into")!;
    await expect(t.run((ctx) => movePerson(ctx, pia._id))).rejects.toThrow(
      `Opportunity ${whole} is canceled, not scheduled as built. Rebuild the plan.`,
    );
    // The leads stay locked, so bookings for them block until a fix or rollback.
    const source = await t.run((ctx) => ctx.db.get("leads", leadId));
    expect(source?.splitLockedAt).toBeDefined();
    await t.run((ctx) => forceOpportunityState(ctx, whole, { status: "scheduled" }));
    await rollback(harness, plan._id);
    expect((await t.run((ctx) => ctx.db.get("leads", leadId)))?.splitLockedAt).toBeUndefined();
  });

  it("won't apply a plan nobody approved", async () => {
    const harness = await setup();
    const { t } = harness;
    const { leadId } = await seedTierA(harness);
    await discover(harness);
    const plan = await planFor(harness, leadId);
    await build(harness, plan._id);
    const persons = await t.run((ctx) => readPlanPersons(ctx, plan._id));
    expect(await t.run((ctx) => extractPerson(ctx, persons[0]._id))).toEqual({
      applied: false,
      reason: "plan_not_approved",
    });
    expect(await t.run((ctx) => movePerson(ctx, persons[0]._id))).toEqual({
      applied: false,
      reason: "plan_not_applying",
    });
  });
});

describe("probeDelivery", () => {
  it("resolves a blocked booking to one lead once the split is applied", async () => {
    const harness = await setup();
    const { t, tenantId } = harness;
    const { leadId, meetings } = await seedTierA(harness);
    await asInProduction(harness);
    const deliveryId = await t.run(async (ctx) => {
      const meeting = (await ctx.db.get("meetings", meetings.pedro)) as Doc<"meetings">;
      const rawEventId = await ctx.db.insert("rawWebhookEvents", {
        tenantId,
        calendlyEventUri: meeting.calendlyEventUri,
        eventType: "invitee.created",
        payload: JSON.stringify({
          event: "invitee.created",
          payload: { uri: "https://api.calendly.com/scheduled_events/new/invitees/x", email: "Pedro@x.com" },
        }),
        processed: false,
        receivedAt: AT,
      });
      return await ctx.db.insert("webhookDeliveries", {
        tenantId,
        key: "k",
        eventType: "invitee.created",
        inviteeUri: "https://api.calendly.com/scheduled_events/new/invitees/x",
        rawEventId,
        occurredAt: AT,
        receivedAt: AT,
        status: "blocked",
        reason: "identity_conflict",
        generation: 0,
      });
    });
    const probe = () => t.query(internal.leadSplit.verify.probeDelivery, { deliveryId });
    // Pedro's email is a secondary identifier on the polluted lead.
    expect(await probe()).toMatchObject({ leadIds: [leadId], leadEmailMatches: false });

    await discover(harness);
    const plan = await planFor(harness, leadId);
    await build(harness, plan._id);
    await approve(harness, plan._id);
    await apply(harness, plan._id);
    const pedro = (await t.run((ctx) => readPlanPersons(ctx, plan._id))).find((person) =>
      person.meetingIds.includes(meetings.pedro),
    )!;
    expect(await probe()).toMatchObject({
      payloadAvailable: true,
      leadIds: [pedro.targetLeadId],
      leadEmailMatches: true,
      resolvesToOneLead: true,
      // So the pipeline won't hold the booking as historical.
      newerOpportunityIds: [],
      tooManyOpportunities: false,
    });
  });
});

describe("transaction limits", () => {
  it("applies and rolls back a plan the size of the largest polluted lead", { timeout: 120_000 }, async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-15T00:00:00Z"));
    const harness = await bookingHarness({ transactionLimits: true });
    const { t, tenantId } = harness;
    // jh74vyt5…: 53 people, 28 deals, 65 meetings and 434 form answers.
    const PEOPLE = 53;
    const DEALS = 28;
    const MEETINGS = 65;
    const leadId = await t.run(async (ctx) => {
      const leadId = await insertLead(ctx, tenantId, { email: "person0@x.com" });
      const deals = [];
      for (let d = 0; d < DEALS; d += 1) {
        deals.push(await insertOpportunity(ctx, tenantId, leadId, { status: "canceled", notes: "x".repeat(1_200) }));
      }
      for (let m = 0; m < MEETINGS; m += 1) {
        const p = m % PEOPLE;
        const meetingId = await book(ctx, { tenantId, leadId, opportunityId: deals[m % DEALS] }, {
          day: m,
          status: "canceled",
          email: m < PEOPLE ? `person${p}@x.com` : undefined,
          identifierPhone: m === 0 ? "+12345678910" : undefined,
          phoneAnswer: "+1 234-567-8910",
          instagramAnswer: `person${p}`,
        });
        for (let r = 0; r < 5; r += 1) {
          await ctx.db.insert("meetingFormResponses", {
            tenantId,
            meetingId,
            opportunityId: deals[m % DEALS],
            leadId,
            fieldKey: `q_extra_${r}`,
            questionLabelSnapshot: `Question ${r}`,
            answerText: "x".repeat(200),
            capturedAt: AT,
          });
        }
        await snapshot(ctx, tenantId, meetingId, { email: `person${p}@x.com`, name: `Person ${p}` });
      }
      return leadId;
    });
    await asInProduction(harness);
    await discover(harness);
    const plan = await planFor(harness, leadId);
    expect((await build(harness, plan._id)).totals).toMatchObject({ persons: PEOPLE, newLeads: PEOPLE - 1 });
    await approve(harness, plan._id);
    const before = await state(harness, 500);

    expect(await apply(harness, plan._id)).toEqual({ applied: true });
    await expectStatsMatchRecount(harness, 500);
    for (const person of await t.run((ctx) => readPlanPersons(ctx, plan._id))) {
      await t.run((ctx) => assertPersonApplied(ctx, person));
    }

    await rollback(harness, plan._id, 25);
    expect(await state(harness, 500)).toEqual(before);
  });
});
