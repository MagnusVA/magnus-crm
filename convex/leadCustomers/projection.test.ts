/**
 * The customer fields of a person's search row, from their enrollments and the
 * payments on their deals (docs/plans/phase-4-customers.md §6.1).
 */
import { describe, expect, it } from "vitest";
import type { Id } from "../_generated/dataModel";
import { bookingHarness } from "../../tests/bookingHarness";
import { ENROLLMENT_PAYMENTS_PER_DEAL_LIMIT } from "../lib/enrollments";
import {
  DAY,
  T0,
  fixtureUsers,
  insertDeal,
  insertEnrollment,
  insertPayment,
  insertPerson,
  insertProgram,
  seedCustomer,
} from "../../tests/enrollmentReadFixtures";
import {
  customerFieldsFromCustomerRow,
  customerFieldsFromEnrollments,
  latestActivityFor,
  loadPersonDeals,
  personContact,
  rebuildLeadCustomerSearchRow,
} from "./projection";

type Harness = Awaited<ReturnType<typeof bookingHarness>>;

async function fieldsFromEnrollments(harness: Harness, leadId: Id<"leads">) {
  return await harness.t.run(async (ctx) => {
    const deals = await loadPersonDeals(ctx, harness.tenantId, leadId);
    return await customerFieldsFromEnrollments(ctx, harness.tenantId, leadId, deals);
  });
}

describe("customer fields from enrollments", () => {
  it("throws rather than total part of a deal's payments past the derivation's limit", async () => {
    const harness = await bookingHarness();
    const { t, tenantId } = harness;
    const leadId = await t.run(async (ctx) => {
      const { admin, closer } = await fixtureUsers(ctx, tenantId);
      const programId = await insertProgram(ctx, tenantId, admin._id, "First");
      const seeded = await seedCustomer(ctx, tenantId, {
        closerId: closer._id,
        programId,
        paidAt: T0,
        amountMinor: 1_000,
      });
      const dealId = await insertDeal(ctx, { tenantId, leadId: seeded.leadId, assignedCloserId: closer._id });
      for (let index = 0; index <= ENROLLMENT_PAYMENTS_PER_DEAL_LIMIT; index += 1) {
        await insertPayment(ctx, {
          tenantId, opportunityId: dealId, programId, recordedByUserId: closer._id,
          recordedAt: T0 + (index + 1) * DAY, amountMinor: 1_000,
        });
      }
      return seeded.leadId;
    });
    await expect(fieldsFromEnrollments(harness, leadId)).rejects.toThrow(
      `more than ${ENROLLMENT_PAYMENTS_PER_DEAL_LIMIT} payments`,
    );
  });

  it("sums the person's payments that aren't disputed, across deals and programs", async () => {
    const harness = await bookingHarness();
    const { t, tenantId } = harness;
    const leadId = await t.run(async (ctx) => {
      const { admin, closer } = await fixtureUsers(ctx, tenantId);
      const first = await insertProgram(ctx, tenantId, admin._id, "First");
      const second = await insertProgram(ctx, tenantId, admin._id, "Second");
      const seeded = await seedCustomer(ctx, tenantId, {
        closerId: closer._id,
        programId: first,
        paidAt: T0,
        amountMinor: 50_000,
      });
      await ctx.db.patch("enrollments", seeded.enrollmentId, { status: "paused" });
      const dealId = await insertDeal(ctx, { tenantId, leadId: seeded.leadId, assignedCloserId: closer._id });
      await insertPayment(ctx, {
        tenantId, opportunityId: dealId, programId: second, recordedByUserId: closer._id,
        recordedAt: T0 + 3 * DAY, amountMinor: 20_000,
      });
      await insertPayment(ctx, {
        tenantId, opportunityId: dealId, programId: second, recordedByUserId: closer._id,
        recordedAt: T0 + 9 * DAY, amountMinor: 70_000, status: "disputed",
      });
      await insertEnrollment(ctx, {
        tenantId, leadId: seeded.leadId, programId: second, opportunityId: dealId, enrolledAt: T0 + 3 * DAY,
      });
      return seeded.leadId;
    });

    expect(await fieldsFromEnrollments(harness, leadId)).toEqual({
      isCustomer: true,
      customerStatus: "active",
      totalPaidMinor: 70_000,
      paymentCurrency: "USD",
      convertedAt: T0,
      latestPaymentAt: T0 + 3 * DAY,
    });
  });

  it("shows paused when no enrollment is active, and no currency when they differ", async () => {
    const harness = await bookingHarness();
    const { t, tenantId } = harness;
    const leadId = await t.run(async (ctx) => {
      const { admin, closer } = await fixtureUsers(ctx, tenantId);
      const first = await insertProgram(ctx, tenantId, admin._id, "First");
      const second = await insertProgram(ctx, tenantId, admin._id, "Second");
      const seeded = await seedCustomer(ctx, tenantId, { closerId: closer._id, programId: first, paidAt: T0 });
      await ctx.db.patch("enrollments", seeded.enrollmentId, { status: "churned" });
      await insertPayment(ctx, {
        tenantId, opportunityId: seeded.opportunityId, programId: second, recordedByUserId: closer._id,
        recordedAt: T0 + DAY, currency: "EUR",
      });
      await insertEnrollment(ctx, {
        tenantId, leadId: seeded.leadId, programId: second, opportunityId: seeded.opportunityId,
        enrolledAt: T0 + DAY, status: "paused",
      });
      return seeded.leadId;
    });

    const fields = await fieldsFromEnrollments(harness, leadId);
    expect(fields).toMatchObject({ customerStatus: "paused", totalPaidMinor: 200_000 });
    expect(fields.paymentCurrency).toBeUndefined();
  });

  it("leaves a person with no enrollment without customer fields", async () => {
    const harness = await bookingHarness();
    const { t, tenantId } = harness;
    const leadId = await t.run(async (ctx) => {
      const { admin, closer } = await fixtureUsers(ctx, tenantId);
      const program = await insertProgram(ctx, tenantId, admin._id, "Program");
      const leadId = await insertPerson(ctx, tenantId, { fullName: "Voided" });
      const dealId = await insertDeal(ctx, { tenantId, leadId, assignedCloserId: closer._id, status: "lost" });
      await insertPayment(ctx, {
        tenantId, opportunityId: dealId, programId: program, recordedByUserId: closer._id,
        recordedAt: T0, status: "disputed",
      });
      return leadId;
    });

    expect(await fieldsFromEnrollments(harness, leadId)).toEqual({
      isCustomer: false,
      customerStatus: undefined,
      totalPaidMinor: undefined,
      paymentCurrency: undefined,
      convertedAt: undefined,
      latestPaymentAt: undefined,
    });
  });

  it("agrees with the customer row where the two are consistent", async () => {
    const harness = await bookingHarness();
    const { t, tenantId } = harness;
    const result = await t.run(async (ctx) => {
      const { admin, closer } = await fixtureUsers(ctx, tenantId);
      const program = await insertProgram(ctx, tenantId, admin._id, "Program");
      const seeded = await seedCustomer(ctx, tenantId, { closerId: closer._id, programId: program, paidAt: T0 });
      const lead = (await ctx.db.get("leads", seeded.leadId))!;
      const deals = await loadPersonDeals(ctx, tenantId, seeded.leadId);
      const fromCustomer = await customerFieldsFromCustomerRow(ctx, tenantId, seeded.leadId);
      const fromEnrollments = await customerFieldsFromEnrollments(ctx, tenantId, seeded.leadId, deals);
      return {
        customerId: seeded.customerId,
        fromCustomer,
        fromEnrollments,
        activity: [
          latestActivityFor(lead, fromCustomer.fields, deals),
          latestActivityFor(lead, fromEnrollments, deals),
        ],
      };
    });

    expect(result.fromCustomer.customer?._id).toBe(result.customerId);
    expect(result.fromEnrollments).toEqual(result.fromCustomer.fields);
    expect(result.activity[1]).toBe(result.activity[0]);
  });
});

