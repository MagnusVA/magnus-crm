import { internal } from "../_generated/api";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  ACCOUNT_ID, PAYMENT_ID, TEST_DAY_MS, TEST_TIME, iso, paymentFixture, whopFixture,
} from "../../tests/whopFixtures";
import { SWEEP_OVERLAP_MS } from "./reconcile";
import { normalizePayment, paymentSchema } from "./whop/normalize";

type Fixture = Awaited<ReturnType<typeof whopFixture>>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TEST_TIME);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function stubApi(handler: (url: URL) => Response) {
  const requests: URL[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const request = new URL(url);
    requests.push(request);
    vi.setSystemTime(Date.now() + 200);
    return handler(request);
  }));
  return requests;
}

function listPage(ids: string[], nextCursor: string | null = null) {
  return Response.json({
    data: ids.map((id) => ({ id, account_id: ACCOUNT_ID })),
    page_info: { has_next_page: nextCursor !== null, end_cursor: nextCursor },
  });
}

function connection(fixture: Fixture) {
  return fixture.t.query(internal.payments.connectionState.connection, { connectionId: fixture.connectionId });
}

async function seedRead(fixture: Fixture, overrides: Record<string, unknown> = {}) {
  const row = (await connection(fixture))!;
  const payment = normalizePayment(paymentSchema.parse(paymentFixture(overrides)));
  const identity = {
    connectionId: row._id, accountId: row.accountId,
    connectedAt: row.connectedAt, externalPaymentId: payment.externalPaymentId,
  };
  const generation = (await fixture.t.mutation(internal.payments.intake.beginPaymentRead, identity))!;
  await fixture.t.mutation(internal.payments.intake.storePaymentRead, { ...identity, generation, payment });
  return await fixture.t.run(async (ctx) => {
    const [stored] = await ctx.db.query("providerPayments")
      .withIndex("by_tenantId_and_connectionId_and_externalPaymentId",
        (q) => q.eq("tenantId", row.tenantId).eq("connectionId", row._id)
          .eq("externalPaymentId", payment.externalPaymentId))
      .take(1);
    return stored;
  });
}

test("pages a recent sweep with independent overlapping windows and rereads old open rows", async () => {
  const previousThrough = TEST_TIME - 15 * 60_000;
  const fixture = await whopFixture({ sweepCreatedThrough: previousThrough });
  const { t, connectionId } = fixture;
  const known = await seedRead(fixture, {
    id: "pay_old_fixture", status: "open", created_at: iso(TEST_TIME - 5 * TEST_DAY_MS),
  });
  const requests = stubApi((url) => {
    if (url.pathname !== "/api/v1/payments") {
      return Response.json(paymentFixture({
        id: url.pathname.split("/").at(-1),
        updated_at: iso(TEST_TIME + 1000),
      }));
    }
    if (url.searchParams.has("created_after")) {
      return url.searchParams.has("after") ? listPage(["pay_page_two_fixture"])
        : listPage([PAYMENT_ID], "recent_next_fixture");
    }
    return listPage([]);
  });

  await t.action(internal.payments.reconcile.sweepRecent, { connectionId, through: TEST_TIME });
  expect((await connection(fixture))?.sweepCreatedThrough).toBe(previousThrough);
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const lists = requests.filter((request) => request.pathname === "/api/v1/payments");
  expect(lists).toHaveLength(5);
  expect(lists[1].searchParams.get("after")).toBe("recent_next_fixture");
  for (const [index, window] of ["created", "created", "refunded", "dispute_created", "dispute_alerted"].entries()) {
    const query = lists[index].searchParams;
    expect(Object.fromEntries(query)).toMatchObject({
      mode: "account_sales", account_id: ACCOUNT_ID, first: "20",
      order: "created_at", direction: "asc",
      [`${window}_after`]: iso(previousThrough - SWEEP_OVERLAP_MS),
      [`${window}_before`]: iso(TEST_TIME),
    });
  }
  expect(requests.map(({ pathname }) => pathname)).toContain("/api/v1/payments/pay_old_fixture");
  expect(await t.run((ctx) => ctx.db.get("providerPayments", known._id))).toMatchObject({ status: "paid" });
  expect(await connection(fixture)).toMatchObject({
    sweepCreatedThrough: TEST_TIME, lastSuccessfulSweepAt: expect.any(Number),
  });
  expect((await connection(fixture))?.sweepToken).toBeUndefined();
});

