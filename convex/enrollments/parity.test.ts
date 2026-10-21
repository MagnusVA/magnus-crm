/**
 * The parity queries find no difference where the customer rows and the
 * enrollments agree, and name each one they seed
 * (docs/plans/phase-4-customers.md §10.3).
 */
import { describe, expect, it } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { bookingHarness } from "../../tests/bookingHarness";
import {
  DAY,
  fixtureUsers,
  insertMeeting,
  insertPayment,
  insertProgram,
  seedCustomer,
} from "../../tests/enrollmentReadFixtures";
import { defaultParityRanges } from "./parity";

const MAY = { startDate: Date.parse("2026-05-01T06:00:00Z"), endDate: Date.parse("2026-06-01T06:00:00Z") };
const JUNE = { startDate: Date.parse("2026-06-01T06:00:00Z"), endDate: Date.parse("2026-07-01T06:00:00Z") };

type Harness = Awaited<ReturnType<typeof bookingHarness>>;

/**
 * Three customers as production holds them: one won on a meeting, one on a
 * side deal with no meeting and no working owner, and one with an additional
 * payment that has no meeting.
 */
async function seed(harness: Harness) {
  return await harness.t.run(async (ctx) => {
    const { admin, closer } = await fixtureUsers(ctx, harness.tenantId);
    const program = await insertProgram(ctx, harness.tenantId, admin._id, "Program");
    const meetingWin = await seedCustomer(ctx, harness.tenantId, {
      closerId: closer._id,
      programId: program,
      paidAt: Date.parse("2026-05-05T12:00:00Z"),
      fullName: "Meeting Win",
      phone: "+15550000002",
    });
    const sideDeal = await seedCustomer(ctx, harness.tenantId, {
      closerId: closer._id,
      recorderId: closer._id,
      programId: program,
      paidAt: Date.parse("2026-05-20T12:00:00Z"),
      fullName: "Side Deal",
      withMeeting: false,
      assignedCloserId: null,
    });
    const additional = await seedCustomer(ctx, harness.tenantId, {
      closerId: closer._id,
      programId: program,
      paidAt: Date.parse("2026-06-02T12:00:00Z"),
      fullName: "Additional",
      amountMinor: 40_000,
    });
    const additionalPaymentId = await insertPayment(ctx, {
      tenantId: harness.tenantId,
      opportunityId: additional.opportunityId,
      programId: program,
      recordedByUserId: closer._id,
      recordedAt: Date.parse("2026-06-12T12:00:00Z"),
      amountMinor: 60_000,
      customerId: additional.customerId,
      origin: "closer_additional",
    });
    await ctx.db.patch("customers", additional.customerId, {
      totalPaidMinor: 100_000,
      totalPaymentCount: 2,
    });
    return { meetingWin, sideDeal, additional, additionalPaymentId, program, closerId: closer._id };
  });
}

async function allSearchRows(harness: Harness, numItems: number) {
  let cursor: string | null = null;
  const pages = [];
  for (;;) {
    const page: Awaited<ReturnType<typeof searchRowsPage>> = await searchRowsPage(harness, cursor, numItems);
    pages.push(page);
    if (page.isDone) return pages;
    cursor = page.continueCursor;
  }
}

async function searchRowsPage(harness: Harness, cursor: string | null, numItems: number) {
  return await harness.t.query(internal.enrollments.parity.compareSearchRows, {
    tenantId: harness.tenantId,
    cursor,
    numItems,
  });
}

async function allBillingRows(harness: Harness) {
  return await harness.t.query(internal.enrollments.parity.compareBillingRows, {
    tenantId: harness.tenantId,
    cursor: null,
  });
}

async function leadConversion(harness: Harness) {
  return await harness.t.query(internal.enrollments.parity.compareLeadConversion, {
    tenantId: harness.tenantId,
    ranges: [MAY, JUNE],
  });
}

