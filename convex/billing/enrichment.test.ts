/**
 * A payment's DM attribution is its meeting's booking rows, else its deal's
 * first booking's (docs/plans/phase-3-attribution.md §6.5).
 */
import { describe, expect, it } from "vitest";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { bookingHarness } from "../../tests/bookingHarness";
import { seedScenario, T0, type ScenarioName } from "../../tests/detailAttributionFixtures";
import {
  DAY,
  fixtureUsers,
  insertDeal,
  insertMeeting,
  insertPayment as insertDealPayment,
  insertPerson,
  insertProgram,
  seedCustomer,
} from "../../tests/enrollmentReadFixtures";
import {
  enrichBillingPaymentListRows,
  enrichBillingPaymentRows,
  personBillingLabels,
  resolveBillingFromPerson,
} from "./enrichment";

async function insertPayment(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  args: {
    closerId: Id<"users">;
    opportunityId?: Id<"opportunities">;
    meetingId?: Id<"meetings">;
  },
) {
  const programId = await ctx.db.insert("tenantPrograms", {
    tenantId,
    name: "Program",
    normalizedName: "program",
    createdAt: T0,
    createdByUserId: args.closerId,
    updatedAt: T0,
  });
  return await ctx.db.insert("paymentRecords", {
    tenantId,
    opportunityId: args.opportunityId,
    meetingId: args.meetingId,
    attributedCloserId: args.closerId,
    amountMinor: 100_000,
    currency: "USD",
    recordedByUserId: args.closerId,
    commissionable: true,
    programId,
    programName: "Program",
    paymentType: "pif",
    status: "recorded",
    recordedAt: T0 + 1_000,
    contextType: "opportunity",
    origin: "closer_meeting",
  });
}

async function paymentDmAttribution(
  scenario: ScenarioName,
  options: { withDeal: boolean } = { withDeal: true },
) {
  const h = await bookingHarness();
  return await h.t.run(async (ctx) => {
    const seeded = await seedScenario(ctx, h.tenantId, scenario);
    const paymentId = await insertPayment(ctx, h.tenantId, {
      closerId: seeded.closer._id,
      opportunityId: options.withDeal ? seeded.opportunityId : undefined,
      meetingId: seeded.meetingId ?? undefined,
    });
    const payment = (await ctx.db.get("paymentRecords", paymentId))!;
    const [row] = await enrichBillingPaymentRows(ctx, h.tenantId, [payment]);
    return { dmAttribution: row.dmAttribution, seeded };
  });
}

describe("billing DM attribution", () => {
  it("labels a payment from its meeting's booking", async () => {
    const { dmAttribution, seeded } = await paymentDmAttribution("team_and_dm_closer");
    expect(dmAttribution).toMatchObject({
      status: "mapped",
      teamName: "Alpha Team",
      dmCloserName: "Dana DM",
      dmCloser: { id: seeded.dm.dmCloserId, source: "dm_closer" },
      rawSource: "alpha",
      rawMedium: "dana",
    });
  });

  it("labels a payment on a meeting never resolved from the deal's first booking", async () => {
    const { dmAttribution } = await paymentDmAttribution("unresolved_rebook");
    expect(dmAttribution).toMatchObject({
      status: "mapped",
      teamName: "Alpha Team",
      dmCloserName: "Dana DM",
    });
  });

  it("labels an internal rebook's payment as internal", async () => {
    const { dmAttribution } = await paymentDmAttribution("internal_rebook");
    expect(dmAttribution).toMatchObject({
      status: "internal",
      teamName: null,
      dmCloserName: null,
      rawSource: "ptdom",
    });
  });

  it("labels a payment with a meeting and no deal from the meeting's rows", async () => {
    const { dmAttribution, seeded } = await paymentDmAttribution("team_and_dm_closer", {
      withDeal: false,
    });
    expect(dmAttribution).toEqual({
      status: "mapped",
      teamName: "Alpha Team",
      dmCloserName: "Dana DM",
      dmCloser: expect.objectContaining({ id: seeded.dm.dmCloserId }),
      rawSource: "alpha",
      rawMedium: "dana",
    });
  });
});

/**
 * A payment's deal, meeting and labels from its deal and its person
 * (docs/plans/phase-4-customers.md §6.4).
 */
