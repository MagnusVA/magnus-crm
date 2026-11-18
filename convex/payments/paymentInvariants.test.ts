import { describe, expect, it } from "vitest";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { emitDomainEvent } from "../lib/domainEvents";
import { stageOfPosition, type DealPosition } from "../opportunities/stages";
import { insertMeetingAggregate, insertOpportunityAggregate } from "../reporting/writeHooks";
import {
  FIXTURE_NOW,
  FIXTURE_PAID_AT,
  insertProviderBinding,
  insertProviderFact,
  providerPaymentFixture,
  seedAppliedReceipt,
  seedReadyDecision,
} from "../../tests/providerPaymentFixtures";
import { seedProviderRow } from "../../tests/providerRowFixtures";
import {
  INVARIANT_IDS,
  assertPaymentInvariants,
  seedProviderWin,
  type InvariantId,
} from "../../tests/paymentInvariants";
import { markAttendanceOwed } from "./attendanceDebt";

const HOUR = 3_600_000;
const HEX = "a".repeat(64);
const LOST_AT = FIXTURE_NOW - 2 * HOUR;

// One tenant where every invariant's condition is in play and holds:
// A won from a Whop payment, with a held meeting, a scheduled meeting that
// owes attendance, a membership binding and its applied receipt; B closed by
// an exclusion; C reopened at Follow-up by one, with one next step and a
// ready decision; D Booked with its booking scheduled.
async function invariantFixture() {
  const harness = await providerPaymentFixture({ dealPosition: "booked" });
  const { t, tenantId, adminId, closerId, personId, connectionId, programId } = harness;
  const dealA = harness.dealId!;
  const ids = await t.run(async (ctx) => {
    const deal = async (position: DealPosition, fields: Record<string, unknown> = {}) => {
      const id = await ctx.db.insert("opportunities", {
        ...stageOfPosition(position), source: "calendly", tenantId, leadId: personId, assignedCloserId: closerId,
        createdAt: FIXTURE_PAID_AT - 1000, updatedAt: FIXTURE_PAID_AT - 1000, ...fields,
      });
      await insertOpportunityAggregate(ctx, id);
      return id;
    };
    const meeting = async (opportunityId: Id<"opportunities">, status: "scheduled" | "held", scheduledAt: number) => {
      const id = await ctx.db.insert("meetings", {
        tenantId, opportunityId, assignedCloserId: closerId,
        calendlyEventUri: `https://api.calendly.com/scheduled_events/${opportunityId}-${scheduledAt}`,
        calendlyInviteeUri: `https://api.calendly.com/scheduled_events/${opportunityId}-${scheduledAt}/invitees/x`,
        scheduledAt, durationMinutes: 30, status, createdAt: scheduledAt,
        ...(status === "held" ? { heldMarkedAt: scheduledAt + HOUR } : {}),
      });
      await insertMeetingAggregate(ctx, id);
      return id;
    };
    const fact = (externalPaymentId: string) => insertProviderFact(ctx, tenantId, connectionId, {
      externalPaymentId, reviewState: "needs_person", reviewReason: "ready",
    });
    const disputedRow = (opportunityId: Id<"opportunities">, providerPaymentId: Id<"providerPayments">) =>
      seedProviderRow(ctx, {
        tenantId, opportunityId, closerId, programId, amountMinor: 10000, recordedAt: FIXTURE_PAID_AT,
        recorder: adminId, status: "disputed", providerPaymentId,
      });

    // A: won from P1.
    await ctx.db.patch("providerPayments", harness.providerPaymentId, { membershipId: "mem_fixture" });
    const heldMeetingId = await meeting(dealA, "held", FIXTURE_PAID_AT - 4 * HOUR);
    const owedMeetingId = await meeting(dealA, "scheduled", FIXTURE_NOW + 24 * HOUR);
    const rowA = await seedProviderWin(ctx, {
      tenantId, opportunityId: dealA, providerPaymentId: harness.providerPaymentId, programId,
      closerId, approverId: adminId, recordedAt: FIXTURE_PAID_AT,
    });
    await markAttendanceOwed(ctx, dealA);
    const bindingId = await insertProviderBinding(ctx, {
      tenantId, connectionId, adminId, externalId: "mem_fixture",
      binding: { kind: "membership_deal", opportunityId: dealA, leadId: personId, anchorPaymentRecordId: rowA },
    });
    const appliedId = await seedAppliedReceipt(ctx, {
      tenantId, providerPaymentId: harness.providerPaymentId, opportunityId: dealA, leadId: personId,
      appliedPaymentRecordId: rowA,
    });
    const lineId = await ctx.db.insert("closerPinnedLines", {
      tenantId, userId: closerId, kind: "win_recorded_from_whop", opportunityId: dealA, paymentRecordId: rowA,
      amountMinor: 10000, currency: "USD", dealPositionAfter: "won", decisionId: appliedId, createdAt: FIXTURE_NOW,
    });

    // B: closed by a reviewed exclusion of P2's row.
    const paymentB = await fact("pay_fixture_b");
    const dealB = await deal("lost", {
      lostReason: "payment_excluded", lostAt: LOST_AT, lostByUserId: adminId, humanResultRevision: 1,
    });
    const rowB = await disputedRow(dealB, paymentB);
    const correctionB = await ctx.db.insert("paymentCorrections", {
      tenantId, operation: "exclude", requestKey: HEX, level: "reviewed", cause: "wrong_match", result: "lost",
      paymentRecordId: rowB, providerPaymentId: paymentB, opportunityId: dealB, leadId: personId,
      before: { paymentStatus: "recorded", providerReviewState: "recorded", allocationRevision: 1, dealPosition: "won", paymentReceivedAt: FIXTURE_PAID_AT },
      after: { dealPosition: "lost", lostAt: LOST_AT, allocationRevision: 2, humanResultRevision: 1 },
      tasks: [], removedEnrollments: [], vetoedOpportunityId: dealB, actorUserId: adminId, createdAt: LOST_AT,
    });
    await emitDomainEvent(ctx, {
      tenantId, entityType: "payment", entityId: rowB, eventType: "payment.restored", source: "admin",
      actorUserId: adminId, fromStatus: "disputed", toStatus: "recorded",
      metadata: { correctionId: correctionB, providerPaymentId: paymentB, fromStatus: "disputed", toStatus: "recorded" },
    });

    // C: reopened at Follow-up by a reviewed exclusion of P3's row, with one next step.
    const paymentC = await fact("pay_fixture_c");
    const dealC = await deal("follow_up", { humanResultRevision: 2 });
    const rowC = await disputedRow(dealC, paymentC);
    const correctionC = await ctx.db.insert("paymentCorrections", {
      tenantId, operation: "exclude", requestKey: "b".repeat(64), level: "reviewed", cause: "refund", result: "follow_up",
      paymentRecordId: rowC, providerPaymentId: paymentC, opportunityId: dealC, leadId: personId,
      before: { paymentStatus: "recorded", providerReviewState: "recorded", allocationRevision: 1, dealPosition: "won", paymentReceivedAt: FIXTURE_PAID_AT },
      after: { dealPosition: "follow_up", allocationRevision: 2, humanResultRevision: 2 },
      tasks: [], removedEnrollments: [], actorUserId: adminId, createdAt: LOST_AT,
    });
    const taskC = await ctx.db.insert("followUps", {
      tenantId, opportunityId: dealC, leadId: personId, closerId, type: "manual_reminder", contactMethod: "call",
      reminderScheduledAt: FIXTURE_NOW, reason: "admin_initiated", status: "pending", createdAt: LOST_AT,
      createdSource: "system",
    });
    await ctx.db.patch("paymentCorrections", correctionC, { tasks: [{ followUpId: taskC, change: "created" }] });
    const readyId = await seedReadyDecision(ctx, {
      tenantId, providerPaymentId: paymentB, opportunityId: dealC, leadId: personId, humanResultRevision: 2,
    });

    // D: Booked, its booking scheduled.
    const dealD = await deal("booked");
    const bookingD = await meeting(dealD, "scheduled", FIXTURE_NOW + 48 * HOUR);

    return {
      heldMeetingId, owedMeetingId, rowA, bindingId, appliedId, lineId,
      paymentB, dealB, rowB, correctionB, paymentC, dealC, rowC, taskC, readyId, dealD, bookingD,
    };
  });
  return { ...harness, dealA, ...ids };
}

