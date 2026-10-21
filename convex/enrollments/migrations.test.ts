import { afterEach, describe, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { writePersonEnrollments } from "../lib/enrollments";
import { customerConversions } from "../reporting/aggregates";
import {
  enrollmentHarness,
  enrollmentsOf,
  insertCustomer,
  insertDeal,
  insertEnrollment,
  insertPayment,
  insertPerson,
  insertProgram,
  type EnrollmentHarness,
} from "../../tests/enrollmentFixtures";

// The enrollment health checks (docs/plans/phase-4-customers.md §10.2) and
// the PR 4 clears and deletion (§10.5), against people, payments and
// customer rows as production holds them.

afterEach(() => vi.useRealTimers());

const T1 = Date.parse("2026-05-01T10:00:00Z");
const T2 = Date.parse("2026-06-01T10:00:00Z");
const T3 = Date.parse("2026-07-01T10:00:00Z");
const T4 = Date.parse("2026-08-01T10:00:00Z");

/**
 * Three customers: one active, one paused, and one churned who bought a
 * second program on a second deal. Their enrollments are written from their
 * payments, and the statuses set as an admin would.
 */
async function seed(harness: EnrollmentHarness) {
  return await harness.t.run(async (ctx) => {
    const { tenantId } = harness;
    const programA = await insertProgram(ctx, tenantId, "A");
    const programB = await insertProgram(ctx, tenantId, "B");
    const programC = await insertProgram(ctx, tenantId, "C");

    const active = await insertPerson(ctx, tenantId);
    const activeDeal = await insertDeal(ctx, tenantId, active);
    const activePayment = await insertPayment(ctx, { tenantId, opportunityId: activeDeal, programId: programA, recordedAt: T1 });
    await insertPayment(ctx, { tenantId, opportunityId: activeDeal, programId: programA, recordedAt: T2 });

    const paused = await insertPerson(ctx, tenantId);
    const pausedDeal = await insertDeal(ctx, tenantId, paused);
    await insertPayment(ctx, { tenantId, opportunityId: pausedDeal, programId: programB, recordedAt: T2 });

    const churned = await insertPerson(ctx, tenantId);
    const churnedDeal = await insertDeal(ctx, tenantId, churned);
    const secondDeal = await insertDeal(ctx, tenantId, churned);
    await insertPayment(ctx, { tenantId, opportunityId: churnedDeal, programId: programA, recordedAt: T1 });
    const secondPayment = await insertPayment(ctx, { tenantId, opportunityId: secondDeal, programId: programB, recordedAt: T3 });

    for (const leadId of [active, paused, churned]) {
      await writePersonEnrollments(ctx, { tenantId, leadId });
    }
    const [pausedEnrollment] = await ctx.db
      .query("enrollments")
      .withIndex("by_tenantId_and_leadId_and_programId", (q) => q.eq("tenantId", tenantId).eq("leadId", paused))
      .take(1);
    await ctx.db.patch("enrollments", pausedEnrollment._id, { status: "paused", statusChangedAt: T3 });
    const churnedEnrollment = (await ctx.db
      .query("enrollments")
      .withIndex("by_tenantId_and_leadId_and_programId", (q) =>
        q.eq("tenantId", tenantId).eq("leadId", churned).eq("programId", programA),
      )
      .first())!;
    await ctx.db.patch("enrollments", churnedEnrollment._id, { status: "churned", statusChangedAt: T4 });

    return {
      programA, programB, programC,
      active, activeDeal, activePayment,
      paused, pausedDeal,
      churned, churnedDeal, secondDeal, secondPayment,
    };
  });
}

async function enrolled() {
  const harness = await enrollmentHarness();
  const ids = await seed(harness);
  return { harness, ids };
}

async function firstEnrollment(harness: EnrollmentHarness, leadId: Doc<"enrollments">["leadId"]) {
  return (await enrollmentsOf(harness, leadId))[0];
}

describe("assertEnrollments", () => {
  it("passes on enrollments derived from the payments, whatever their status", async () => {
    const { harness } = await enrolled();
    expect((await harness.run("assertEnrollments"))?.error).toBeUndefined();
    expect((await harness.run("assertPaymentEnrollments"))?.error).toBeUndefined();
  });

  it("names an enrollment that doesn't re-derive to its first payment's deal and time", async () => {
    const { harness, ids } = await enrolled();
    const enrollment = await firstEnrollment(harness, ids.active);
    await harness.t.run((ctx) => ctx.db.patch("enrollments", enrollment._id, { enrolledAt: T2 }));

    let error = (await harness.run("assertEnrollments"))?.error;
    expect(error).toContain(enrollment._id);
    expect(error).toContain(`expected ${ids.activeDeal} at ${T1}`);

    await harness.t.run((ctx) =>
      ctx.db.patch("enrollments", enrollment._id, { enrolledAt: T1, opportunityId: ids.pausedDeal }),
    );
    error = (await harness.rerun("assertEnrollments"))?.error;
    expect(error).toContain(enrollment._id);
    expect(error).toContain(`expected ${ids.activeDeal} at ${T1}`);
  });

  it("names an enrollment with no payment behind it", async () => {
    const { harness, ids } = await enrolled();
    const enrollmentId = await harness.t.run((ctx) =>
      insertEnrollment(ctx, {
        tenantId: harness.tenantId, leadId: ids.active, programId: ids.programC, opportunityId: ids.activeDeal, enrolledAt: T3,
      }),
    );

    const error = (await harness.run("assertEnrollments"))?.error;
    expect(error).toContain(enrollmentId);
    expect(error).toContain("no payment");
  });

  it("names a second enrollment for the same person and program", async () => {
    const { harness, ids } = await enrolled();
    await harness.t.run((ctx) =>
      insertEnrollment(ctx, {
        tenantId: harness.tenantId, leadId: ids.paused, programId: ids.programB, opportunityId: ids.pausedDeal, enrolledAt: T2, status: "paused",
      }),
    );

    const error = (await harness.run("assertEnrollments"))?.error;
    expect(error).toContain(ids.paused);
    expect(error).toContain(ids.programB);
    expect(error).toContain("2 enrollments");
  });

  it.each(["active", "merged"] as const)("names an enrollment whose person is %s", async (status) => {
    const { harness, ids } = await enrolled();
    await harness.t.run((ctx) => ctx.db.patch("leads", ids.active, { status }));

    const error = (await harness.run("assertEnrollments"))?.error;
    expect(error).toContain(ids.active);
    expect(error).toContain(`is ${status}`);
  });
});

describe("assertPaymentEnrollments", () => {
  it("names a payment with no enrollment for its person and program", async () => {
    const { harness, ids } = await enrolled();
    const [, second] = await enrollmentsOf(harness, ids.churned);
    await harness.t.run((ctx) => ctx.db.delete("enrollments", second._id));

    const error = (await harness.run("assertPaymentEnrollments"))?.error;
    expect(error).toContain(ids.secondPayment);
    expect(error).toContain(ids.churned);
    expect(error).toContain(ids.programB);
  });

  it("names a payment recorded before its enrollment", async () => {
    const { harness, ids } = await enrolled();
    const enrollment = await firstEnrollment(harness, ids.active);
    await harness.t.run((ctx) => ctx.db.patch("enrollments", enrollment._id, { enrolledAt: T1 + 1 }));

    const error = (await harness.run("assertPaymentEnrollments"))?.error;
    expect(error).toContain(ids.activePayment);
    expect(error).toContain(enrollment._id);
  });

  it("skips disputed payments and payments with no deal", async () => {
    const { harness, ids } = await enrolled();
    await harness.t.run(async (ctx) => {
      const { tenantId } = harness;
      await insertPayment(ctx, { tenantId, opportunityId: ids.activeDeal, programId: ids.programC, recordedAt: T1, status: "disputed" });
      const noDeal = await insertPayment(ctx, { tenantId, opportunityId: ids.activeDeal, programId: ids.programC, recordedAt: T1 });
      await ctx.db.patch("paymentRecords", noDeal, { opportunityId: undefined });
    });

    expect((await harness.run("assertPaymentEnrollments"))?.error).toBeUndefined();
  });
});

/** The customer rows and payment links of the three customers, as production holds them before the clear. */
async function withCustomerRows(harness: EnrollmentHarness, ids: Awaited<ReturnType<typeof seed>>) {
  return await harness.t.run(async (ctx) => {
    const { tenantId } = harness;
    const customers = [
      await insertCustomer(ctx, { tenantId, leadId: ids.active, opportunityId: ids.activeDeal, programId: ids.programA, convertedAt: T1 }),
      await insertCustomer(ctx, { tenantId, leadId: ids.paused, opportunityId: ids.pausedDeal, programId: ids.programB, convertedAt: T2 }),
      await insertCustomer(ctx, { tenantId, leadId: ids.churned, opportunityId: ids.churnedDeal, programId: ids.programA, convertedAt: T1 }),
    ];
    const byLead = new Map([[ids.active, customers[0]], [ids.paused, customers[1]], [ids.churned, customers[2]]]);
    for (const payment of await ctx.db.query("paymentRecords").take(100)) {
      const deal = (await ctx.db.get("opportunities", payment.opportunityId!))!;
      await ctx.db.patch("paymentRecords", payment._id, { customerId: byLead.get(deal.leadId), contextType: "opportunity" });
    }
    for (const customerId of customers) {
      await customerConversions.insert(ctx, (await ctx.db.get("customers", customerId))!);
    }
    return customers;
  });
}

async function everything(harness: EnrollmentHarness) {
  return await harness.t.run(async (ctx) => ({
    leads: await ctx.db.query("leads").take(100),
    opportunities: await ctx.db.query("opportunities").take(100),
    enrollments: await ctx.db.query("enrollments").take(100),
    events: await ctx.db.query("domainEvents").take(100),
    stats: await ctx.db.query("tenantStats").take(10),
    searchRows: await ctx.db.query("leadCustomerSearchRows").take(100),
  }));
}

describe("clearPaymentCustomerFields", () => {
  it("unsets customerId and contextType on every payment, and its assert names one left", async () => {
    const { harness, ids } = await enrolled();
    await withCustomerRows(harness, ids);
    const paymentsBefore = await harness.t.run((ctx) => ctx.db.query("paymentRecords").take(100));
    const before = await everything(harness);

    const failed = (await harness.run("assertPaymentCustomerFieldsCleared"))?.error;
    expect(failed).toContain("still has its customerId or contextType");
    expect(paymentsBefore.some((payment) => failed?.includes(payment._id))).toBe(true);

    await harness.t.mutation(internal.migrations.run, { fn: "migrations:clearPaymentCustomerFields", dryRun: true });
    expect(await harness.t.run((ctx) => ctx.db.query("paymentRecords").take(100))).toEqual(paymentsBefore);

    expect((await harness.run("clearPaymentCustomerFields"))?.error).toBeUndefined();
    const paymentsAfter = await harness.t.run((ctx) => ctx.db.query("paymentRecords").take(100));
    expect(paymentsAfter).toEqual(
      paymentsBefore.map(({ customerId: _customerId, contextType: _contextType, ...rest }) => rest),
    );
    expect(await everything(harness)).toEqual(before);
    expect((await harness.rerun("assertPaymentCustomerFieldsCleared"))?.error).toBeUndefined();

    // A rerun finds nothing to write.
    expect((await harness.rerun("clearPaymentCustomerFields"))?.error).toBeUndefined();
    expect(await harness.t.run((ctx) => ctx.db.query("paymentRecords").take(100))).toEqual(paymentsAfter);
    // The enrollments still check out against the payments.
    expect((await harness.run("assertPaymentEnrollments"))?.error).toBeUndefined();
  });
});

describe("deleteCustomers", () => {
  it("deletes every customer row and nothing else, and its assert names one left", async () => {
    const { harness, ids } = await enrolled();
    const customers = await withCustomerRows(harness, ids);
    const before = await everything(harness);

    const failed = (await harness.run("assertCustomersDeleted"))?.error;
    expect(customers.some((customerId) => failed?.includes(customerId))).toBe(true);

    expect((await harness.run("deleteCustomers"))?.error).toBeUndefined();
    expect(await harness.t.run((ctx) => ctx.db.query("customers").take(10))).toEqual([]);
    expect(await everything(harness)).toEqual(before);
    expect((await harness.rerun("assertCustomersDeleted"))?.error).toBeUndefined();
    expect((await harness.run("assertEnrollments"))?.error).toBeUndefined();
  });
});

describe("clearCustomerConversions", () => {
  it("counts on a dry run, then empties each tenant's namespace", async () => {
    const { harness, ids } = await enrolled();
    await withCustomerRows(harness, ids);
    const count = () => harness.t.run((ctx) => customerConversions.count(ctx, { namespace: harness.tenantId }));
    expect(await count()).toBe(3);

    expect(await harness.t.mutation(internal.migrations.clearCustomerConversions, { dryRun: true })).toEqual({
      namespaces: 1, entries: 3, cleared: false,
    });
    expect(await count()).toBe(3);

    expect(await harness.t.mutation(internal.migrations.clearCustomerConversions, {})).toEqual({
      namespaces: 1, entries: 3, cleared: true,
    });
    expect(await count()).toBe(0);
    expect(await harness.t.mutation(internal.migrations.clearCustomerConversions, {})).toEqual({
      namespaces: 1, entries: 0, cleared: true,
    });
  });
});