test("checkpoints the nightly cursor and resumes the same fixed window next invocation", async () => {
  const fixture = await whopFixture();
  const { t, connectionId } = fixture;
  const requests = stubApi((url) => {
    if (url.pathname !== "/api/v1/payments") {
      return Response.json(paymentFixture({
        id: url.pathname.split("/").at(-1), created_at: iso(TEST_TIME - TEST_DAY_MS),
      }));
    }
    return url.searchParams.has("after")
      ? listPage(["pay_full_second_fixture"])
      : listPage([PAYMENT_ID], "full_next_fixture");
  });
  await t.action(internal.payments.reconcile.scanFull, { connectionId, startedAt: TEST_TIME });
  expect(await connection(fixture)).toMatchObject({
    fullScanCursor: "full_next_fixture", fullScanStartedAt: TEST_TIME,
  });
  expect((await connection(fixture))?.lastFullScanAt).toBeUndefined();
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const lists = requests.filter((request) => request.pathname === "/api/v1/payments");
  expect(lists.map((request) => request.searchParams.get("after"))).toEqual([null, "full_next_fixture"]);
  expect(lists.map((request) => request.searchParams.get("created_before"))).toEqual([iso(TEST_TIME), iso(TEST_TIME)]);
  const finished = await connection(fixture);
  expect(finished?.lastFullScanAt).toBeGreaterThanOrEqual(TEST_TIME);
  expect(finished?.fullScanCursor).toBeUndefined();
  expect(finished?.fullScanStartedAt).toBeUndefined();
  expect(await t.run((ctx) => ctx.db.query("providerPayments").take(10))).toHaveLength(2);
});

test("allows one lease per connection and refuses a stale release", async () => {
  const fixture = await whopFixture();
  const { t, connectionId } = fixture;
  const connectedAt = (await connection(fixture))!.connectedAt;
  const first = { connectionId, token: "first_fixture" };
  const second = { connectionId, token: "second_fixture" };
  expect(await t.mutation(internal.payments.connectionState.takeSweepLease, first)).toBe("acquired");
  expect(await t.mutation(internal.payments.connectionState.takeSweepLease, second)).toBe("busy");
  const expiry = (await connection(fixture))!.sweepUntil!;
  vi.setSystemTime(expiry + 1);
  expect(await t.mutation(internal.payments.connectionState.takeSweepLease, second)).toBe("acquired");
  expect(await t.mutation(internal.payments.connectionState.releaseSweepLease, {
    ...first, connectedAt, checkpoint: { kind: "recent", through: TEST_TIME },
  })).toBe(false);
  expect((await connection(fixture))?.sweepToken).toBe(second.token);
  expect(await t.mutation(internal.payments.connectionState.releaseSweepLease, { ...second, connectedAt })).toBe(true);
});

test("persists the request clock and honors a provider pause and invalid key", async () => {
  const fixture = await whopFixture();
  const { t, connectionId } = fixture;
  const connectedAt = (await connection(fixture))!.connectedAt;
  const args = { connectionId, connectedAt };
  const state = internal.payments.connectionState;
  expect((await t.mutation(state.reserveRequest, args)).state).toBe("reserved");
  expect(await t.mutation(state.reserveRequest, args)).toEqual({
    state: "waiting", retryAt: TEST_TIME + 150,
  });
  await t.mutation(state.recordFailure, { ...args, code: "rate_limited", retryAfterMs: 42_000 });
  vi.setSystemTime(TEST_TIME + 150);
  expect(await t.mutation(state.reserveRequest, args)).toEqual({
    state: "waiting", retryAt: TEST_TIME + 42_000,
  });
  await t.mutation(state.recordFailure, { ...args, code: "unauthorized" });
  expect((await t.mutation(state.reserveRequest, args)).state).toBe("unavailable");
  expect(await connection(fixture)).toMatchObject({ status: "invalid_key", lastErrorCode: "unauthorized" });
});

