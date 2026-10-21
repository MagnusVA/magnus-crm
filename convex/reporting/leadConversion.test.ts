/**
 * A conversion is a person's first enrollment: its deal is the winning deal,
 * and the recorder of its first payment is the closer when the deal has none
 * (docs/plans/phase-4-customers.md §6.3).
 */
import { describe, expect, it } from "vitest";
import { bookingHarness } from "../../tests/bookingHarness";
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
import { api } from "../_generated/api";
import { conversionsFromCustomers } from "../enrollments/customerCopy";
import { conversionsFromEnrollments } from "./leadConversion";

const MAY = { start: Date.parse("2026-05-01T00:00:00Z"), end: Date.parse("2026-06-01T00:00:00Z") };
const JUNE = { start: Date.parse("2026-06-01T00:00:00Z"), end: Date.parse("2026-07-01T00:00:00Z") };

describe("conversions from enrollments", () => {
  it("counts a person once, in the range of their first enrollment", async () => {
    const { t, tenantId } = await bookingHarness();
    const seeded = await t.run(async (ctx) => {
      const { admin, closer } = await fixtureUsers(ctx, tenantId);
      const first = await insertProgram(ctx, tenantId, admin._id, "First");
      const second = await insertProgram(ctx, tenantId, admin._id, "Second");
      const repeat = await seedCustomer(ctx, tenantId, {
        closerId: closer._id,
        programId: first,
        paidAt: Date.parse("2026-05-10T12:00:00Z"),
      });
      // The same person's second program, on a new deal in June.
      const secondDeal = await insertDeal(ctx, {
        tenantId,
        leadId: repeat.leadId,
        assignedCloserId: closer._id,
      });
      const secondPaidAt = Date.parse("2026-06-05T12:00:00Z");
      await insertPayment(ctx, {
        tenantId,
        opportunityId: secondDeal,
        programId: second,
        recordedByUserId: closer._id,
        recordedAt: secondPaidAt,
      });
      await insertEnrollment(ctx, {
        tenantId,
        leadId: repeat.leadId,
        programId: second,
        opportunityId: secondDeal,
        enrolledAt: secondPaidAt,
      });
      const fresh = await seedCustomer(ctx, tenantId, {
        closerId: closer._id,
        programId: second,
        paidAt: Date.parse("2026-06-20T12:00:00Z"),
      });
      return { repeat, fresh };
    });

    const may = await t.run((ctx) => conversionsFromEnrollments(ctx, tenantId, MAY.start, MAY.end));
    const june = await t.run((ctx) => conversionsFromEnrollments(ctx, tenantId, JUNE.start, JUNE.end));
    expect(may.conversions.map((conversion) => conversion.leadId)).toEqual([seeded.repeat.leadId]);
    expect(june.conversions.map((conversion) => conversion.leadId)).toEqual([seeded.fresh.leadId]);
    expect(june.isTruncated).toBe(false);
  });

  it("takes the winning deal from the enrollment and the closer from its first payment", async () => {
    const { t, tenantId } = await bookingHarness();
    const paidAt = Date.parse("2026-05-10T12:00:00Z");
    const seeded = await t.run(async (ctx) => {
      const { admin, closer } = await fixtureUsers(ctx, tenantId);
      const program = await insertProgram(ctx, tenantId, admin._id, "Program");
      const other = await insertProgram(ctx, tenantId, admin._id, "Other");
      const leadId = await insertPerson(ctx, tenantId, { fullName: "No closer", status: "converted" });
      // A deal with no working owner, so the report falls back to the recorder.
      const dealId = await insertDeal(ctx, { tenantId, leadId });
      // Same deal and time, but another program and a disputed payment:
      // neither is the enrollment's first payment.
      await insertPayment(ctx, {
        tenantId,
        opportunityId: dealId,
        programId: other,
        recordedByUserId: admin._id,
        recordedAt: paidAt,
      });
      await insertPayment(ctx, {
        tenantId,
        opportunityId: dealId,
        programId: program,
        recordedByUserId: admin._id,
        recordedAt: paidAt,
        status: "disputed",
      });
      await insertPayment(ctx, {
        tenantId,
        opportunityId: dealId,
        programId: program,
        recordedByUserId: closer._id,
        recordedAt: paidAt,
      });
      await insertPayment(ctx, {
        tenantId,
        opportunityId: dealId,
        programId: program,
        recordedByUserId: admin._id,
        recordedAt: paidAt + DAY,
      });
      await insertEnrollment(ctx, { tenantId, leadId, programId: program, opportunityId: dealId, enrolledAt: paidAt });
      return { leadId, dealId, closerId: closer._id };
    });

    const { conversions } = await t.run((ctx) =>
      conversionsFromEnrollments(ctx, tenantId, MAY.start, MAY.end),
    );
    expect(conversions).toEqual([
      {
        leadId: seeded.leadId,
        convertedAt: paidAt,
        winningOpportunityId: seeded.dealId,
        convertedByUserId: seeded.closerId,
      },
    ]);
  });

  it("matches the customer rows on data where both agree", async () => {
    const { t, tenantId } = await bookingHarness();
    await t.run(async (ctx) => {
      const { admin, closer } = await fixtureUsers(ctx, tenantId);
      const program = await insertProgram(ctx, tenantId, admin._id, "Program");
      await seedCustomer(ctx, tenantId, { closerId: closer._id, programId: program, paidAt: T0 });
      await seedCustomer(ctx, tenantId, {
        closerId: closer._id,
        recorderId: admin._id,
        programId: program,
        paidAt: T0 + DAY,
        withMeeting: false,
        assignedCloserId: null,
      });
    });

    const fromCustomers = await t.run((ctx) => conversionsFromCustomers(ctx, tenantId, MAY.start, MAY.end));
    const fromEnrollments = await t.run((ctx) =>
      conversionsFromEnrollments(ctx, tenantId, MAY.start, MAY.end),
    );
    expect(fromCustomers.conversions).toHaveLength(2);
    expect(fromEnrollments).toEqual(fromCustomers);
  });
});

