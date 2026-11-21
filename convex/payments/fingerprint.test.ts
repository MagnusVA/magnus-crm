import { describe, expect, it } from "vitest";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { insertMeetingAggregate } from "../reporting/writeHooks";
import {
  FIXTURE_NOW,
  FIXTURE_PAID_AT,
  insertProviderBinding,
  providerPaymentFixture,
} from "../../tests/providerPaymentFixtures";
import { forceOpportunityState } from "../../tests/opportunityFixtures";
import { assertPaymentInvariants, seedProviderWin } from "../../tests/paymentInvariants";
import { paymentStateFingerprint } from "./fingerprint";

const HOUR = 3_600_000;

async function fingerprintFixture() {
  const harness = await providerPaymentFixture({ dealPosition: "booked" });
  const { t, tenantId, adminId, closerId, personId, connectionId, programId, providerPaymentId } = harness;
  const dealId = harness.dealId!;
  const ids = await t.run(async (ctx) => {
    const meetingId = await ctx.db.insert("meetings", {
      tenantId, opportunityId: dealId, assignedCloserId: closerId,
      calendlyEventUri: "https://api.calendly.com/scheduled_events/fp",
      calendlyInviteeUri: "https://api.calendly.com/scheduled_events/fp/invitees/x",
      scheduledAt: FIXTURE_PAID_AT - HOUR, durationMinutes: 30, status: "scheduled", createdAt: FIXTURE_PAID_AT - 2 * HOUR,
    });
    await insertMeetingAggregate(ctx, meetingId);
    const taskId = await ctx.db.insert("followUps", {
      tenantId, opportunityId: dealId, leadId: personId, closerId, type: "manual_reminder", contactMethod: "call",
      reminderScheduledAt: FIXTURE_NOW + HOUR, reason: "closer_initiated", status: "pending", createdAt: FIXTURE_PAID_AT,
    });
    const doneTaskId = await ctx.db.insert("followUps", {
      tenantId, opportunityId: dealId, leadId: personId, closerId, type: "manual_reminder", contactMethod: "call",
      reminderScheduledAt: FIXTURE_PAID_AT, reason: "closer_initiated", status: "completed", createdAt: FIXTURE_PAID_AT,
    });
    const paymentRecordId = await seedProviderWin(ctx, {
      tenantId, opportunityId: dealId, providerPaymentId, programId, closerId, approverId: adminId, recordedAt: FIXTURE_PAID_AT,
    });
    const bindingId = await insertProviderBinding(ctx, {
      tenantId, connectionId, adminId, externalId: "mem_fp",
      binding: { kind: "membership_deal", opportunityId: dealId, leadId: personId, anchorPaymentRecordId: paymentRecordId },
    });
    await ctx.db.patch("providerPayments", providerPaymentId, { membershipId: "mem_fp" });
    return { meetingId, taskId, doneTaskId, paymentRecordId, bindingId };
  });
  const args = {
    tenantId, opportunityId: dealId, paymentRecordId: ids.paymentRecordId, providerPaymentId,
    receiptTaskIds: [ids.doneTaskId], extra: ["exclude", "wrong_match", null] as const,
  };
  const fingerprint = () => t.run((ctx) => paymentStateFingerprint(ctx, args));
  return { ...harness, ...ids, dealId, args, fingerprint };
}

type Fixture = Awaited<ReturnType<typeof fingerprintFixture>>;
type Change = (ctx: MutationCtx, f: Fixture) => Promise<unknown>;

