import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import schema from "../../schema";
import { convexTestModules } from "../../test.setup";
import { expectSameAnswer, rowFromDoc } from "../../../tests/analyticsParity";
import { qualifiedLifecycle } from "../../../tests/bookingHarness";

const DAY = 24 * 60 * 60 * 1000;
const from = Date.UTC(2026, 8, 1, 6);
const to = Date.UTC(2026, 9, 1, 6);
const range = {
  startDate: "2026-09-01",
  endDateInclusive: "2026-09-30",
  fromMs: from,
  toMs: to,
  timeZone: "America/Tegucigalpa",
  dayStartHour: 0,
};
const identity = { subject: "admin_a", org_id: "org_a" };

/**
 * Manual reminders across two closers and four deals (chains of 1, 2 and 5),
 * every completion outcome and none, plus a scheduling link and reminders
 * outside the range; reminder payments from both origins, a disputed one, a
 * meeting payment and one outside the range.
 */
async function createFixture() {
  const t = convexTest({ schema, modules: convexTestModules });
  const fixture = await t.run(async (ctx) => {
    const tenantId = await ctx.db.insert("tenants", {
      businessDayAppliedVersion: 0,
      companyName: "Tenant",
      contactEmail: "tenant@example.invalid",
      workosOrgId: "org_a",
      status: "active",
      inviteExpiresAt: Date.now() + DAY,
      createdBy: "test",
    });
    const user = (workosUserId: string, role: Doc<"users">["role"], fullName: string) =>
      ctx.db.insert("users", { tenantId, workosUserId, email: `${workosUserId}@example.invalid`, role, fullName, isActive: true });
    const adminId = await user("admin_a", "tenant_admin", "Ana Admin");
    const carla = await user("closer_1", "closer", "Carla Closer");
    const beto = await user("closer_2", "closer", "Beto Closer");
    const program = (name: string) =>
      ctx.db.insert("tenantPrograms", {
        tenantId, name, normalizedName: name.toLowerCase(), createdAt: from, updatedAt: from, createdByUserId: adminId,
      });
    const mentorship = await program("Mentorship");
    const coaching = await program("Coaching");
    const leadId = await ctx.db.insert("leads", {
      tenantId, ...qualifiedLifecycle(0), status: "active", firstSeenAt: 0, updatedAt: 0,
    });
    const deal = () =>
      ctx.db.insert("opportunities", {
        tenantId, leadId, stage: "follow_up", outcome: "open", assignedCloserId: carla, createdAt: 0, updatedAt: 0,
      });
    const [one, two, five, other] = [await deal(), await deal(), await deal(), await deal()];

    let createdAt = from;
    const reminder = (
      opportunityId: Id<"opportunities">,
      closerId: Id<"users">,
      fields: Partial<Doc<"followUps">> = {},
    ) => {
      createdAt += DAY / 2;
      return ctx.db.insert("followUps", {
        tenantId, opportunityId, leadId, closerId, type: "manual_reminder",
        reason: "closer_initiated", status: "pending", createdAt,
        reminderNote: "kept out of the view", ...fields,
      });
    };
    await reminder(one, carla, { status: "completed", completionOutcome: "payment_received", completedAt: from + 2 * DAY });
    await reminder(two, beto, { status: "completed", completionOutcome: "lost" });
    await reminder(two, beto, { status: "completed" });
    for (const completionOutcome of ["no_response_rescheduled", "no_response_given_up", "no_response_close_only"] as const) {
      await reminder(five, carla, { status: "completed", completionOutcome });
    }
    await reminder(five, carla);
    await reminder(five, beto, { status: "expired" });
    await reminder(other, beto, { type: "scheduling_link", reason: "no_show_follow_up" });
    await reminder(other, carla, { createdAt: from - DAY });
    await reminder(other, carla, { createdAt: to });

    const pay = (fields: Partial<Doc<"paymentRecords">>) =>
      ctx.db.insert("paymentRecords", {
        tenantId, opportunityId: one, amountMinor: 100_000, currency: "USD", recordedByUserId: adminId,
        programId: mentorship, programName: "Mentorship", paymentType: "pif", status: "verified",
        recordedAt: from + DAY, origin: "closer_reminder", attributedCloserId: carla, ...fields,
      });
    await pay({ origin: "admin_reminder", amountMinor: 70_000, recordedAt: from + 2 * DAY });
    await pay({ amountMinor: 250_000, recordedAt: from + 3 * DAY });
    await pay({ paymentType: "deposit", amountMinor: 50_000, recordedAt: from + 4 * DAY });
    await pay({ programId: coaching, programName: "Coaching", paymentType: "split", recordedAt: from + 5 * DAY });
    await pay({ status: "disputed" });
    await pay({ origin: "closer_meeting" });
    await pay({ recordedAt: to + DAY });

    const order = <Row extends { _creationTime: number }>(rows: Row[], at: (row: Row) => number) =>
      rows.sort((left, right) => at(left) - at(right) || left._creationTime - right._creationTime);
    // What the report's SQL selects.
    const followUps = order(
      (await ctx.db.query("followUps").take(100)).filter(
        (row) => row.type === "manual_reminder" && row.createdAt >= from && row.createdAt < to,
      ),
      (row) => row.createdAt,
    );
    const payments = order(
      (await ctx.db.query("paymentRecords").take(100)).filter(
        (row) =>
          (row.origin === "closer_reminder" || row.origin === "admin_reminder") &&
          row.recordedAt >= from && row.recordedAt < to && row.status !== "disputed",
      ),
      (row) => row.recordedAt,
    ).sort((left, right) => Number(left.origin === "admin_reminder") - Number(right.origin === "admin_reminder"));
    return { tenantId, mentorship, followUps, payments };
  });
  return {
    t,
    ...fixture,
    rows: {
      followUps: fixture.followUps.map((doc) => rowFromDoc("followUps", doc)),
      payments: fixture.payments.map((doc) => rowFromDoc("paymentRecords", doc)),
    },
  };
}

describe("Reminder Outcomes from ClickHouse rows", () => {
  it("matches the Convex reader with no filters", async () => {
    const fixture = await createFixture();
    const live = await expectSameAnswer({
      t: fixture.t,
      identity,
      tenantId: fixture.tenantId,
      range,
      rows: fixture.rows,
      reportId: "reminders.funnel",
      live: api.reporting.remindersReporting.getReminderOutcomeFunnel,
      liveArgs: { startDate: from, endDate: to },
      filters: { programId: null, paymentType: null },
    });
    expect(live).toMatchObject({
      totalCreated: 8,
      totalCompleted: 6,
      completedWithoutOutcomeCount: 1,
      reminderDrivenPaymentCount: 4,
      opportunitiesWithReminderChains: 3,
    });
    expect(live.chainLengthHistogram.map((bucket: { count: number }) => bucket.count)).toEqual([1, 1, 0, 0, 1]);
  });

  it("applies the program and payment type filters the same way", async () => {
    const fixture = await createFixture();
    const live = await expectSameAnswer({
      t: fixture.t,
      identity,
      tenantId: fixture.tenantId,
      range,
      rows: fixture.rows,
      reportId: "reminders.funnel",
      live: api.reporting.remindersReporting.getReminderOutcomeFunnel,
      liveArgs: { startDate: from, endDate: to, programId: fixture.mentorship, paymentType: "pif" },
      filters: { programId: fixture.mentorship, paymentType: "pif" },
    });
    expect(live.reminderDrivenPaymentCount).toBe(2);
  });
});
