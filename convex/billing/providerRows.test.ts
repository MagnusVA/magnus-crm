import { expect, it } from "vitest";
import { bookingHarness } from "../../tests/bookingHarness";
import { insertOtherTenant } from "../../tests/dealStateFixtures";
import {
  fixtureUsers,
  insertPayment,
  insertProgram,
  seedCustomer,
  T0,
} from "../../tests/enrollmentReadFixtures";
import { seedProviderRow } from "../../tests/providerRowFixtures";
import { api } from "../_generated/api";
import { paymentSums } from "../reporting/aggregates";
import { insertPaymentAggregate } from "../reporting/writeHooks";

async function billingFixture() {
  const harness = await bookingHarness();
  const { t, tenantId } = harness;
  const fixture = await t.run(async (ctx) => {
    const { admin, closer } = await fixtureUsers(ctx, tenantId);
    await ctx.db.patch("tenants", tenantId, { billingOpsEnabled: true });
    await ctx.db.patch("users", admin._id, { fullName: "Billie Reviewer" });
    const programId = await insertProgram(ctx, tenantId, admin._id, "Program A");
    const customer = await seedCustomer(ctx, tenantId, {
      closerId: closer._id,
      programId,
      paidAt: T0,
      amountMinor: 10_000,
    });
    await insertPaymentAggregate(ctx, customer.paymentId);
    return {
      opportunityId: customer.opportunityId,
      existingPaymentId: customer.paymentId,
      closerId: closer._id,
      recorderId: admin._id,
      programId,
    };
  });
  return { ...harness, ...fixture };
}

it("reads Whop bylines through the queue, detail, audit and export", async () => {
  const { t, admin, tenantId, opportunityId, closerId, recorderId, programId, existingPaymentId } =
    await billingFixture();
  const providerPaidAt = T0 - 60_000;
  const { confirmed, automatic, missing } = await t.run(async (ctx) => {
    const provider = {
      tenantId, opportunityId, closerId, programId, providerPaidAt, amountMinor: 30_000,
    };
    const confirmed = await seedProviderRow(ctx, {
      ...provider, recordedAt: T0 + 1_000, recorder: recorderId,
    });
    const automatic = await seedProviderRow(ctx, {
      ...provider, recordedAt: T0 + 2_000, recorder: "absent",
    });
    const missing = await insertPayment(ctx, {
      tenantId, opportunityId, programId, recordedAt: T0 + 3_000, recordedByUserId: closerId,
    });
    await ctx.db.patch("paymentRecords", missing, { recordedByUserId: undefined });
    await insertPaymentAggregate(ctx, missing);
    return { confirmed, automatic, missing };
  });

  const list = await admin.query(api.billing.queries.listPayments, {
    status: "recorded", paginationOpts: { numItems: 10, cursor: null },
  });
  const audit = await admin.query(api.billing.audit.getPaymentAuditSnapshot, {});
  const exported = await admin.query(api.billing.queries.exportPayments, { status: "recorded" });

  expect(list.exactCount).toBe(4);
  expect(exported.exportedCount).toBe(4);
  for (const { paymentRecordId, byline, recorder, recordedAt } of [
    {
      paymentRecordId: confirmed,
      byline: "Confirmed from Whop by Billie Reviewer",
      recorder: recorderId,
      recordedAt: T0 + 1_000,
    },
    {
      paymentRecordId: automatic,
      byline: "Recorded automatically from Whop",
      recorder: null,
      recordedAt: T0 + 2_000,
    },
  ]) {
    const queueRow = list.page.find(({ payment }) => payment.id === paymentRecordId);
    const detail = await admin.query(api.billing.queries.getPaymentDetail, { paymentRecordId });
    const diagnostic = audit.sampleDiagnostics.find((row) => row.paymentRecordId === paymentRecordId);
    const exportRow = exported.rows.find((row) => row.paymentId === paymentRecordId);

    expect(queueRow?.payment).toMatchObject({ recordedVia: "provider", providerByline: byline });
    expect(detail?.payment).toMatchObject({
      origin: "provider", recordedVia: "provider", providerByline: byline, providerPaidAt, recordedAt,
    });
    expect(detail?.enteredBy.id).toBe(recorder);
    if (recorder === null) {
      expect(detail?.enteredBy).toEqual({ id: null, name: byline, identity: null });
    }
    expect(diagnostic?.recordedByUser).toEqual({ resolved: recorder !== null, providerByline: byline });
    expect(exportRow).toMatchObject({ enteredBy: byline, paidAt: recordedAt });
    expect(JSON.stringify([queueRow, detail, diagnostic, exportRow])).not.toMatch(/Missing user|Unknown/);
  }

  expect(audit.metrics.missingRecordedByUser).toBe(1);
  expect(audit.issueSamples.filter(({ issue }) => issue === "missingRecordedByUser")).toEqual([
    {
      paymentRecordId: missing,
      issue: "missingRecordedByUser",
      detail: "recordedByUserId does not resolve to a tenant user",
    },
  ]);
  const missingDetail = await admin.query(api.billing.queries.getPaymentDetail, { paymentRecordId: missing });
  expect(missingDetail?.enteredBy.name).toBe("Missing user");

  const existing = await admin.query(api.billing.queries.getPaymentDetail, { paymentRecordId: existingPaymentId });
  expect(existing?.enteredBy.name).toBe("closer@example.com");
  expect(existing?.payment).not.toHaveProperty("providerPaidAt");
  expect(list.page.find(({ payment }) => payment.id === existingPaymentId)?.payment).toEqual({
    id: existingPaymentId,
    amountMinor: 10_000,
    currency: "USD",
    recordedAt: T0,
    status: "recorded",
    paymentType: "pif",
    programName: "Program A",
    hasProofFile: false,
    recordedVia: null,
    agentClient: null,
    proofReused: false,
  });
  expect(audit.sampleDiagnostics.find((row) => row.paymentRecordId === existingPaymentId)?.recordedByUser)
    .toEqual({ resolved: true });
  expect(exported.rows.find((row) => row.paymentId === existingPaymentId)?.enteredBy).toBe("closer@example.com");
});