// Every pinned field (build contract §2.1), one direct write each.
const PINNED: Array<[string, Change]> = [
  ["row status", (ctx, f) => ctx.db.patch("paymentRecords", f.paymentRecordId, { status: "verified" })],
  ["row amount", (ctx, f) => ctx.db.patch("paymentRecords", f.paymentRecordId, { amountMinor: 9999 })],
  ["row currency", (ctx, f) => ctx.db.patch("paymentRecords", f.paymentRecordId, { currency: "EUR" })],
  ["row program", async (ctx, f) => {
    const otherProgram = await ctx.db.insert("tenantPrograms", {
      tenantId: f.tenantId, name: "Other", normalizedName: "other", createdAt: 0, createdByUserId: f.adminId, updatedAt: 0,
    });
    await ctx.db.patch("paymentRecords", f.paymentRecordId, { programId: otherProgram });
  }],
  ["row payment type", (ctx, f) => ctx.db.patch("paymentRecords", f.paymentRecordId, { paymentType: "deposit" })],
  ["row recordedAt", (ctx, f) => ctx.db.patch("paymentRecords", f.paymentRecordId, { recordedAt: FIXTURE_PAID_AT + 1 })],
  ["row provider payment", (ctx, f) => ctx.db.patch("paymentRecords", f.paymentRecordId, { providerPaymentId: undefined })],
  ["payment pointer", (ctx, f) => ctx.db.patch("providerPayments", f.providerPaymentId, { paymentRecordId: undefined })],
  ["payment allocation revision", (ctx, f) => ctx.db.patch("providerPayments", f.providerPaymentId, { allocationRevision: 7 })],
  ["payment review state", (ctx, f) => ctx.db.patch("providerPayments", f.providerPaymentId, { reviewState: "linked" })],
  ["payment adverse state", (ctx, f) => ctx.db.patch("providerPayments", f.providerPaymentId, { adverseState: "dispute_open" })],
  ["payment fence", (ctx, f) => ctx.db.patch("providerPayments", f.providerPaymentId, { adverseFencedAt: FIXTURE_NOW })],
  ["payment refund", (ctx, f) => ctx.db.patch("providerPayments", f.providerPaymentId, { refundedMinor: 100 })],
  ["payment source time", (ctx, f) => ctx.db.patch("providerPayments", f.providerPaymentId, { sourceUpdatedAt: FIXTURE_NOW })],
  ["payment not-my-sale flag", (ctx, f) => ctx.db.patch("providerPayments", f.providerPaymentId, { notMySaleAt: FIXTURE_NOW })],
  ["deal stage", (ctx, f) => forceOpportunityState(ctx, f.dealId, { stage: "follow_up", outcome: "open" })],
  ["deal outcome", (ctx, f) => forceOpportunityState(ctx, f.dealId, { outcome: "lost" })],
  ["deal loss reason", (ctx, f) => ctx.db.patch("opportunities", f.dealId, { lostReason: "budget" })],
  ["deal loss actor", (ctx, f) => ctx.db.patch("opportunities", f.dealId, { lostByUserId: f.adminId })],
  ["deal loss time", (ctx, f) => ctx.db.patch("opportunities", f.dealId, { lostAt: FIXTURE_NOW })],
  ["deal first payment time", (ctx, f) => ctx.db.patch("opportunities", f.dealId, { paymentReceivedAt: FIXTURE_NOW })],
  ["deal closer", (ctx, f) => ctx.db.patch("opportunities", f.dealId, { assignedCloserId: f.adminId })],
  ["deal person", async (ctx, f) => {
    const other = await ctx.db.insert("leads", {
      tenantId: f.tenantId, email: "other@example.com", status: "active", firstSeenAt: 0, updatedAt: 0,
      lifecycleStage: "qualified", lifecycleStageEnteredAt: { qualified: 0 }, disposition: "open",
    });
    await ctx.db.patch("opportunities", f.dealId, { leadId: other });
  }],
  ["deal human result revision", (ctx, f) => ctx.db.patch("opportunities", f.dealId, { humanResultRevision: 1 })],
  ["another counting payment", (ctx, f) => ctx.db.insert("paymentRecords", {
    tenantId: f.tenantId, opportunityId: f.dealId, attributedCloserId: f.closerId, amountMinor: 500, currency: "USD",
    recordedByUserId: f.adminId, programId: f.programId, programName: "Sales training", paymentType: "split",
    status: "recorded", recordedAt: FIXTURE_NOW, origin: "closer_additional",
  })],
  ["meeting status", (ctx, f) => ctx.db.patch("meetings", f.meetingId, { status: "held" })],
  ["meeting held time", (ctx, f) => ctx.db.patch("meetings", f.meetingId, { heldMarkedAt: FIXTURE_NOW })],
  ["pending task status", (ctx, f) => ctx.db.patch("followUps", f.taskId, { status: "expired" })],
  ["pending task due time", (ctx, f) => ctx.db.patch("followUps", f.taskId, { reminderScheduledAt: FIXTURE_NOW + 2 * HOUR })],
  ["receipt task status", (ctx, f) => ctx.db.patch("followUps", f.doneTaskId, { status: "pending" })],
  ["binding version", (ctx, f) => ctx.db.patch("paymentProviderBindings", f.bindingId, { version: 2 })],
  ["binding disabled", (ctx, f) => ctx.db.patch("paymentProviderBindings", f.bindingId, { enabled: false })],
];

