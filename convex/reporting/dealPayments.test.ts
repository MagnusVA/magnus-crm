/**
 * Every payment is a deal payment (docs/plans/phase-4-customers.md D12), and
 * team outcomes and booked vs sold count each one on its deal.
 */
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { bookingHarness, qualifiedLifecycle } from "../../tests/bookingHarness";

afterEach(() => vi.useRealTimers());

const START = Date.parse("2026-09-01T00:00:00Z");
const END = Date.parse("2026-10-01T00:00:00Z");
const CALL = Date.parse("2026-09-10T15:00:00Z");

async function seed(ctx: MutationCtx, tenantId: Id<"tenants">) {
  const users = await ctx.db
    .query("users")
    .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
    .take(10);
  const adminId = users.find((user) => user.role === "tenant_admin")!._id;
  const closerId = users.find((user) => user.role === "closer")!._id;
  const program = (name: string) =>
    ctx.db.insert("tenantPrograms", {
      tenantId, name, normalizedName: name.toLowerCase(), createdAt: 0, createdByUserId: adminId, updatedAt: 0,
    });
  const programA = await program("A");
  const programB = await program("B");

  // Two won deals booked for A, and a lost one.
  const deal = async (key: string, status: "payment_received" | "lost") => {
    const leadId = await ctx.db.insert("leads", {
      ...qualifiedLifecycle(0), tenantId, email: `${key}@example.com`, status: "active", firstSeenAt: 0, updatedAt: 0,
    });
    const opportunityId = await ctx.db.insert("opportunities", {
      tenantId, leadId, assignedCloserId: closerId, status, source: "calendly",
      firstBookingProgramId: programA, createdAt: 0, updatedAt: 0,
    });
    const meetingId = await ctx.db.insert("meetings", {
      tenantId, opportunityId, assignedCloserId: closerId, calendlyEventUri: `e-${key}`,
      calendlyInviteeUri: `i-${key}`, scheduledAt: CALL, durationMinutes: 30, status: "completed", createdAt: 0,
    });
    await ctx.db.patch("opportunities", opportunityId, { latestMeetingId: meetingId });
    return { opportunityId, meetingId };
  };
  const wonA = await deal("won-a", "payment_received");
  const wonB = await deal("won-b", "payment_received");
  await deal("lost", "lost");

  const pay = (opportunityId: Id<"opportunities">, meetingId: Id<"meetings">, programId: Id<"tenantPrograms">, amountMinor: number) =>
    ctx.db.insert("paymentRecords", {
      tenantId, opportunityId, meetingId, attributedCloserId: closerId, recordedByUserId: closerId,
      commissionable: true, amountMinor, currency: "USD", programId, programName: "Program",
      paymentType: "pif", status: "recorded", recordedAt: CALL + 60_000, origin: "closer_meeting",
    });
  await pay(wonA.opportunityId, wonA.meetingId, programA, 100_000);
  await pay(wonB.opportunityId, wonB.meetingId, programB, 250_000);
}

it("counts each payment on its deal in team outcomes and booked vs sold", async () => {
  vi.useFakeTimers();
  const harness = await bookingHarness();
  await harness.t.run((ctx) => seed(ctx, harness.tenantId));

  const outcomes = await harness.admin.query(api.reporting.teamOutcomes.getTeamOutcomeMix, { startDate: START, endDate: END });
  const matrix = await harness.admin.query(api.reporting.bookedVsSold.getBookedVsSoldMatrix, { startDate: START, endDate: END });
  expect(outcomes.teamOutcome).toMatchObject({ sold: 2, lost: 1 });
  expect(matrix.rows.map(({ paymentCount, totalAmountMinor }) => ({ paymentCount, totalAmountMinor }))).toEqual([
    { paymentCount: 1, totalAmountMinor: 250_000 },
    { paymentCount: 1, totalAmountMinor: 100_000 },
  ]);
  expect(matrix.rows.every((row) => row.bookingProgramName === "A")).toBe(true);
});