describe("compareLeadConversion", () => {
  it("finds no difference on consistent data", async () => {
    const harness = await bookingHarness();
    await seed(harness);
    const result = await leadConversion(harness);
    expect(result.continueCursor).toBeNull();
    expect(result.ranges).toEqual([
      expect.objectContaining({ conversionsFromCustomers: 2, conversionsFromEnrollments: 2, metrics: [], closers: [], conversions: [] }),
      expect.objectContaining({ conversionsFromCustomers: 1, conversionsFromEnrollments: 1, metrics: [], closers: [], conversions: [] }),
    ]);
  });

  it("names a conversion whose first enrollment falls in another month", async () => {
    const harness = await bookingHarness();
    const seeded = await seed(harness);
    await harness.t.run(async (ctx) => {
      await ctx.db.patch("enrollments", seeded.sideDeal.enrollmentId, {
        enrolledAt: Date.parse("2026-06-03T12:00:00Z"),
      });
    });
    const [may, june] = (await leadConversion(harness)).ranges;
    expect(may.metrics).toEqual(
      expect.arrayContaining([
        { metric: "newCustomers", fromCustomers: 2, fromEnrollments: 1 },
        { metric: "totalConversions", fromCustomers: 2, fromEnrollments: 1 },
      ]),
    );
    expect(may.closers).toEqual([{ closerId: seeded.closerId, fromCustomers: 2, fromEnrollments: 1 }]);
    expect(may.conversions).toEqual([
      { leadId: seeded.sideDeal.leadId, field: "count", fromCustomers: 1, fromEnrollments: 0 },
    ]);
    expect(june.conversions).toEqual([
      { leadId: seeded.sideDeal.leadId, field: "count", fromCustomers: 0, fromEnrollments: 1 },
    ]);
  });

  it("names a conversion whose recorder differs", async () => {
    const harness = await bookingHarness();
    const seeded = await seed(harness);
    const adminId = await harness.t.run(async (ctx) => {
      const { admin } = await fixtureUsers(ctx, harness.tenantId);
      await ctx.db.patch("customers", seeded.sideDeal.customerId, { convertedByUserId: admin._id });
      return admin._id;
    });
    const [may] = (await leadConversion(harness)).ranges;
    expect(may.conversions).toEqual([
      {
        leadId: seeded.sideDeal.leadId,
        field: "convertedByUserId",
        fromCustomers: adminId,
        fromEnrollments: seeded.closerId,
      },
    ]);
    // The admin isn't a closer, so the customer rows exclude the conversion.
    expect(may.metrics).toEqual(
      expect.arrayContaining([{ metric: "excludedConversions", fromCustomers: 1, fromEnrollments: 0 }]),
    );
  });

  it("covers each month from April 2026 and the last 7 days, a page at a time", async () => {
    const now = Date.parse("2026-10-21T12:00:00Z");
    const ranges = defaultParityRanges(now);
    expect(ranges).toHaveLength(8);
    expect(ranges[0]).toEqual({
      startDate: Date.parse("2026-04-01T07:00:00Z"),
      endDate: Date.parse("2026-05-01T07:00:00Z"),
    });
    expect(ranges[6].endDate).toBe(Date.parse("2026-11-01T07:00:00Z"));
    expect(ranges[7]).toEqual({ startDate: now - 7 * DAY, endDate: now });

    const harness = await bookingHarness();
    await seed(harness);
    const first = await harness.t.query(internal.enrollments.parity.compareLeadConversion, {
      tenantId: harness.tenantId,
      ranges: [MAY, JUNE],
      cursor: 1,
    });
    expect(first.ranges.map((range) => range.startDate)).toEqual([JUNE.startDate]);
    expect(first.continueCursor).toBeNull();
  });
});

