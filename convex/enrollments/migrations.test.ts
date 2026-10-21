import { afterEach, describe, expect, it, vi } from "vitest";
import type { Doc } from "../_generated/dataModel";
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

// The PR 1 backfill and its two asserts (docs/plans/phase-4-customers.md
// §10.1, §10.2), against customers and payments as production holds them.

afterEach(() => vi.useRealTimers());

const T1 = Date.parse("2026-05-01T10:00:00Z");
const T2 = Date.parse("2026-06-01T10:00:00Z");
const T3 = Date.parse("2026-07-01T10:00:00Z");
const T4 = Date.parse("2026-08-01T10:00:00Z");

/**
 * Three customers: one active, one paused, and one churned who bought a
 * second program on a second deal. Each customer row holds the program and
 * time of its person's first payment.
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
    const activeCustomer = await insertCustomer(ctx, { tenantId, leadId: active, opportunityId: activeDeal, programId: programA, convertedAt: T1 });

    const paused = await insertPerson(ctx, tenantId);
    const pausedDeal = await insertDeal(ctx, tenantId, paused);
    await insertPayment(ctx, { tenantId, opportunityId: pausedDeal, programId: programB, recordedAt: T2 });
    const pausedCustomer = await insertCustomer(ctx, {
      tenantId, leadId: paused, opportunityId: pausedDeal, programId: programB, convertedAt: T2, status: "paused", pausedAt: T3,
    });

    const churned = await insertPerson(ctx, tenantId);
    const churnedDeal = await insertDeal(ctx, tenantId, churned);
    const secondDeal = await insertDeal(ctx, tenantId, churned);
    await insertPayment(ctx, { tenantId, opportunityId: churnedDeal, programId: programA, recordedAt: T1 });
    const secondPayment = await insertPayment(ctx, { tenantId, opportunityId: secondDeal, programId: programB, recordedAt: T3 });
    const churnedCustomer = await insertCustomer(ctx, {
      tenantId, leadId: churned, opportunityId: churnedDeal, programId: programA, convertedAt: T1, status: "churned", churnedAt: T4,
    });

    return {
      programA, programB, programC,
      active, activeDeal, activePayment, activeCustomer,
      paused, pausedDeal, pausedCustomer,
      churned, churnedDeal, secondDeal, secondPayment, churnedCustomer,
    };
  });
}

async function backfilled() {
  const harness = await enrollmentHarness();
  const ids = await seed(harness);
  expect((await harness.run("backfillEnrollments"))?.error).toBeUndefined();
  return { harness, ids };
}

async function allEnrollments(harness: EnrollmentHarness) {
  return await harness.t.run((ctx) => ctx.db.query("enrollments").take(100));
}

async function firstEnrollment(harness: EnrollmentHarness, leadId: Doc<"enrollments">["leadId"]) {
  return (await enrollmentsOf(harness, leadId))[0];
}

describe("backfillEnrollments", () => {
  it("enrolls each customer's person from their payments and carries the customer's status", async () => {
    const { harness, ids } = await backfilled();
    const backfilledAt = Date.parse("2026-10-20T12:00:00Z");

    expect(await enrollmentsOf(harness, ids.active)).toMatchObject([
      { programId: ids.programA, opportunityId: ids.activeDeal, enrolledAt: T1, status: "active", createdAt: backfilledAt },
    ]);
    expect(await enrollmentsOf(harness, ids.paused)).toMatchObject([
      { programId: ids.programB, opportunityId: ids.pausedDeal, enrolledAt: T2, status: "paused", statusChangedAt: T3 },
    ]);
    expect(await enrollmentsOf(harness, ids.churned)).toMatchObject([
      { programId: ids.programA, opportunityId: ids.churnedDeal, enrolledAt: T1, status: "churned", statusChangedAt: T4 },
      { programId: ids.programB, opportunityId: ids.secondDeal, enrolledAt: T3, status: "active" },
    ]);
    const enrollments = await allEnrollments(harness);
    expect(enrollments).toHaveLength(4);
    // No admin changed a status, so none names one.
    expect(enrollments.every((row) => row.statusChangedByUserId === undefined)).toBe(true);
    // The active customer's enrollment was never changed.
    expect((await firstEnrollment(harness, ids.active)).statusChangedAt).toBeUndefined();
  });

  it("changes nothing when it runs again", async () => {
    const { harness } = await backfilled();
    const before = await allEnrollments(harness);
    vi.setSystemTime(new Date("2026-10-21T12:00:00Z"));

    expect((await harness.rerun("backfillEnrollments"))?.error).toBeUndefined();

    expect(await allEnrollments(harness)).toEqual(before);
  });

  it("writes no event, counter or stage", async () => {
    const harness = await enrollmentHarness();
    const ids = await seed(harness);
    const snapshot = () =>
      harness.t.run(async (ctx) => ({
        leads: await Promise.all([ids.active, ids.paused, ids.churned].map((id) => ctx.db.get("leads", id))),
        events: await ctx.db.query("domainEvents").take(10),
        stats: await ctx.db.query("tenantStats").take(10),
      }));
    const before = await snapshot();

    expect((await harness.run("backfillEnrollments"))?.error).toBeUndefined();
    expect(await snapshot()).toEqual(before);
  });

  it("stops on a customer whose program has no payment behind it", async () => {
    const harness = await enrollmentHarness();
    const ids = await seed(harness);
    await harness.t.run((ctx) => ctx.db.patch("customers", ids.pausedCustomer, { programId: ids.programC }));

    const error = (await harness.run("backfillEnrollments"))?.error;
    expect(error).toContain(ids.pausedCustomer);
    expect(error).toContain(ids.programC);
  });
});

describe("assertEnrollments", () => {
  it("passes on the backfill", async () => {
    const { harness } = await backfilled();
    expect((await harness.run("assertEnrollments"))?.error).toBeUndefined();
    expect((await harness.run("assertPaymentEnrollments"))?.error).toBeUndefined();
  });

  it("names an enrollment that doesn't re-derive to its first payment's deal and time", async () => {
    const { harness, ids } = await backfilled();
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
    const { harness, ids } = await backfilled();
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
    const { harness, ids } = await backfilled();
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
    const { harness, ids } = await backfilled();
    await harness.t.run((ctx) => ctx.db.patch("leads", ids.active, { status }));

    const error = (await harness.run("assertEnrollments"))?.error;
    expect(error).toContain(ids.active);
    expect(error).toContain(`is ${status}`);
  });

  it("names an enrollment whose status isn't its customer row's", async () => {
    const { harness, ids } = await backfilled();
    const enrollment = await firstEnrollment(harness, ids.churned);
    await harness.t.run((ctx) => ctx.db.patch("enrollments", enrollment._id, { status: "active" }));

    const error = (await harness.run("assertEnrollments"))?.error;
    expect(error).toContain(enrollment._id);
    expect(error).toContain(ids.churnedCustomer);
    expect(error).toContain("churned");
  });

  it("ignores the status of an enrollment in another program than the customer row's", async () => {
    const { harness, ids } = await backfilled();
    const [, second] = await enrollmentsOf(harness, ids.churned);
    await harness.t.run((ctx) => ctx.db.patch("enrollments", second._id, { status: "paused" }));

    expect((await harness.run("assertEnrollments"))?.error).toBeUndefined();
  });

  it("names a first enrollment whose time isn't the customer's conversion", async () => {
    const { harness, ids } = await backfilled();
    await harness.t.run((ctx) => ctx.db.patch("customers", ids.pausedCustomer, { convertedAt: T3 }));

    const error = (await harness.run("assertEnrollments"))?.error;
    expect(error).toContain((await firstEnrollment(harness, ids.paused))._id);
    expect(error).toContain(ids.pausedCustomer);
    expect(error).toContain(`${T3}`);
  });

  it("names a person whose customer row's program has no enrollment", async () => {
    const { harness, ids } = await backfilled();
    await harness.t.run((ctx) => ctx.db.patch("customers", ids.activeCustomer, { programId: ids.programC }));

    const error = (await harness.run("assertEnrollments"))?.error;
    expect(error).toContain(ids.activeCustomer);
    expect(error).toContain(ids.programC);
  });

  it("checks no customer row once the person has none", async () => {
    const { harness, ids } = await backfilled();
    const enrollment = await firstEnrollment(harness, ids.churned);
    await harness.t.run(async (ctx) => {
      await ctx.db.delete("customers", ids.churnedCustomer);
      await ctx.db.patch("enrollments", enrollment._id, { status: "active" });
    });

    expect((await harness.run("assertEnrollments"))?.error).toBeUndefined();
  });
});

describe("assertPaymentEnrollments", () => {
  it("names a payment with no enrollment for its person and program", async () => {
    const { harness, ids } = await backfilled();
    const [, second] = await enrollmentsOf(harness, ids.churned);
    await harness.t.run((ctx) => ctx.db.delete("enrollments", second._id));

    const error = (await harness.run("assertPaymentEnrollments"))?.error;
    expect(error).toContain(ids.secondPayment);
    expect(error).toContain(ids.churned);
    expect(error).toContain(ids.programB);
  });

  it("names a payment recorded before its enrollment", async () => {
    const { harness, ids } = await backfilled();
    const enrollment = await firstEnrollment(harness, ids.active);
    await harness.t.run((ctx) => ctx.db.patch("enrollments", enrollment._id, { enrolledAt: T1 + 1 }));

    const error = (await harness.run("assertPaymentEnrollments"))?.error;
    expect(error).toContain(ids.activePayment);
    expect(error).toContain(enrollment._id);
  });

  it("skips disputed payments and payments with no deal", async () => {
    const { harness, ids } = await backfilled();
    await harness.t.run(async (ctx) => {
      const { tenantId } = harness;
      await insertPayment(ctx, { tenantId, opportunityId: ids.activeDeal, programId: ids.programC, recordedAt: T1, status: "disputed" });
      const customerPayment = await insertPayment(ctx, { tenantId, opportunityId: ids.activeDeal, programId: ids.programC, recordedAt: T1 });
      await ctx.db.patch("paymentRecords", customerPayment, {
        opportunityId: undefined, contextType: "customer", customerId: ids.activeCustomer,
      });
    });

    expect((await harness.run("assertPaymentEnrollments"))?.error).toBeUndefined();
  });
});