describe("contact fields", () => {
  it("come from the person, whatever the customer copy says", async () => {
    const harness = await bookingHarness();
    const contact = await harness.t.run(async (ctx) => {
      const leadId = await insertPerson(ctx, harness.tenantId, { email: "only@example.com", phone: "+15550000000" });
      return personContact((await ctx.db.get("leads", leadId))!);
    });
    expect(contact).toEqual({
      displayName: "only@example.com",
      email: "only@example.com",
      phone: "+15550000000",
    });
  });
});

describe("search row rebuild before the readers switch", () => {
  it("still projects the customer row and its copy", async () => {
    const harness = await bookingHarness();
    const { t, tenantId } = harness;
    const { row, customerId } = await t.run(async (ctx) => {
      const { admin, closer } = await fixtureUsers(ctx, tenantId);
      const program = await insertProgram(ctx, tenantId, admin._id, "Program");
      const seeded = await seedCustomer(ctx, tenantId, {
        closerId: closer._id, programId: program, paidAt: T0, fullName: "Old Name",
      });
      await ctx.db.patch("leads", seeded.leadId, { fullName: "New Name" });
      await rebuildLeadCustomerSearchRow(ctx, tenantId, seeded.leadId);
      const row = await ctx.db
        .query("leadCustomerSearchRows")
        .withIndex("by_tenantId_and_leadId", (q) => q.eq("tenantId", tenantId).eq("leadId", seeded.leadId))
        .unique();
      return { row, customerId: seeded.customerId };
    });

    expect(row).toMatchObject({
      customerId,
      lifecycle: "customer",
      customerStatus: "active",
      displayName: "Old Name",
      convertedAt: T0,
      totalPaidMinor: 100_000,
      paymentCurrency: "USD",
    });
  });
});