describe("compareSearchRows", () => {
  it("finds no difference on consistent data, across pages", async () => {
    const harness = await bookingHarness();
    await seed(harness);
    const pages = await allSearchRows(harness, 2);
    expect(pages.reduce((sum, page) => sum + page.checked, 0)).toBe(3);
    expect(pages.flatMap((page) => page.differences)).toEqual([]);
    expect(pages.every((page) => page.contactChanges.rows === 0)).toBe(true);
  });

  it("names a status and a total that differ, and counts a renamed person", async () => {
    const harness = await bookingHarness();
    const seeded = await seed(harness);
    await harness.t.run(async (ctx) => {
      await ctx.db.patch("enrollments", seeded.meetingWin.enrollmentId, { status: "paused" });
      await ctx.db.patch("customers", seeded.additional.customerId, { totalPaidMinor: 40_000 });
      await ctx.db.patch("leads", seeded.sideDeal.leadId, { fullName: "Renamed", phone: "+15550000003" });
    });
    const [page] = await allSearchRows(harness, 100);
    expect(page.differences).toEqual(
      expect.arrayContaining([
        {
          customerId: seeded.meetingWin.customerId,
          leadId: seeded.meetingWin.leadId,
          field: "customerStatus",
          fromCustomers: "active",
          fromEnrollments: "paused",
        },
        {
          customerId: seeded.additional.customerId,
          leadId: seeded.additional.leadId,
          field: "totalPaidMinor",
          fromCustomers: 40_000,
          fromEnrollments: 100_000,
        },
      ]),
    );
    expect(page.differences).toHaveLength(2);
    // The copy holds no phone, so the row already showed the person's.
    expect(page.contactChanges).toEqual({
      rows: 1,
      displayName: 1,
      email: 0,
      phone: 0,
      leadIds: [seeded.sideDeal.leadId],
    });
  });

  it("names a customer whose person has no enrollment", async () => {
    const harness = await bookingHarness();
    const seeded = await seed(harness);
    await harness.t.run(async (ctx) => {
      await ctx.db.delete("enrollments", seeded.meetingWin.enrollmentId);
    });
    const [page] = await allSearchRows(harness, 100);
    const fields = page.differences
      .filter((difference) => difference.leadId === seeded.meetingWin.leadId)
      .map((difference) => difference.field);
    expect(fields).toEqual(
      expect.arrayContaining(["lifecycle", "customerStatus", "totalPaidMinor", "paymentCurrency", "convertedAt"]),
    );
  });
});

describe("compareBillingRows", () => {
  it("finds no difference on consistent data", async () => {
    const harness = await bookingHarness();
    await seed(harness);
    const result = await allBillingRows(harness);
    expect(result.checked).toBe(4);
    expect(result.differences).toEqual([]);
    expect(result.labelChanges.rows).toBe(0);
    expect(result.isDone).toBe(true);
  });

  it("names a meeting that differs and counts a person whose email changed", async () => {
    const harness = await bookingHarness();
    const seeded = await seed(harness);
    const strayMeetingId = await harness.t.run(async (ctx) => {
      // A customer row whose winning meeting is on another deal: the old
      // fallback shows it for the side deal payment, the new one shows none.
      const strayMeetingId: Id<"meetings"> = await insertMeeting(ctx, {
        tenantId: harness.tenantId,
        opportunityId: seeded.meetingWin.opportunityId,
        closerId: seeded.closerId,
        scheduledAt: Date.parse("2026-05-19T12:00:00Z"),
      });
      await ctx.db.patch("customers", seeded.sideDeal.customerId, { winningMeetingId: strayMeetingId });
      await ctx.db.patch("leads", seeded.additional.leadId, { email: "changed@example.com" });
      return strayMeetingId;
    });
    const result = await allBillingRows(harness);
    expect(result.differences).toEqual([
      { paymentId: seeded.sideDeal.paymentId, field: "meetingId", fromCustomers: strayMeetingId, fromPerson: null },
    ]);
    expect(result.labelChanges).toEqual({
      rows: 2,
      fullName: 0,
      email: 2,
      phone: 0,
      paymentIds: expect.arrayContaining([seeded.additional.paymentId, seeded.additionalPaymentId]),
    });
  });
});