type Fixture = Awaited<ReturnType<typeof invariantFixture>>;

const others = (id: InvariantId) => INVARIANT_IDS.filter((other) => other !== id);

async function expectBroken(fixture: Fixture, id: InvariantId) {
  const scope = { tenantId: fixture.tenantId };
  const error = await assertPaymentInvariants(fixture.t, scope, { skip: others(id) }).then(
    () => null,
    (caught: unknown) => caught as Error,
  );
  expect(error?.message).toMatch(new RegExp(`^${id}: `, "m"));
}

// Each case breaks one invariant with a direct write, the way a buggy core would.
const BREAKS: Record<InvariantId, (ctx: MutationCtx, fixture: Fixture) => Promise<void>> = {
  // A won deal whose only payment no longer counts.
  I1: async (ctx, f) => { await ctx.db.patch("paymentRecords", f.rowA, { status: "disputed" }); },
  // The first payment's time drifted from paymentReceivedAt.
  I2: async (ctx, f) => { await ctx.db.patch("opportunities", f.dealA, { paymentReceivedAt: FIXTURE_PAID_AT + 1 }); },
  // A second counting row cites P1.
  I3: async (ctx, f) => {
    await seedProviderRow(ctx, {
      tenantId: f.tenantId, opportunityId: f.dealA, closerId: f.closerId, programId: f.programId,
      amountMinor: 10000, recordedAt: FIXTURE_PAID_AT + HOUR, recorder: f.adminId, providerPaymentId: f.providerPaymentId,
    });
  },
  // Linked with no pointer.
  I4: async (ctx, f) => { await ctx.db.patch("providerPayments", f.paymentB, { reviewState: "linked" }); },
  // A provider row that says it was typed on the web.
  I5: async (ctx, f) => { await ctx.db.patch("paymentRecords", f.rowA, { recordedVia: "web" }); },
  // The held meeting's marked time moved.
  I6: async (ctx, f) => { await ctx.db.patch("meetings", f.heldMeetingId, { heldMarkedAt: FIXTURE_NOW }); },
  // A Booked deal whose booking was canceled.
  I7: async (ctx, f) => { await ctx.db.patch("meetings", f.bookingD, { status: "canceled", canceledAt: FIXTURE_NOW }); },
  // The exclusion's receipt no longer matches the loss.
  I8: async (ctx, f) => {
    const correction = (await ctx.db.get("paymentCorrections", f.correctionB))!;
    await ctx.db.patch("paymentCorrections", f.correctionB, { after: { ...correction.after, lostAt: LOST_AT + 1 } });
  },
  // An enrollment the payments call for is gone.
  I9: async (ctx, f) => {
    const enrollment = (await ctx.db.query("enrollments")
      .withIndex("by_tenantId_and_leadId_and_programId", (q) => q.eq("tenantId", f.tenantId).eq("leadId", f.personId))
      .first())!;
    await ctx.db.delete("enrollments", enrollment._id);
  },
  // The sold program cache was cleared on a won deal.
  I10: async (ctx, f) => { await ctx.db.patch("opportunities", f.dealA, { soldProgramId: undefined, soldProgramName: undefined }); },
  // A second next step on the reopened deal.
  I11: async (ctx, f) => {
    await ctx.db.insert("followUps", {
      tenantId: f.tenantId, opportunityId: f.dealC, leadId: f.personId, closerId: f.closerId, type: "manual_reminder",
      contactMethod: "text", reminderScheduledAt: FIXTURE_NOW, reason: "closer_initiated", status: "pending",
      createdAt: FIXTURE_NOW,
    });
  },
  // The binding's anchor is a disputed row.
  I12: async (ctx, f) => {
    const binding = (await ctx.db.get("paymentProviderBindings", f.bindingId))!;
    if (binding.binding.kind !== "membership_deal") throw new Error("fixture");
    await ctx.db.patch("paymentProviderBindings", f.bindingId, {
      binding: { ...binding.binding, anchorPaymentRecordId: f.rowB },
    });
  },
  // A 41st stored row on D.
  I13: async (ctx, f) => {
    for (let index = 0; index < 41; index += 1) {
      await ctx.db.insert("paymentRecords", {
        tenantId: f.tenantId, opportunityId: f.dealD, attributedCloserId: f.closerId, amountMinor: 100, currency: "USD",
        recordedByUserId: f.adminId, programId: f.programId, programName: "Sales training", paymentType: "pif",
        status: "disputed", recordedAt: FIXTURE_PAID_AT + index, origin: "closer_meeting",
      });
    }
  },
  // A person acted on C after the ready decision was derived.
  I14: async (ctx, f) => { await ctx.db.patch("opportunities", f.dealC, { humanResultRevision: 3 }); },
  // The scheduled meeting on the Whop-won deal lost its marker.
  I15: async (ctx, f) => { await ctx.db.patch("meetings", f.owedMeetingId, { attendanceOwedSince: undefined }); },
  // Free text in a pinned line.
  I16: async (ctx, f) => { await ctx.db.patch("closerPinnedLines", f.lineId, { currency: "US dollars" }); },
};