test("purges expired raw files and payer details while retaining receipts and fresh facts", async () => {
  const fixture = await whopFixture();
  const { t, connectionId, tenantId } = fixture;
  const expiredPayment = await seedRead(fixture);
  const freshPayment = await seedRead(fixture, { id: "pay_fresh_fixture" });
  const { oldReceipt, freshReceipt, oldBody, freshBody } = await t.run(async (ctx) => {
    const oldBody = await ctx.storage.store(new Blob(["expired fixture"]));
    const freshBody = await ctx.storage.store(new Blob(["fresh fixture"]));
    const common = {
      tenantId, connectionId, eventType: "payment.succeeded",
      bodySha256: "fixture_hash", status: "processed", attempts: 1,
    } as const;
    const oldReceipt = await ctx.db.insert("paymentWebhookReceipts", {
      ...common, webhookId: "msg_expired_fixture", rawBodyStorageId: oldBody, receivedAt: TEST_TIME - 7 * TEST_DAY_MS,
    });
    const freshReceipt = await ctx.db.insert("paymentWebhookReceipts", {
      ...common, webhookId: "msg_fresh_fixture", rawBodyStorageId: freshBody, receivedAt: TEST_TIME - 6 * TEST_DAY_MS,
    });
    await ctx.db.patch("providerPayments", expiredPayment._id, {
      resolvedAt: TEST_TIME - 90 * TEST_DAY_MS, reviewState: "dismissed",
    });
    await ctx.db.patch("providerPayments", freshPayment._id, {
      resolvedAt: TEST_TIME - 89 * TEST_DAY_MS, reviewState: "dismissed",
    });
    return { oldReceipt, freshReceipt, oldBody, freshBody };
  });
  await t.mutation(internal.payments.reconcile.purge, {});
  const retention = await t.run(async (ctx) => ({
    oldReceipt: await ctx.db.get("paymentWebhookReceipts", oldReceipt),
    freshReceipt: await ctx.db.get("paymentWebhookReceipts", freshReceipt),
    oldBody: await ctx.db.system.get("_storage", oldBody),
    freshBody: await ctx.db.system.get("_storage", freshBody),
    freshPayment: await ctx.db.get("providerPayments", freshPayment._id),
    expiredPayment: await ctx.db.get("providerPayments", expiredPayment._id),
  }));
  expect(retention.oldBody).toBeNull();
  expect(retention.freshBody).not.toBeNull();
  expect(retention.oldReceipt).toMatchObject({ status: "processed", rawBodyDeletedAt: TEST_TIME });
  expect(retention.oldReceipt?.rawBodyStorageId).toBeUndefined();
  expect(retention.freshReceipt?.rawBodyStorageId).toBe(freshBody);
  expect(retention.freshPayment?.payerEmail).toBe(freshPayment.payerEmail);
  expect(retention.expiredPayment?.payerEmail).toBeUndefined();
  expect(retention.expiredPayment?.payerPhone).toBeUndefined();
  expect(retention.expiredPayment?.payerDetailsClearedAt).toBe(TEST_TIME);
  const readAgain = await seedRead(fixture, { updated_at: iso(TEST_TIME + 1000) });
  expect(readAgain.payerEmail).toBeUndefined();
  expect(readAgain.payerPhone).toBeUndefined();
  expect(readAgain.payerDetailsClearedAt).toBe(TEST_TIME);
});
