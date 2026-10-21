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
  customerFieldsFromEnrollments,
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
  it("shows no total rather than part of one past the derivation's limit, without failing", async () => {
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
    const fields = await fieldsFromEnrollments(harness, leadId);
    expect(fields).toMatchObject({ isCustomer: true, customerStatus: "active", convertedAt: T0 });
    expect(fields.totalPaidMinor).toBeUndefined();
    expect(fields.paymentCurrency).toBeUndefined();
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
});

describe("contact fields", () => {
  it("come from the person", async () => {
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

describe("search row rebuild", () => {
  async function seedRenamedCustomer(harness: Harness) {
    const { t, tenantId } = harness;
    return await t.run(async (ctx) => {
      const { admin, closer } = await fixtureUsers(ctx, tenantId);
      const program = await insertProgram(ctx, tenantId, admin._id, "Program");
      const seeded = await seedCustomer(ctx, tenantId, {
        closerId: closer._id, programId: program, paidAt: T0, fullName: "Old Name",
      });
      // A row from before the rename, then the person renamed.
      await ctx.db.insert("leadCustomerSearchRows", {
        tenantId, leadId: seeded.leadId, lifecycle: "customer",
        isSearchVisible: true, leadStatus: "converted", customerStatus: "active", displayName: "Old Name",
        searchText: "old name", opportunityCount: 1, wonOpportunityCount: 1, meetingCount: 1,
        latestActivityAt: T0, firstSeenAt: T0 - 3 * DAY, convertedAt: T0, updatedAt: T0,
      });
      await ctx.db.patch("leads", seeded.leadId, { fullName: "New Name" });
      await ctx.db.patch("enrollments", seeded.enrollmentId, { status: "paused" });
      await rebuildLeadCustomerSearchRow(ctx, tenantId, seeded.leadId);
      return seeded;
    });
  }

  async function searchRow(harness: Harness, leadId: Id<"leads">) {
    return await harness.t.run((ctx) =>
      ctx.db
        .query("leadCustomerSearchRows")
        .withIndex("by_tenantId_and_leadId", (q) => q.eq("tenantId", harness.tenantId).eq("leadId", leadId))
        .unique(),
    );
  }

  it("projects enrollments and the person", async () => {
    const harness = await bookingHarness();
    const seeded = await seedRenamedCustomer(harness);
    const row = await searchRow(harness, seeded.leadId);
    expect(row).toMatchObject({
      lifecycle: "customer",
      customerStatus: "paused",
      displayName: "New Name",
      convertedAt: T0,
      totalPaidMinor: 100_000,
      paymentCurrency: "USD",
    });
    expect(row?.searchText).not.toContain("old name");
  });
});
