import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "../../_generated/api";
import type { Doc } from "../../_generated/dataModel";
import schema from "../../schema";
import { convexTestModules } from "../../test.setup";
import { expectMergedAnswer } from "../../../tests/analyticsMerge";
import { qualifiedLifecycle } from "../../../tests/bookingHarness";
import { mergeBookedVsSold, mergeRevenueDetails, mergeRevenueMetrics, mergeRevenueTrend } from "./revenue";

const DAY = 24 * 60 * 60 * 1000;
// September 2026 in Tegucigalpa (UTC-6), split on Thursday the 17th: the
// week of the 14th has days on both sides.
const from = Date.UTC(2026, 8, 1, 6);
const split = Date.UTC(2026, 8, 17, 6);
const to = Date.UTC(2026, 9, 1, 6);

async function createFixture() {
  const t = convexTest({ schema, modules: convexTestModules });
  const ids = await t.run(async (ctx) => {
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
    // Sells only today.
    const dora = await user("closer_3", "closer", "Dora Closer");
    const program = (name: string) =>
      ctx.db.insert("tenantPrograms", {
        tenantId,
        name,
        normalizedName: name.toLowerCase(),
        createdAt: from,
        updatedAt: from,
        createdByUserId: adminId,
      });
    const mentorship = await program("Mentorship");
    const mastermind = await program("Mastermind");
    const leadId = await ctx.db.insert("leads", {
      tenantId, ...qualifiedLifecycle(0), status: "active", firstSeenAt: 0, updatedAt: 0,
    });
    const deal = (firstBookingProgramId: typeof mentorship) =>
      ctx.db.insert("opportunities", {
        tenantId, leadId, stage: "closed", outcome: "won", source: "calendly", firstBookingProgramId, createdAt: 0, updatedAt: 0,
      });
    const bookedMentorship = await deal(mentorship);
    const bookedMastermind = await deal(mastermind);
    let minute = 0;
    const pay = (fields: Partial<Doc<"paymentRecords">> & { recordedAt: number }) =>
      ctx.db.insert("paymentRecords", {
        tenantId,
        amountMinor: 100_000,
        currency: "USD",
        recordedByUserId: adminId,
        programId: mentorship,
        programName: "Mentorship",
        paymentType: "pif",
        status: "verified",
        origin: "closer_meeting",
        ...fields,
        recordedAt: fields.recordedAt + (minute += 7) * 60_000,
      });
    // Before the split: twelve payments, so the top ten draws from both sides.
    await pay({ attributedCloserId: carla, amountMinor: 250_000, recordedAt: from + DAY, opportunityId: bookedMentorship });
    await pay({ attributedCloserId: beto, paymentType: "deposit", amountMinor: 50_000, recordedAt: from + 3 * DAY });
    await pay({ attributedCloserId: beto, paymentType: "split", amountMinor: 1_200_000, recordedAt: from + 9 * DAY, programId: mastermind, programName: "Mastermind", opportunityId: bookedMentorship });
    await pay({ attributedCloserId: carla, status: "disputed", recordedAt: from + 2 * DAY });
    for (let index = 0; index < 9; index += 1) {
      await pay({ attributedCloserId: index % 2 ? carla : beto, amountMinor: 40_000 + index * 9_000, recordedAt: from + (8 + index) * DAY, origin: index % 3 ? "closer_meeting" : "admin_reminder" });
    }
    // From the split: the same closers and programs, one new closer, and the
    // week of the 14th again.
    await pay({ attributedCloserId: carla, paymentType: "monthly", amountMinor: 300_000, recordedAt: split, opportunityId: bookedMastermind });
    await pay({ attributedCloserId: dora, amountMinor: 80_000, recordedAt: split + DAY, programId: mastermind, programName: "Mastermind", opportunityId: bookedMastermind });
    await pay({ attributedCloserId: beto, paymentType: "deposit", amountMinor: 20_000, recordedAt: split + 2 * DAY });
    await pay({ attributedCloserId: beto, amountMinor: 61_000, recordedAt: split + 3 * DAY });
    return { tenantId, mentorship };
  });
  return { t, ...ids };
}

const identity = { subject: "admin_a", org_id: "org_a" };
const windows = {
  history: { startDate: from, endDate: split },
  today: { startDate: split, endDate: to },
  whole: { startDate: from, endDate: to },
};

describe("Revenue across the split", () => {
  it("merges every panel into the whole range's answer", async () => {
    const { t } = await createFixture();
    const metrics = await expectMergedAnswer({
      t,
      identity,
      live: api.reporting.revenue.getRevenueMetrics,
      ...windows,
      merge: mergeRevenueMetrics,
    });
    expect(metrics.history.revenue.totalDeals).toBeGreaterThan(0);
    expect(metrics.today.revenue.totalDeals).toBeGreaterThan(0);

    const details = await expectMergedAnswer({
      t,
      identity,
      live: api.reporting.revenue.getRevenueDetails,
      ...windows,
      merge: mergeRevenueDetails,
    });
    expect(details.whole.topDeals.some((deal) => deal.recordedAt >= split)).toBe(true);
    expect(details.whole.topDeals.some((deal) => deal.recordedAt < split)).toBe(true);

    for (const granularity of ["day", "week", "month"] as const) {
      await expectMergedAnswer({
        t,
        identity,
        live: api.reporting.revenueTrend.getRevenueTrend,
        history: { ...windows.history, granularity },
        today: { ...windows.today, granularity },
        whole: { ...windows.whole, granularity },
        merge: mergeRevenueTrend,
      });
    }

    await expectMergedAnswer({
      t,
      identity,
      live: api.reporting.bookedVsSold.getBookedVsSoldMatrix,
      ...windows,
      merge: mergeBookedVsSold,
    });
  });

  it("merges the filtered answers too", async () => {
    const { t, mentorship } = await createFixture();
    const filtered = (window: { startDate: number; endDate: number }) => ({ ...window, programId: mentorship, paymentType: "pif" as const });
    await expectMergedAnswer({
      t,
      identity,
      live: api.reporting.revenue.getRevenueMetrics,
      history: filtered(windows.history),
      today: filtered(windows.today),
      whole: filtered(windows.whole),
      merge: mergeRevenueMetrics,
    });
  });
});
