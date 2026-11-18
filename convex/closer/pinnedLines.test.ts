import { expect, it } from "vitest";
import { assertPaymentInvariants } from "../../tests/paymentInvariants";
import { FIXTURE_NOW, paymentConfirmationApi, paymentConfirmationFixture } from "../../tests/providerPaymentFixtures";
import { addPinnedLine } from "../lib/pinnedLines";

const { listMyPinnedLines, dismissPinnedLine } = paymentConfirmationApi.closer.pinnedLines;

it("lists the closer's newest 20 lines and dismisses only their own line", async () => {
  const f = await paymentConfirmationFixture();
  const { own, other } = await f.t.run(async (ctx) => {
    const otherId = await ctx.db.insert("users", {
      tenantId: f.tenantId, workosUserId: "user_other", email: "other@example.com", role: "closer", isActive: true,
    });
    const line = { tenantId: f.tenantId, opportunityId: f.dealId, kind: "win_removed" as const };
    const own = [];
    for (let i = 0; i < 21; i++) {
      own.push(await addPinnedLine(ctx, { ...line, userId: f.closerId, createdAt: FIXTURE_NOW + i }));
    }
    const other = await addPinnedLine(ctx, { ...line, userId: otherId, createdAt: FIXTURE_NOW + 100 });
    return { own, other };
  });
  const otherClient = f.t.withIdentity({ subject: "user_other", org_id: "org_test" });
  const invariant = () => assertPaymentInvariants(f.t, { tenantId: f.tenantId });
  await invariant();
  const lines = await f.closer.query(listMyPinnedLines, {});
  expect(lines.map((line) => line._id)).toEqual(own.slice(1).reverse());
  expect(lines[0]).toMatchObject({ leadId: f.personId, personName: "River Patel" });
  expect((await otherClient.query(listMyPinnedLines, {})).map((line) => line._id)).toEqual([other]);
  expect(await f.closer.mutation(dismissPinnedLine, { lineId: other })).toEqual({ ok: false, code: "not_owner" });
  await invariant();
  const args = { lineId: own[20] };
  expect(await f.closer.mutation(dismissPinnedLine, args)).toEqual({ ok: true, alreadyApplied: false });
  await invariant();
  expect(await f.closer.mutation(dismissPinnedLine, args)).toEqual({ ok: true, alreadyApplied: true });
  await invariant();
  expect((await f.closer.query(listMyPinnedLines, {})).map((line) => line._id)).toEqual(own.slice(0, 20).reverse());
  await expect(f.admin.query(listMyPinnedLines, {})).rejects.toThrow();
});

it("returns the named task even after completion and hides a foreign-tenant task", async () => {
  const f = await paymentConfirmationFixture();
  const scheduledAt = FIXTURE_NOW + 60_000;
  const { payment, callback, foreign, missing } = await f.t.run(async (ctx) => {
    const otherTenantId = await ctx.db.insert("tenants", {
      companyName: "Other tenant",
      contactEmail: "other@example.com",
      workosOrgId: "org_other",
      status: "active",
      inviteExpiresAt: 0,
      createdBy: "seed",
    });
    const task = {
      tenantId: f.tenantId, opportunityId: f.dealId, leadId: f.personId, closerId: f.closerId,
      type: "manual_reminder" as const, reason: "closer_initiated" as const,
      reminderScheduledAt: scheduledAt, createdAt: FIXTURE_NOW,
    };
    const line = {
      tenantId: f.tenantId, opportunityId: f.dealId, userId: f.closerId,
      kind: "call_result_set" as const, createdAt: FIXTURE_NOW,
    };
    const paymentId = await ctx.db.insert("followUps", {
      ...task, purpose: "payment_owed", contactMethod: "text", status: "completed",
    });
    const callbackId = await ctx.db.insert("followUps", {
      ...task, purpose: "call_back", contactMethod: "call", status: "pending",
    });
    const foreignId = await ctx.db.insert("followUps", {
      ...task, tenantId: otherTenantId, purpose: "call_back", contactMethod: "call", status: "pending",
    });
    return {
      payment: await addPinnedLine(ctx, { ...line, followUpId: paymentId }),
      callback: await addPinnedLine(ctx, { ...line, followUpId: callbackId }),
      foreign: await addPinnedLine(ctx, { ...line, followUpId: foreignId }),
      missing: await addPinnedLine(ctx, line),
    };
  });
  const lines = await f.closer.query(listMyPinnedLines, {});
  expect(lines).toHaveLength(4);
  expect(lines).toEqual(expect.arrayContaining([
    expect.objectContaining({
      _id: payment, taskPurpose: "payment_owed", taskContactMethod: "text", taskScheduledAt: scheduledAt,
    }),
    expect.objectContaining({
      _id: callback, taskPurpose: "call_back", taskContactMethod: "call", taskScheduledAt: scheduledAt,
    }),
    ...[foreign, missing].map((_id) => expect.objectContaining({
      _id, taskPurpose: null, taskContactMethod: null, taskScheduledAt: null,
    })),
  ]));
});