describe("paymentStateFingerprint", () => {
  it("is a sha256 hex digest, stable across reads", async () => {
    const f = await fingerprintFixture();
    await assertPaymentInvariants(f.t, { tenantId: f.tenantId });
    const first = await f.fingerprint();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(await f.fingerprint()).toBe(first);
  });

  it("ignores updatedAt, latestActivityAt and refreshGeneration", async () => {
    const f = await fingerprintFixture();
    const before = await f.fingerprint();
    await f.t.run(async (ctx) => {
      await ctx.db.patch("opportunities", f.dealId, { updatedAt: FIXTURE_NOW + 9, latestActivityAt: FIXTURE_NOW + 9 });
      await ctx.db.patch("providerPayments", f.providerPaymentId, { refreshGeneration: 42, refreshedAt: FIXTURE_NOW });
    });
    expect(await f.fingerprint()).toBe(before);
  });

  it.each(PINNED)("changes with the %s", async (_name, change) => {
    const f = await fingerprintFixture();
    const before = await f.fingerprint();
    await f.t.run(async (ctx) => { await change(ctx, f); });
    expect(await f.fingerprint()).not.toBe(before);
  });

  it("changes with the operation's extra values", async () => {
    const f = await fingerprintFixture();
    const pinned = await f.fingerprint();
    const other = await f.t.run((ctx) => paymentStateFingerprint(ctx, { ...f.args, extra: ["exclude", "refund", null] }));
    expect(other).not.toBe(pinned);
  });

  it("refuses a deal from another tenant", async () => {
    const f = await fingerprintFixture();
    const otherTenant = await f.t.run((ctx) => ctx.db.insert("tenants", {
      businessDayAppliedVersion: 0, companyName: "Other", contactEmail: "o@example.com", workosOrgId: "org_other",
      status: "active", inviteExpiresAt: 0, createdBy: "test",
    }));
    await expect(f.t.run((ctx) => paymentStateFingerprint(ctx, {
      tenantId: otherTenant as Id<"tenants">, opportunityId: f.dealId,
    }))).rejects.toThrow("not found in this tenant");
  });

  it("throws past its task bound rather than pin part of them", async () => {
    const f = await fingerprintFixture();
    await f.t.run(async (ctx) => {
      for (let index = 0; index < 21; index += 1) {
        await ctx.db.insert("followUps", {
          tenantId: f.tenantId, opportunityId: f.dealId, leadId: f.personId, closerId: f.closerId, type: "manual_reminder",
          reason: "stale_opportunity_nudge", status: "pending", createdAt: FIXTURE_NOW + index,
        });
      }
    });
    await expect(f.fingerprint()).rejects.toThrow("more than 20 pending tasks");
  });
});