it("puts disputed Whop and manual payments in the disputed queue and keeps both out of cash", async () => {
  const { t, admin, tenantId, opportunityId, closerId, programId } = await billingFixture();
  const { provider, manual } = await t.run(async (ctx) => {
    const payment = { tenantId, opportunityId, programId, amountMinor: 40_000, recordedAt: T0 + 1_000 };
    const provider = await seedProviderRow(ctx, {
      ...payment, closerId, recorder: "absent", status: "disputed",
    });
    const manual = await insertPayment(ctx, {
      ...payment, recordedByUserId: closerId, status: "disputed",
    });
    await insertPaymentAggregate(ctx, manual);
    return { provider, manual };
  });

  const disputed = await admin.query(api.billing.queries.listPayments, {
    status: "disputed", paginationOpts: { numItems: 10, cursor: null },
  });
  expect(disputed.exactCount).toBe(2);
  expect(disputed.page.map(({ payment }) => payment.id)).toEqual(expect.arrayContaining([provider, manual]));
  await t.run(async (ctx) => {
    expect(await paymentSums.count(ctx, { namespace: tenantId })).toBe(3);
    expect(await paymentSums.sum(ctx, { namespace: tenantId })).toBe(10_000);
  });
});

it("returns the latest ten correction receipts and the latest exclusion awaiting restore", async () => {
  const { t, admin, closer, tenantId, opportunityId, recorderId, existingPaymentId, programId } = await billingFixture();
  const { newest, lastRestored, latestRestore, otherPaymentId } = await t.run(async (ctx) => {
    const deal = (await ctx.db.get("opportunities", opportunityId))!;
    const common = {
      tenantId, opportunityId, leadId: deal.leadId, paymentRecordId: existingPaymentId,
      actorUserId: recorderId, tasks: [], removedEnrollments: [],
      before: { paymentStatus: "recorded" as const, dealPosition: "won" as const },
      after: { dealPosition: "won" as const, humanResultRevision: 1 },
    };
    const addExclusion = (createdAt: number) => ctx.db.insert("paymentCorrections", {
      ...common, operation: "exclude", result: "kept_won", cause: "wrong_match", level: "reviewed",
      createdAt, requestKey: `exclude-${createdAt}`,
    });
    let lastRestored;
    let latestRestore;
    for (let i = 0; i < 5; i++) {
      const createdAt = T0 + i * 2;
      lastRestored = await addExclusion(createdAt);
      latestRestore = await ctx.db.insert("paymentCorrections", {
        ...common, operation: "restore", result: "restored_kept_won", restoresCorrectionId: lastRestored,
        createdAt: createdAt + 1, requestKey: `restore-${createdAt}`,
      });
      await ctx.db.patch("paymentCorrections", lastRestored, { restoredByCorrectionId: latestRestore });
    }
    const newest = await addExclusion(T0 + 10);
    const otherTenantId = await insertOtherTenant(ctx);
    const otherPaymentId = await insertPayment(ctx, {
      tenantId: otherTenantId, opportunityId, programId, recordedAt: T0, recordedByUserId: recorderId,
    });
    await ctx.db.insert("paymentCorrections", {
      ...common, tenantId: otherTenantId, paymentRecordId: otherPaymentId,
      operation: "exclude", result: "kept_won", cause: "refund", level: "undo", createdAt: T0, requestKey: "other-tenant",
    });
    return { newest, lastRestored, latestRestore, otherPaymentId };
  });

  const args = { paymentRecordId: existingPaymentId };
  const history = await admin.query(api.billing.queries.getPaymentCorrections, args);
  expect(history.restorable).toBe(newest);
  expect(history.corrections.map((row) => row.createdAt)).toEqual(Array.from({ length: 10 }, (_, i) => T0 + 10 - i));
  expect(history.corrections.slice(0, 3)).toEqual([
    {
      correctionId: newest, operation: "exclude", result: "kept_won", cause: "wrong_match", level: "reviewed",
      actorName: "Billie Reviewer", createdAt: T0 + 10,
    },
    {
      correctionId: latestRestore, operation: "restore", result: "restored_kept_won",
      actorName: "Billie Reviewer", createdAt: T0 + 9,
    },
    {
      correctionId: lastRestored, operation: "exclude", result: "kept_won", cause: "wrong_match", level: "reviewed",
      actorName: "Billie Reviewer", createdAt: T0 + 8, restoredByCorrectionId: latestRestore,
    },
  ]);
  await expect(closer.query(api.billing.queries.getPaymentCorrections, args)).rejects.toThrow();
  expect(await admin.query(api.billing.queries.getPaymentCorrections, { paymentRecordId: otherPaymentId }))
    .toEqual({ corrections: [], restorable: null });
});
