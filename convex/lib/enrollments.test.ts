import { afterEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
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
import { derivePersonEnrollments, syncPersonEnrollments } from "./enrollments";

// The one rule that derives a person's enrollments from their payments
// (docs/plans/phase-4-customers.md §4.1, D13).

afterEach(() => vi.useRealTimers());

const T1 = Date.parse("2026-08-01T10:00:00Z");
const T2 = Date.parse("2026-08-05T10:00:00Z");
const T3 = Date.parse("2026-08-09T10:00:00Z");
const NOW = Date.parse("2026-10-20T12:00:00Z");

async function seed(harness: EnrollmentHarness) {
  return await harness.t.run(async (ctx) => {
    const { tenantId } = harness;
    const leadId = await insertPerson(ctx, tenantId);
    return {
      leadId,
      dealA: await insertDeal(ctx, tenantId, leadId),
      dealB: await insertDeal(ctx, tenantId, leadId),
      programX: await insertProgram(ctx, tenantId, "X"),
      programY: await insertProgram(ctx, tenantId, "Y"),
      programZ: await insertProgram(ctx, tenantId, "Z"),
    };
  });
}

function sync(harness: EnrollmentHarness, leadId: Id<"leads">, now = NOW) {
  return harness.t.run((ctx) => syncPersonEnrollments(ctx, { tenantId: harness.tenantId, leadId, now }));
}

describe("derivePersonEnrollments", () => {
  it("takes each program's earliest payment that isn't disputed, across the person's deals", async () => {
    const harness = await enrollmentHarness();
    const s = await seed(harness);
    const { tenantId } = harness;
    const paymentIds = await harness.t.run(async (ctx) => ({
      disputedX: await insertPayment(ctx, { tenantId, opportunityId: s.dealA, programId: s.programX, recordedAt: T1, status: "disputed" }),
      laterX: await insertPayment(ctx, { tenantId, opportunityId: s.dealA, programId: s.programX, recordedAt: T3 }),
      firstX: await insertPayment(ctx, { tenantId, opportunityId: s.dealB, programId: s.programX, recordedAt: T2, status: "verified" }),
      firstY: await insertPayment(ctx, { tenantId, opportunityId: s.dealA, programId: s.programY, recordedAt: T3 }),
    }));

    const derived = await harness.t.run((ctx) => derivePersonEnrollments(ctx, tenantId, s.leadId));
    expect(derived).toEqual([
      { programId: s.programX, opportunityId: s.dealB, enrolledAt: T2, firstPaymentId: paymentIds.firstX },
      { programId: s.programY, opportunityId: s.dealA, enrolledAt: T3, firstPaymentId: paymentIds.firstY },
    ]);
  });

  it("breaks a tie on recordedAt by creation order", async () => {
    const harness = await enrollmentHarness();
    const s = await seed(harness);
    const { tenantId } = harness;
    const first = await harness.t.run(async (ctx) => {
      const first = await insertPayment(ctx, { tenantId, opportunityId: s.dealB, programId: s.programX, recordedAt: T1 });
      await insertPayment(ctx, { tenantId, opportunityId: s.dealA, programId: s.programX, recordedAt: T1 });
      return first;
    });

    const derived = await harness.t.run((ctx) => derivePersonEnrollments(ctx, tenantId, s.leadId));
    expect(derived).toEqual([{ programId: s.programX, opportunityId: s.dealB, enrolledAt: T1, firstPaymentId: first }]);
  });

  it("counts no payment without a deal, and no other person's deal", async () => {
    const harness = await enrollmentHarness();
    const s = await seed(harness);
    const { tenantId } = harness;
    await harness.t.run(async (ctx) => {
      const other = await insertPerson(ctx, tenantId);
      const otherDeal = await insertDeal(ctx, tenantId, other);
      await insertPayment(ctx, { tenantId, opportunityId: otherDeal, programId: s.programX, recordedAt: T1 });
      // What recordCustomerPayment writes: no deal, only a customer.
      const paymentId = await insertPayment(ctx, { tenantId, opportunityId: s.dealA, programId: s.programY, recordedAt: T1 });
      await ctx.db.patch("paymentRecords", paymentId, { opportunityId: undefined, contextType: "customer" });
    });

    expect(await harness.t.run((ctx) => derivePersonEnrollments(ctx, tenantId, s.leadId))).toEqual([]);
  });

  it("throws past 100 deals rather than derive from part of them", async () => {
    const harness = await enrollmentHarness();
    const { tenantId } = harness;
    const leadId = await harness.t.run(async (ctx) => {
      const leadId = await insertPerson(ctx, tenantId);
      for (let index = 0; index < 101; index += 1) await insertDeal(ctx, tenantId, leadId);
      return leadId;
    });

    await expect(harness.t.run((ctx) => derivePersonEnrollments(ctx, tenantId, leadId))).rejects.toThrow(
      `Person ${leadId} has more than 100 deals`,
    );
  });

  it("throws past 50 payments on one deal", async () => {
    const harness = await enrollmentHarness();
    const s = await seed(harness);
    const { tenantId } = harness;
    await harness.t.run(async (ctx) => {
      for (let index = 0; index < 51; index += 1) {
        await insertPayment(ctx, { tenantId, opportunityId: s.dealA, programId: s.programX, recordedAt: T1 + index });
      }
    });

    await expect(harness.t.run((ctx) => derivePersonEnrollments(ctx, tenantId, s.leadId))).rejects.toThrow(
      `Opportunity ${s.dealA} has more than 50 payments`,
    );
  });
});

describe("syncPersonEnrollments", () => {
  it("inserts a missing enrollment as active, and a second run changes nothing", async () => {
    const harness = await enrollmentHarness();
    const s = await seed(harness);
    const { tenantId } = harness;
    await harness.t.run((ctx) => insertPayment(ctx, { tenantId, opportunityId: s.dealA, programId: s.programX, recordedAt: T1 }));

    const first = await sync(harness, s.leadId);
    expect(first).toMatchObject({ updated: [], repointed: [], removed: [], hadEnrollments: false, hasEnrollments: true });
    expect(first.created).toHaveLength(1);
    const enrollments = await enrollmentsOf(harness, s.leadId);
    expect(enrollments).toEqual([first.created[0]]);
    expect(enrollments[0]).toMatchObject({
      tenantId, leadId: s.leadId, programId: s.programX, opportunityId: s.dealA, enrolledAt: T1, status: "active", createdAt: NOW,
    });
    expect(enrollments[0].statusChangedAt).toBeUndefined();

    const second = await sync(harness, s.leadId, NOW + 1);
    expect(second).toEqual({ created: [], updated: [], repointed: [], removed: [], hadEnrollments: true, hasEnrollments: true });
    expect(await enrollmentsOf(harness, s.leadId)).toEqual(enrollments);
  });

  it("moves an enrollment to the earliest payment left, keeping its status", async () => {
    const harness = await enrollmentHarness();
    const s = await seed(harness);
    const { tenantId } = harness;
    const { first, enrollmentId } = await harness.t.run(async (ctx) => {
      const first = await insertPayment(ctx, { tenantId, opportunityId: s.dealA, programId: s.programX, recordedAt: T1 });
      await insertPayment(ctx, { tenantId, opportunityId: s.dealB, programId: s.programX, recordedAt: T2 });
      const enrollmentId = await insertEnrollment(ctx, {
        tenantId, leadId: s.leadId, programId: s.programX, opportunityId: s.dealA, enrolledAt: T1, status: "paused",
      });
      return { first, enrollmentId };
    });
    await harness.t.run((ctx) => ctx.db.patch("paymentRecords", first, { status: "disputed" }));

    const result = await sync(harness, s.leadId);
    expect(result.updated).toHaveLength(1);
    expect(result.updated[0].before).toMatchObject({ opportunityId: s.dealA, enrolledAt: T1 });
    expect(result.updated[0].after).toMatchObject({ _id: enrollmentId, opportunityId: s.dealB, enrolledAt: T2 });
    expect(await enrollmentsOf(harness, s.leadId)).toEqual([result.updated[0].after]);
    expect(result.updated[0].after.status).toBe("paused");
  });

  it("deletes an enrollment whose program has no payment left", async () => {
    const harness = await enrollmentHarness();
    const s = await seed(harness);
    const { tenantId } = harness;
    await harness.t.run(async (ctx) => {
      await insertPayment(ctx, { tenantId, opportunityId: s.dealA, programId: s.programX, recordedAt: T1 });
      await insertPayment(ctx, { tenantId, opportunityId: s.dealB, programId: s.programY, recordedAt: T2, status: "disputed" });
      await insertEnrollment(ctx, { tenantId, leadId: s.leadId, programId: s.programX, opportunityId: s.dealA, enrolledAt: T1 });
      // Y's only payment is disputed, and X still has an enrollment, so
      // nothing pairs with Y's enrollment.
      await insertEnrollment(ctx, { tenantId, leadId: s.leadId, programId: s.programY, opportunityId: s.dealB, enrolledAt: T2 });
    });

    const result = await sync(harness, s.leadId);
    expect(result.removed.map(({ enrollment, reason }) => [enrollment.programId, reason])).toEqual([[s.programY, "no_payment"]]);
    expect((await enrollmentsOf(harness, s.leadId)).map((row) => row.programId)).toEqual([s.programX]);
    expect(result).toMatchObject({ hadEnrollments: true, hasEnrollments: true });
  });

  it("deletes the last enrollment and says the person has none", async () => {
    const harness = await enrollmentHarness();
    const s = await seed(harness);
    const { tenantId } = harness;
    await harness.t.run(async (ctx) => {
      await insertPayment(ctx, { tenantId, opportunityId: s.dealA, programId: s.programX, recordedAt: T1, status: "disputed" });
      await insertEnrollment(ctx, { tenantId, leadId: s.leadId, programId: s.programX, opportunityId: s.dealA, enrolledAt: T1 });
    });

    const result = await sync(harness, s.leadId);
    expect(result.removed).toHaveLength(1);
    expect(result).toMatchObject({ hadEnrollments: true, hasEnrollments: false });
    expect(await enrollmentsOf(harness, s.leadId)).toEqual([]);
  });

  it("repoints an enrollment whose only payment moved to a program with none, keeping its ID and status (D13)", async () => {
    const harness = await enrollmentHarness();
    const s = await seed(harness);
    const { tenantId, adminId } = harness;
    const { paymentId, enrollmentId } = await harness.t.run(async (ctx) => {
      const paymentId = await insertPayment(ctx, { tenantId, opportunityId: s.dealA, programId: s.programX, recordedAt: T1 });
      const enrollmentId = await insertEnrollment(ctx, {
        tenantId, leadId: s.leadId, programId: s.programX, opportunityId: s.dealA, enrolledAt: T1, status: "churned",
      });
      await ctx.db.patch("enrollments", enrollmentId, { statusChangedAt: T2, statusChangedByUserId: adminId });
      return { paymentId, enrollmentId };
    });
    await harness.t.run((ctx) => ctx.db.patch("paymentRecords", paymentId, { programId: s.programY }));

    const result = await sync(harness, s.leadId);
    expect(result).toMatchObject({ created: [], updated: [], removed: [] });
    expect(result.repointed).toHaveLength(1);
    expect(result.repointed[0].before.programId).toBe(s.programX);
    const [enrollment] = await enrollmentsOf(harness, s.leadId);
    expect(enrollment).toEqual(result.repointed[0].after);
    expect(enrollment).toMatchObject({
      _id: enrollmentId, programId: s.programY, opportunityId: s.dealA, enrolledAt: T1,
      status: "churned", statusChangedAt: T2, statusChangedByUserId: adminId, createdAt: 0,
    });
  });

  it("pairs several repoints by the payment that moved first, then oldest with oldest", async () => {
    const harness = await enrollmentHarness();
    const s = await seed(harness);
    const { tenantId } = harness;
    const ids = await harness.t.run(async (ctx) => {
      const programW = await insertProgram(ctx, tenantId, "W");
      // X's enrollment followed the T2 payment, which moved to Z. Y's
      // enrollment followed a payment that was voided; W's T3 payment is new.
      const movedToZ = await insertPayment(ctx, { tenantId, opportunityId: s.dealB, programId: s.programX, recordedAt: T2 });
      const voidedY = await insertPayment(ctx, { tenantId, opportunityId: s.dealA, programId: s.programY, recordedAt: T1 });
      await insertPayment(ctx, { tenantId, opportunityId: s.dealA, programId: programW, recordedAt: T3 });
      return {
        programW,
        movedToZ,
        voidedY,
        x: await insertEnrollment(ctx, { tenantId, leadId: s.leadId, programId: s.programX, opportunityId: s.dealB, enrolledAt: T2, status: "paused" }),
        y: await insertEnrollment(ctx, { tenantId, leadId: s.leadId, programId: s.programY, opportunityId: s.dealA, enrolledAt: T1 }),
      };
    });
    await harness.t.run(async (ctx) => {
      await ctx.db.patch("paymentRecords", ids.movedToZ, { programId: s.programZ });
      await ctx.db.patch("paymentRecords", ids.voidedY, { status: "disputed" });
    });

    // Oldest with oldest alone would pair Y (T1) with Z (T2) and X with W.
    const result = await sync(harness, s.leadId);
    expect(result.repointed.map(({ before, after }) => [before._id, after.programId])).toEqual([
      [ids.x, s.programZ],
      [ids.y, ids.programW],
    ]);
    const byId = new Map((await enrollmentsOf(harness, s.leadId)).map((row) => [row._id, row]));
    expect(byId.get(ids.x)).toMatchObject({ programId: s.programZ, opportunityId: s.dealB, enrolledAt: T2, status: "paused" });
    expect(byId.get(ids.y)).toMatchObject({ programId: ids.programW, opportunityId: s.dealA, enrolledAt: T3, status: "active" });
  });

  it("keeps the oldest of two enrollments for one program and deletes the other", async () => {
    const harness = await enrollmentHarness();
    const s = await seed(harness);
    const { tenantId } = harness;
    const { oldest, duplicate } = await harness.t.run(async (ctx) => {
      await insertPayment(ctx, { tenantId, opportunityId: s.dealA, programId: s.programX, recordedAt: T1 });
      const oldest = await insertEnrollment(ctx, {
        tenantId, leadId: s.leadId, programId: s.programX, opportunityId: s.dealB, enrolledAt: T3, status: "paused",
      });
      const duplicate = await insertEnrollment(ctx, {
        tenantId, leadId: s.leadId, programId: s.programX, opportunityId: s.dealA, enrolledAt: T1,
      });
      return { oldest, duplicate };
    });

    const result = await sync(harness, s.leadId);
    expect(result.removed.map(({ enrollment, reason }) => [enrollment._id, reason])).toEqual([[duplicate, "duplicate"]]);
    expect(result.updated.map(({ after }) => after._id)).toEqual([oldest]);
    const enrollments = await enrollmentsOf(harness, s.leadId);
    expect(enrollments).toHaveLength(1);
    expect(enrollments[0]).toMatchObject({ _id: oldest, opportunityId: s.dealA, enrolledAt: T1, status: "paused" });
  });

  it("writes no event, counter or lead status, and rebuilds the search row", async () => {
    const harness = await enrollmentHarness();
    const s = await seed(harness);
    const { tenantId } = harness;
    await harness.t.run(async (ctx) => {
      await ctx.db.patch("leads", s.leadId, { status: "active" });
      await insertPayment(ctx, { tenantId, opportunityId: s.dealA, programId: s.programX, recordedAt: T1 });
    });
    const snapshot = () =>
      harness.t.run(async (ctx) => ({
        lead: await ctx.db.get("leads", s.leadId),
        events: await ctx.db.query("domainEvents").take(10),
        stats: await ctx.db.query("tenantStats").take(10),
      }));
    const before = await snapshot();

    expect((await sync(harness, s.leadId)).created).toHaveLength(1);
    expect(await snapshot()).toEqual(before);
    const rows = await harness.t.run((ctx) => ctx.db.query("leadCustomerSearchRows").take(10));
    expect(rows).toMatchObject([{ leadId: s.leadId, lifecycle: "customer", customerStatus: "active" }]);
  });
});