describe("billing context from the person", () => {
  async function seedDeal() {
    const h = await bookingHarness();
    const seeded = await h.t.run(async (ctx) => {
      const { admin, closer } = await fixtureUsers(ctx, h.tenantId);
      const program = await insertProgram(ctx, h.tenantId, admin._id, "Program");
      const customer = await seedCustomer(ctx, h.tenantId, {
        closerId: closer._id,
        programId: program,
        paidAt: T0,
        fullName: "Copied Name",
        email: "copied@example.com",
      });
      return { ...customer, program, closerId: closer._id };
    });
    return { h, seeded };
  }

  it("shows the meeting of the deal's earliest payment that has one, then the deal's first meeting", async () => {
    const { h, seeded } = await seedDeal();
    const result = await h.t.run(async (ctx) => {
      // A later meeting on the deal becomes its latest, and the first payment's
      // meeting stays the deal's first; a payment on the later meeting comes next.
      const laterMeeting = await insertMeeting(ctx, {
        tenantId: h.tenantId,
        opportunityId: seeded.opportunityId,
        closerId: seeded.closerId,
        scheduledAt: T0 + 2 * DAY,
      });
      const earlyMeeting = await insertMeeting(ctx, {
        tenantId: h.tenantId,
        opportunityId: seeded.opportunityId,
        closerId: seeded.closerId,
        scheduledAt: T0 - 3 * DAY,
      });
      await ctx.db.patch("opportunities", seeded.opportunityId, { firstMeetingId: earlyMeeting });
      await insertDealPayment(ctx, {
        tenantId: h.tenantId,
        opportunityId: seeded.opportunityId,
        meetingId: laterMeeting,
        programId: seeded.program,
        recordedByUserId: seeded.closerId,
        recordedAt: T0 + 2 * DAY,
      });
      const additionalId = await insertDealPayment(ctx, {
        tenantId: h.tenantId,
        opportunityId: seeded.opportunityId,
        programId: seeded.program,
        recordedByUserId: seeded.closerId,
        recordedAt: T0 + 5 * DAY,
        origin: "closer_additional",
      });
      const additional = (await ctx.db.get("paymentRecords", additionalId))!;
      const context = await resolveBillingFromPerson(ctx, h.tenantId, additional);

      // With no payment meeting left on the deal, the deal's first meeting.
      for (const payment of await ctx.db
        .query("paymentRecords")
        .withIndex("by_opportunityId_and_recordedAt", (q) => q.eq("opportunityId", seeded.opportunityId))
        .take(10)) {
        await ctx.db.patch("paymentRecords", payment._id, { meetingId: undefined });
      }
      const withoutMeetings = await resolveBillingFromPerson(ctx, h.tenantId, additional);
      return { context, withoutMeetings, earlyMeeting };
    });

    expect(result.context.opportunity?._id).toBe(seeded.opportunityId);
    expect(result.context.meeting?._id).toBe(seeded.meetingId);
    expect(result.withoutMeetings.meeting?._id).toBe(result.earlyMeeting);
  });

  it("has no meeting for a side deal payment", async () => {
    const h = await bookingHarness();
    const context = await h.t.run(async (ctx) => {
      const { admin, closer } = await fixtureUsers(ctx, h.tenantId);
      const program = await insertProgram(ctx, h.tenantId, admin._id, "Program");
      const seeded = await seedCustomer(ctx, h.tenantId, {
        closerId: closer._id,
        programId: program,
        paidAt: T0,
        withMeeting: false,
      });
      const payment = (await ctx.db.get("paymentRecords", seeded.paymentId))!;
      return await resolveBillingFromPerson(ctx, h.tenantId, payment);
    });
    expect(context.opportunity).not.toBeNull();
    expect(context.meeting).toBeNull();
  });

  it("labels a payment with its person's current details", async () => {
    const { h, seeded } = await seedDeal();
    const labels = await h.t.run(async (ctx) => {
      await ctx.db.patch("leads", seeded.leadId, {
        fullName: "Current Name",
        email: "current@example.com",
        phone: "+15550000001",
      });
      const payment = (await ctx.db.get("paymentRecords", seeded.paymentId))!;
      const fromPerson = await resolveBillingFromPerson(ctx, h.tenantId, payment);
      return personBillingLabels(fromPerson.person);
    });
    expect(labels).toEqual({
      fullName: "Current Name",
      email: "current@example.com",
      phone: "+15550000001",
    });
  });

  it("names a person with no name by their email, as the customer copy did", async () => {
    const h = await bookingHarness();
    const labels = await h.t.run(async (ctx) => {
      const leadId = await insertPerson(ctx, h.tenantId, { email: "only@example.com" });
      return personBillingLabels((await ctx.db.get("leads", leadId))!);
    });
    expect(labels).toEqual({ fullName: "only@example.com", email: "only@example.com", phone: null });
  });
});

describe("billing rows", () => {
  it("name the person and resolve the meeting from the deal's payments, not the customer row", async () => {
    const h = await bookingHarness();
    const result = await h.t.run(async (ctx) => {
      const { admin, closer } = await fixtureUsers(ctx, h.tenantId);
      const program = await insertProgram(ctx, h.tenantId, admin._id, "Program");
      const seeded = await seedCustomer(ctx, h.tenantId, {
        closerId: closer._id,
        programId: program,
        paidAt: T0,
        fullName: "Copied Name",
      });
      await ctx.db.patch("leads", seeded.leadId, { fullName: "Current Name" });
      // A customer row that points elsewhere changes nothing billing shows.
      const otherDeal = await insertDeal(ctx, { tenantId: h.tenantId, leadId: seeded.leadId });
      const otherMeeting = await insertMeeting(ctx, {
        tenantId: h.tenantId,
        opportunityId: otherDeal,
        closerId: closer._id,
        scheduledAt: T0 - 9 * DAY,
      });
      await ctx.db.patch("customers", seeded.customerId, {
        winningOpportunityId: otherDeal,
        winningMeetingId: otherMeeting,
      });
      const additionalId = await insertDealPayment(ctx, {
        tenantId: h.tenantId,
        opportunityId: seeded.opportunityId,
        programId: program,
        recordedByUserId: closer._id,
        recordedAt: T0 + DAY,
        origin: "closer_additional",
      });
      const additional = (await ctx.db.get("paymentRecords", additionalId))!;
      const [row] = await enrichBillingPaymentRows(ctx, h.tenantId, [additional]);
      const [listRow] = await enrichBillingPaymentListRows(ctx, h.tenantId, [additional]);
      return { row, listRow, seeded };
    });

    expect(result.row.customer).toEqual({
      leadId: result.seeded.leadId,
      fullName: "Current Name",
      email: "customer@example.com",
      phone: null,
    });
    expect(result.listRow.customer.fullName).toBe("Current Name");
    expect(result.row.opportunity.id).toBe(result.seeded.opportunityId);
    expect(result.row.meeting.id).toBe(result.seeded.meetingId);
  });
});
