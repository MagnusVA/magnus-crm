import { expect, it } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { bookingHarness, qualifiedLifecycle } from "../../tests/bookingHarness";
import {
  type BookingFixture,
  insertAttributionTeam,
  insertBooking,
  insertDmCloser,
} from "../../tests/bookingCreditFixtures";
import {
  fixtureUsers,
  insertPayment,
  insertProgram,
  seedCustomer,
} from "../../tests/enrollmentReadFixtures";

// A payment has attribution context when its deal was qualified in Slack, a
// booking carried UTMs, or the payment's meeting's booking or the deal's
// first booking credited a team or DM closer.

const AT = Date.parse("2026-09-01T12:00:00Z");

type Harness = Awaited<ReturnType<typeof bookingHarness>>;

async function seed(harness: Harness) {
  const { t, tenantId } = harness;
  return await t.run(async (ctx) => {
    const users = await ctx.db
      .query("users")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .take(10);
    const closer = users.find((user) => user.role === "closer");
    const admin = users.find((user) => user.role === "tenant_admin");
    if (!closer || !admin) throw new Error("Fixture users missing");
    const programId = await ctx.db.insert("tenantPrograms", {
      tenantId,
      name: "Program",
      normalizedName: "program",
      createdAt: 0,
      createdByUserId: admin._id,
      updatedAt: 0,
    });
    const alpha = await insertAttributionTeam(ctx, tenantId, "Alpha");
    const dana = await insertDmCloser(ctx, { tenantId, teamId: alpha, name: "Dana" });

    // The booking rows alone: no UTMs anywhere, so only the credit can give context.
    const credited = (dmCloserId?: Id<"dmClosers">): BookingFixture => ({
      resolution: "mapped",
      teamId: alpha,
      dmCloserId,
    });
    const uncredited: BookingFixture = { resolution: "none" };

    let index = 0;
    async function deal(
      bookings: BookingFixture[],
      options: { slack?: boolean; payOn?: "first" | "last" | "deal" } = {},
    ) {
      index += 1;
      const leadId = await ctx.db.insert("leads", {
        ...qualifiedLifecycle(AT),
        tenantId,
        fullName: `Lead ${index}`,
        status: "active",
        firstSeenAt: AT,
        updatedAt: AT,
      });
      const opportunityId = await ctx.db.insert("opportunities", {
        tenantId,
        leadId,
        status: "payment_received",
        source: options.slack ? "slack_qualified" : "calendly",
        qualifiedBy: options.slack
          ? { slackUserId: "U1", slackTeamId: "T1", submittedAt: AT }
          : undefined,
        assignedCloserId: closer!._id,
        createdAt: AT,
        updatedAt: AT,
        latestActivityAt: AT,
      });
      const meetingIds: Id<"meetings">[] = [];
      for (const [i, booking] of bookings.entries()) {
        meetingIds.push(
          await insertBooking(ctx, {
            opportunityId,
            closerId: closer!._id,
            key: `pay-${index}-${i}`,
            scheduledAt: AT + index * 3_600_000 + i * 86_400_000,
            booking,
          }),
        );
      }
      const payOn = options.payOn ?? "last";
      const meetingId =
        payOn === "deal" ? undefined : payOn === "first" ? meetingIds[0] : meetingIds.at(-1);
      return await ctx.db.insert("paymentRecords", {
        tenantId,
        opportunityId,
        meetingId,
        attributedCloserId: closer!._id,
        amountMinor: 100_00,
        currency: "USD",
        recordedByUserId: closer!._id,
        commissionable: true,
        programId,
        programName: "Program",
        paymentType: "pif",
        status: "recorded",
        recordedAt: AT + index * 60_000,
        origin: "closer_meeting",
      });
    }

    return {
      // A rebook credited a team; the deal's first booking credited none.
      meetingCredit: await deal([uncredited, credited()]),
      // Paid on the deal, whose first booking credited a DM closer.
      dealCredit: await deal([credited(dana)], { payOn: "deal" }),
      // Paid on an uncredited rebook; the deal's first booking credited one.
      firstBookingCredit: await deal([credited(dana), uncredited]),
      slackQualified: await deal([uncredited], { slack: true }),
      utms: await deal([{ utmParams: { utm_source: "mystery" }, resolution: "unmapped" }]),
      nothing: await deal([uncredited, uncredited]),
      neverBooked: await deal([], { payOn: "deal" }),
    };
  });
}

async function contexts(harness: Harness) {
  const audit = await harness.admin.query(api.billing.audit.getPaymentAuditSnapshot, {
    limit: 50,
  });
  return {
    missing: audit.metrics.missingAttributionContext,
    hasContext: Object.fromEntries(
      audit.sampleDiagnostics.map((row) => [row.paymentRecordId, row.attribution.hasContext]),
    ),
  };
}

function expected(ids: Awaited<ReturnType<typeof seed>>) {
  return {
    missing: 2,
    hasContext: {
      [ids.meetingCredit]: true,
      [ids.dealCredit]: true,
      [ids.firstBookingCredit]: true,
      [ids.slackQualified]: true,
      [ids.utms]: true,
      [ids.nothing]: false,
      [ids.neverBooked]: false,
    },
  };
}

it("finds attribution context on the payment's booking or the deal's first booking", async () => {
  const harness = await bookingHarness();
  const ids = await seed(harness);
  expect(await contexts(harness)).toEqual(expected(ids));
});

// A payment that isn't disputed belongs to the enrollment for its deal's
// person and its program (docs/plans/phase-4-customers.md §6.4).
it("counts a payment with no enrollment for its person and program", async () => {
  const harness = await bookingHarness();
  const ids = await harness.t.run(async (ctx) => {
    const { admin, closer } = await fixtureUsers(ctx, harness.tenantId);
    const program = await insertProgram(ctx, harness.tenantId, admin._id, "Program");
    const other = await insertProgram(ctx, harness.tenantId, admin._id, "Other");
    const seeded = await seedCustomer(ctx, harness.tenantId, {
      closerId: closer._id,
      programId: program,
      paidAt: AT,
    });
    const unenrolled = await insertPayment(ctx, {
      tenantId: harness.tenantId,
      opportunityId: seeded.opportunityId,
      programId: other,
      recordedByUserId: closer._id,
      recordedAt: AT + 1_000,
    });
    await insertPayment(ctx, {
      tenantId: harness.tenantId,
      opportunityId: seeded.opportunityId,
      programId: other,
      recordedByUserId: closer._id,
      recordedAt: AT + 2_000,
      status: "disputed",
    });
    return { unenrolled, paymentId: seeded.paymentId };
  });

  const audit = await harness.admin.query(api.billing.audit.getPaymentAuditSnapshot, { limit: 50 });
  expect(audit.metrics.missingEnrollment).toBe(1);
  expect(audit.issueSamples).toEqual([
    expect.objectContaining({ paymentRecordId: ids.unenrolled, issue: "missingEnrollment" }),
  ]);
  const resolved = Object.fromEntries(
    audit.sampleDiagnostics.map((row) => [row.paymentRecordId, row.enrollment.resolved]),
  );
  expect(resolved[ids.paymentId]).toBe(true);
  expect(resolved[ids.unenrolled]).toBe(false);
});