describe("assertPaymentInvariants", () => {
  it("passes on a tenant where every invariant's condition is in play", async () => {
    const fixture = await invariantFixture();
    await assertPaymentInvariants(fixture.t, { tenantId: fixture.tenantId });
    await assertPaymentInvariants(fixture.t, {
      tenantId: fixture.tenantId,
      opportunityIds: [fixture.dealA, fixture.dealB],
      providerPaymentIds: [fixture.providerPaymentId],
    });
  });

  it.each(INVARIANT_IDS)("%s holds on its own, then breaks on a direct write", async (id) => {
    const fixture = await invariantFixture();
    await assertPaymentInvariants(fixture.t, { tenantId: fixture.tenantId }, { skip: others(id) });
    await fixture.t.run(async (ctx) => await BREAKS[id](ctx, fixture));
    await expectBroken(fixture, id);
  });

  it("lists every broken invariant in one error", async () => {
    const fixture = await invariantFixture();
    await fixture.t.run(async (ctx) => {
      await BREAKS.I2(ctx, fixture);
      await BREAKS.I16(ctx, fixture);
    });
    await expect(assertPaymentInvariants(fixture.t, { tenantId: fixture.tenantId }))
      .rejects.toThrow(/^I2: deal .*\n(.*\n)*I16: pinned line/m);
  });

  it("I6 lets a skipped legitimate change become the new baseline", async () => {
    const fixture = await invariantFixture();
    await assertPaymentInvariants(fixture.t, { tenantId: fixture.tenantId });
    await fixture.t.run(async (ctx) => await BREAKS.I6(ctx, fixture));
    await assertPaymentInvariants(fixture.t, { tenantId: fixture.tenantId }, { skip: ["I6"] });
    await assertPaymentInvariants(fixture.t, { tenantId: fixture.tenantId });
  });
});