describe("Leads & Conversions report", () => {
  it("counts first enrollments, including a person with no customer row", async () => {
    const harness = await bookingHarness();
    const { t, tenantId } = harness;
    await t.run(async (ctx) => {
      const { admin, closer } = await fixtureUsers(ctx, tenantId);
      const program = await insertProgram(ctx, tenantId, admin._id, "Program");
      const second = await insertProgram(ctx, tenantId, admin._id, "Second");
      const seeded = await seedCustomer(ctx, tenantId, { closerId: closer._id, programId: program, paidAt: T0 });
      // The same person's second program in the same month counts nothing.
      const secondDeal = await insertDeal(ctx, { tenantId, leadId: seeded.leadId, assignedCloserId: closer._id });
      await insertPayment(ctx, {
        tenantId, opportunityId: secondDeal, programId: second, recordedByUserId: closer._id, recordedAt: T0 + DAY,
      });
      await insertEnrollment(ctx, {
        tenantId, leadId: seeded.leadId, programId: second, opportunityId: secondDeal, enrolledAt: T0 + DAY,
      });
      // A person with an enrollment and no customer row counts once.
      const leadId = await insertPerson(ctx, tenantId, { fullName: "No email", status: "converted" });
      const dealId = await insertDeal(ctx, { tenantId, leadId, assignedCloserId: closer._id });
      await insertPayment(ctx, {
        tenantId, opportunityId: dealId, programId: program, recordedByUserId: closer._id, recordedAt: T0 + 2 * DAY,
      });
      await insertEnrollment(ctx, { tenantId, leadId, programId: program, opportunityId: dealId, enrolledAt: T0 + 2 * DAY });
    });

    const report = await harness.admin.query(api.reporting.leadConversion.getLeadConversionMetrics, {
      startDate: MAY.start,
      endDate: MAY.end,
    });
    expect(report).toMatchObject({
      totalConversions: 2,
      excludedConversions: 0,
      meetingsPerSaleNumerator: 1,
      meetingsPerSaleDenominator: 1,
      timeToConversionSampleCount: 2,
      isConversionDataTruncated: false,
    });
    expect(report.byCloser).toEqual([expect.objectContaining({ conversions: 2 })]);
  });
});
