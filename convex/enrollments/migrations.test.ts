import { afterEach, describe, expect, it, vi } from "vitest";
import type { Doc } from "../_generated/dataModel";
import { writePersonEnrollments } from "../lib/enrollments";
import {
  enrollmentHarness,
  enrollmentsOf,
  insertDeal,
  insertEnrollment,
  insertPayment,
  insertPerson,
  insertProgram,
  type EnrollmentHarness,
} from "../../tests/enrollmentFixtures";

// The enrollment health checks (docs/plans/phase-4-customers.md §10.2),
// against people and payments as production holds them.

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
