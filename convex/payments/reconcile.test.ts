import { insertProviderFact } from "../../tests/providerPaymentFixtures";
import { api, internal } from "../_generated/api";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  ACCOUNT_ID, PAYMENT_ID, TEST_DAY_MS, TEST_TIME, iso, paymentFixture, whopFixture,
} from "../../tests/whopFixtures";
import { SWEEP_OVERLAP_MS, SWEEP_PAGE_BUDGET } from "./reconcile";
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

function stubApi(handler: (url: URL) => Response | Promise<Response>) {
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

test("pages a recent sweep with independent overlapping windows and rereads old draft rows", async () => {
  const previousThrough = TEST_TIME - 15 * 60_000;
  const fixture = await whopFixture({ sweepCreatedThrough: previousThrough });
  const { t, connectionId } = fixture;
  const known = await seedRead(fixture, {
    id: "pay_old_fixture", status: "draft", created_at: iso(TEST_TIME - 5 * TEST_DAY_MS),
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
    sweepCreatedThrough: TEST_TIME, lastSuccessfulSweepAt: TEST_TIME,
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

test("purges expired raw bodies and payer details while retaining receipts and fresh facts", async () => {
  const fixture = await whopFixture();
  const { t, connectionId, tenantId } = fixture;
  const expiredPayment = await seedRead(fixture);
  const freshPayment = await seedRead(fixture, { id: "pay_fresh_fixture" });
  const { oldReceipt, freshReceipt } = await t.run(async (ctx) => {
    const common = {
      tenantId, connectionId, eventType: "payment.succeeded",
      bodySha256: "fixture_hash", hasRawBody: true, status: "processed", attempts: 1,
    } as const;
    const oldReceipt = await ctx.db.insert("paymentWebhookReceipts", {
      ...common, webhookId: "msg_expired_fixture", rawBody: "old fixture", receivedAt: TEST_TIME - 7 * TEST_DAY_MS,
    });
    const freshReceipt = await ctx.db.insert("paymentWebhookReceipts", {
      ...common, webhookId: "msg_fresh_fixture", rawBody: "fresh fixture", receivedAt: TEST_TIME - 6 * TEST_DAY_MS,
    });
    await ctx.db.patch("providerPayments", expiredPayment._id, {
      payerDetailsExpireAt: TEST_TIME, resolvedAt: TEST_TIME - 90 * TEST_DAY_MS, reviewState: "dismissed",
    });
    await ctx.db.patch("providerPayments", freshPayment._id, {
      resolvedAt: TEST_TIME - 89 * TEST_DAY_MS, reviewState: "dismissed",
    });
    return { oldReceipt, freshReceipt };
  });
  await t.mutation(internal.payments.reconcile.purge, {});
  const retention = await t.run(async (ctx) => ({
    oldReceipt: await ctx.db.get("paymentWebhookReceipts", oldReceipt),
    freshReceipt: await ctx.db.get("paymentWebhookReceipts", freshReceipt),
    freshPayment: await ctx.db.get("providerPayments", freshPayment._id),
    expiredPayment: await ctx.db.get("providerPayments", expiredPayment._id),
  }));
  expect(retention.oldReceipt).toMatchObject({ status: "processed", rawBodyDeletedAt: TEST_TIME });
  expect(retention.oldReceipt?.rawBody).toBeUndefined();
  expect(retention.freshReceipt?.rawBody).toBe("fresh fixture");
  expect(retention.freshPayment?.payerEmail).toBe(freshPayment.payerEmail);
  expect(retention.expiredPayment?.payerEmail).toBeUndefined();
  expect(retention.expiredPayment?.payerPhone).toBeUndefined();
  expect(retention.expiredPayment?.payerDetailsClearedAt).toBe(TEST_TIME);
  const readAgain = await seedRead(fixture, { updated_at: iso(TEST_TIME + 1000) });
  expect(readAgain.payerEmail).toBeUndefined();
  expect(readAgain.payerPhone).toBeUndefined();
  expect(readAgain.payerDetailsClearedAt).toBe(TEST_TIME);
});

test.each(["recent", "full"] as const)("records unreadable details and finishes the rest of a %s sweep", async (kind) => {
  const fixture = await whopFixture();
  const { t, connectionId } = fixture;
  const requests = stubApi((url) => {
    if (url.pathname === "/api/v1/payments") {
      return url.searchParams.has("created_before")
        ? listPage(["pay_missing", "pay_bad", PAYMENT_ID]) : listPage([]);
    }
    if (url.pathname.endsWith("/pay_missing")) return new Response(null, { status: 404 });
    if (url.pathname.endsWith("/pay_bad")) return Response.json({ synthetic: "invalid detail" });
    return Response.json(paymentFixture());
  });
  if (kind === "recent") await t.action(internal.payments.reconcile.sweepRecent, { connectionId, through: TEST_TIME });
  else await t.action(internal.payments.reconcile.scanFull, { connectionId, startedAt: TEST_TIME });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const row = await connection(fixture);
  const facts = await t.run((ctx) => ctx.db.query("providerPayments").take(10));
  expect(facts.filter((fact) => fact.retryReadAttempts !== undefined)).toMatchObject([
    { externalPaymentId: "pay_missing", retryReadAttempts: 1, retryReadAt: expect.any(Number) },
    { externalPaymentId: "pay_bad", retryReadAttempts: 1, retryReadAt: expect.any(Number) },
  ]);
  expect(kind === "recent" ? row?.lastSuccessfulSweepAt : row?.lastFullScanAt).toBeGreaterThanOrEqual(TEST_TIME);
  expect(requests.some((url) => url.pathname.endsWith(`/${PAYMENT_ID}`))).toBe(true);
  expect(facts).toContainEqual(expect.objectContaining({ externalPaymentId: PAYMENT_ID, status: "paid" }));
});

test.each([429, 503])("resumes a provider-wide HTTP %s failure at the same page and through timestamp", async (status) => {
  const fixture = await whopFixture();
  const { t, connectionId } = fixture;
  let failed = false;
  const requests = stubApi((url) => {
    if (url.pathname !== "/api/v1/payments") return Response.json(paymentFixture());
    if (!url.searchParams.has("created_after")) return listPage([]);
    if (!url.searchParams.has("after")) return listPage([], "resume_here");
    if (!failed) {
      failed = true;
      return new Response(null, { status, headers: { "Retry-After": "0" } });
    }
    return listPage([]);
  });
  await t.action(internal.payments.reconcile.sweepRecent, { connectionId, through: TEST_TIME });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect((await connection(fixture))?.recentSweepProgress)
    .toMatchObject({ through: TEST_TIME, cursor: "resume_here" });
  expect((await connection(fixture))?.lastSuccessfulSweepAt).toBeUndefined();
  await t.action(internal.payments.reconcile.sweepRecent, { connectionId, through: TEST_TIME + 60_000 });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(await connection(fixture)).toMatchObject({
    sweepCreatedThrough: TEST_TIME, lastSuccessfulSweepAt: TEST_TIME,
  });
  const createdWindows = requests.filter((url) => url.searchParams.has("created_after"));
  expect(createdWindows.map((url) => url.searchParams.get("after"))).toEqual([null, "resume_here", "resume_here"]);
  expect(createdWindows.every((url) => url.searchParams.get("created_before") === iso(TEST_TIME))).toBe(true);
});

test.each(["recent", "full"] as const)("stops a %s sweep when the provider repeats a non-adjacent cursor", async (kind) => {
  const fixture = await whopFixture();
  const { t, connectionId } = fixture;
  const requests = stubApi((url) => {
    switch (url.searchParams.get("after")) {
      case "a": return listPage([], "b");
      case "b": return listPage([], "a");
      default: return listPage([], "a");
    }
  });
  if (kind === "recent") await t.action(internal.payments.reconcile.sweepRecent, { connectionId, through: TEST_TIME });
  else await t.action(internal.payments.reconcile.scanFull, { connectionId, startedAt: TEST_TIME });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(requests.map((url) => url.searchParams.get("after"))).toEqual([null, "a", "b"]);
  const row = await connection(fixture);
  expect(row?.sweepToken).toBeUndefined();
  expect(row?.lastSuccessfulSweepAt).toBeUndefined();
  expect(row?.lastFullScanAt).toBeUndefined();
});

test.each(["recent", "full"] as const)("shares a cumulative %s page budget across workpool continuations", async (kind) => {
  const fixture = await whopFixture();
  const { t, connectionId } = fixture;
  let page = 0;
  const requests = stubApi(() => listPage([], `cursor_${++page}`));
  if (kind === "recent") await t.action(internal.payments.reconcile.sweepRecent, {
    connectionId, through: TEST_TIME, pages: SWEEP_PAGE_BUDGET - 2,
  });
  else await t.action(internal.payments.reconcile.scanFull, {
    connectionId, startedAt: TEST_TIME, pages: SWEEP_PAGE_BUDGET - 2,
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(requests.map((url) => url.searchParams.get("after"))).toEqual([null, "cursor_1"]);
  const row = await connection(fixture);
  expect(row?.sweepToken).toBeUndefined();
  expect(row?.lastSuccessfulSweepAt).toBeUndefined();
  expect(row?.lastFullScanAt).toBeUndefined();
  expect(kind === "recent" ? row?.recentSweepProgress?.cursor : row?.fullScanCursor).toBe("cursor_2");
});

test("a nightly full scan leaves a busy lease to the next cron", async () => {
  const fixture = await whopFixture();
  const { t, connectionId } = fixture;
  const requests = stubApi(() => listPage([]));
  await t.mutation(internal.payments.connectionState.takeSweepLease, { connectionId, token: "recent" });
  await t.action(internal.payments.reconcile.scanFull, { connectionId, startedAt: TEST_TIME });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(requests).toHaveLength(0);
  expect((await connection(fixture))?.sweepToken).toBe("recent");
});

test.each([
  ["30", 30_000],
  [new Date(TEST_TIME + 90_000).toUTCString(), 90_000],
  ["9".repeat(350), 900_000],
  [new Date(TEST_TIME + 2 * TEST_DAY_MS).toUTCString(), 900_000],
])("parses and caps Retry-After %s before storing the request clock", async (header, delay) => {
  const fixture = await whopFixture();
  const { t, connectionId } = fixture;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 429, headers: { "Retry-After": header } })));
  await t.action(internal.payments.reconcile.sweepRecent, { connectionId, through: TEST_TIME });
  expect(await connection(fixture)).toMatchObject({ lastErrorCode: "rate_limited", nextRequestAt: TEST_TIME + delay });
});

test("applies absolute payer deadlines to historical, non-actionable and waiting facts after disconnect", async () => {
  const fixture = await whopFixture();
  const { t, connectionId } = fixture;
  const historical = await seedRead(fixture, { id: "pay_historic", paid_at: iso(TEST_TIME - TEST_DAY_MS) });
  const pending = await seedRead(fixture, { id: "pay_pending", status: "open" });
  const waiting = await seedRead(fixture, { id: "pay_waiting" });
  expect(historical).toMatchObject({ reviewState: "historical", payerDetailsExpireAt: TEST_TIME + 90 * TEST_DAY_MS });
  expect(pending).toMatchObject({ reviewState: "not_actionable", payerDetailsExpireAt: TEST_TIME + 90 * TEST_DAY_MS });
  expect(waiting).toMatchObject({ reviewState: "needs_person", payerDetailsExpireAt: TEST_TIME + 180 * TEST_DAY_MS });
  await fixture.admin.mutation(api.payments.connection.disconnect, { connectionId });

  const get = (id: typeof historical._id) => t.run((ctx) => ctx.db.get("providerPayments", id));
  vi.setSystemTime(TEST_TIME + 90 * TEST_DAY_MS);
  await t.mutation(internal.payments.reconcile.purge, {});
  expect((await get(historical._id))?.payerEmail).toBeUndefined();
  expect((await get(pending._id))?.payerEmail).toBeUndefined();
  expect((await get(waiting._id))?.payerEmail).toBe(waiting.payerEmail);
  vi.setSystemTime(TEST_TIME + 180 * TEST_DAY_MS);
  await t.mutation(internal.payments.reconcile.purge, {});
  expect(await get(waiting._id)).toMatchObject({
    externalPaymentId: "pay_waiting", payerDetailsClearedAt: Date.now(),
  });
  expect((await get(waiting._id))?.payerEmail).toBeUndefined();
});

test("counts and deletes inline receipt bodies in bounded operational reset pages", async () => {
  const { t, tenantId, connectionId } = await whopFixture();
  const rawBody = "x".repeat(256 * 1024);
  await t.run(async (ctx) => {
    for (let index = 0; index < 21; index++) {
      await ctx.db.insert("paymentWebhookReceipts", {
        tenantId, connectionId, webhookId: `msg_cleanup_${index}`, eventType: "payment.succeeded",
        bodySha256: "fixture", rawBody, hasRawBody: true, receivedAt: TEST_TIME, status: "processed", attempts: 1,
      });
    }
  });
  const ops = internal.testing.operationalData;
  const first = await t.query(ops.countReceiptPage, { cursor: null });
  expect(first.count).toBe(20);
  expect(await t.query(ops.countReceiptPage, { cursor: first.nextCursor }))
    .toEqual({ count: 1, nextCursor: null });
  expect(await t.mutation(ops.deleteOperationalDataBatch, { tableName: "paymentWebhookReceipts" }))
    .toMatchObject({ deleted: 20, hasMore: true });
  expect(await t.mutation(ops.deleteOperationalDataBatch, { tableName: "paymentWebhookReceipts" }))
    .toMatchObject({ deleted: 1, hasMore: false });
});

async function runRecentSweep(fixture: Fixture, through: number) {
  const { t, connectionId } = fixture;
  vi.setSystemTime(Math.max(Date.now(), through));
  await t.action(internal.payments.reconcile.sweepRecent, { connectionId, through });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

const RETRY_INTERVAL_MS = 15 * 60_000;

test("retries an established payment after the recent refund window and clears its retry fields on recovery", async () => {
  const fixture = await whopFixture({ sweepCreatedThrough: TEST_TIME - RETRY_INTERVAL_MS });
  const { t } = fixture;
  const refundedAt = TEST_TIME - 40 * 60_000;
  const stored = await seedRead(fixture, { created_at: iso(TEST_TIME - 2 * TEST_DAY_MS) });
  const fact = () => t.run((ctx) => ctx.db.get("providerPayments", stored._id));
  let readable = false;
  const requests = stubApi((url) => {
    if (url.pathname !== "/api/v1/payments") {
      return readable ? Response.json(paymentFixture({
        created_at: iso(stored.sourceCreatedAt), updated_at: iso(TEST_TIME + 1000), substatus: "refunded",
      })) : new Response(null, { status: 404 });
    }
    const after = url.searchParams.get("refunded_after");
    return listPage(after && Date.parse(after) <= refundedAt ? [PAYMENT_ID] : []);
  });

  await runRecentSweep(fixture, TEST_TIME);
  expect(await connection(fixture)).toMatchObject({ sweepCreatedThrough: TEST_TIME });
  const unreadable = (await fact())!;
  expect(unreadable).toMatchObject({ adverseState: "none", retryReadAttempts: 1, retryReadAt: expect.any(Number) });

  const readsBeforeRecovery = requests.length;
  readable = true;
  await runRecentSweep(fixture, unreadable.retryReadAt!);
  const recovery = requests.slice(readsBeforeRecovery);
  expect(recovery[0].pathname).toBe(`/api/v1/payments/${PAYMENT_ID}`);
  expect(Date.parse(recovery.find((url) => url.searchParams.has("refunded_after"))!.searchParams.get("refunded_after")!))
    .toBeGreaterThan(refundedAt);
  expect(recovery.filter((url) => url.pathname.endsWith(`/${PAYMENT_ID}`))).toHaveLength(1);
  expect(await connection(fixture)).toMatchObject({ lastSuccessfulSweepAt: unreadable.retryReadAt });
  const recovered = await fact();
  expect(recovered).toMatchObject({ adverseState: "refunded" });
  expect(recovered?.retryReadAt).toBeUndefined();
  expect(recovered?.retryReadAttempts).toBeUndefined();
});

test("keeps all 30 unreadable details and retries the oldest 25 first across recent sweeps", async () => {
  const fixture = await whopFixture();
  const ids = Array.from({ length: 30 }, (_, i) => `pay_unreadable_${i}`);
  const detailReads: string[] = [];
  stubApi((url) => {
    if (url.pathname !== "/api/v1/payments") {
      detailReads.push(url.pathname.split("/").at(-1)!);
      return new Response(null, { status: 404 });
    }
    if (!url.searchParams.has("created_after")) return listPage([]);
    return url.searchParams.has("after") ? listPage(ids.slice(20)) : listPage(ids.slice(0, 20), "overflow");
  });
  const facts = () => fixture.t.run((ctx) => ctx.db.query("providerPayments").take(31));

  await runRecentSweep(fixture, TEST_TIME);
  expect(detailReads).toEqual(ids);
  const firstFailures = await facts();
  expect(firstFailures).toHaveLength(30);
  expect(firstFailures.every((row) => row.retryReadAttempts === 1 && row.retryReadAt !== undefined)).toBe(true);
  const allDueAt = firstFailures.at(-1)!.retryReadAt!;

  detailReads.length = 0;
  await runRecentSweep(fixture, allDueAt);
  expect(detailReads).toEqual(ids.slice(0, 25));
  expect((await facts()).map((row) => row.retryReadAttempts))
    .toEqual([...Array<number>(25).fill(2), ...Array<number>(5).fill(1)]);

  detailReads.length = 0;
  await runRecentSweep(fixture, allDueAt + RETRY_INTERVAL_MS);
  expect(detailReads.slice(0, 5)).toEqual(ids.slice(25));
  expect(detailReads.length).toBeLessThanOrEqual(25);
  const retried = await facts();
  expect(retried).toHaveLength(30);
  expect(retried.every((row) => (row.retryReadAttempts ?? 0) >= 2 && row.retryReadAt !== undefined)).toBe(true);
});

test("backs off to 24 hours and counts a payment after 20 failed reads stop its retries", async () => {
  const fixture = await whopFixture();
  const { t, admin } = fixture;
  const failureTimes: number[] = [];
  stubApi((url) => {
    if (url.pathname === "/api/v1/payments") {
      return listPage(url.searchParams.has("created_after") ? [PAYMENT_ID] : []);
    }
    failureTimes.push(Date.now());
    return new Response(null, { status: 404 });
  });
  let through = TEST_TIME;
  for (let attempt = 1; attempt <= 20; attempt++) {
    await runRecentSweep(fixture, through);
    const row = await t.run((ctx) => ctx.db.query("providerPayments").first());
    expect(failureTimes).toHaveLength(attempt);
    expect(row?.retryReadAttempts).toBe(attempt);
    if (attempt < 20) {
      const delay = Math.min(RETRY_INTERVAL_MS * 2 ** (attempt - 1), TEST_DAY_MS);
      expect(row?.retryReadAt).toBe(failureTimes[attempt - 1] + delay);
      through = row!.retryReadAt!;
    } else {
      expect(row?.retryReadAt).toBeUndefined();
    }
  }

  await runRecentSweep(fixture, through + TEST_DAY_MS);
  expect(failureTimes).toHaveLength(20);
  expect(await admin.query(api.payments.connection.getConnection, { environment: "sandbox" }))
    .toMatchObject({ unreadablePayments: 1 });
});

test("retries an old provisional fact even without a failed read", async () => {
  const fixture = await whopFixture();
  const { t, connectionId } = fixture;
  const row = (await connection(fixture))!;
  const identity = { connectionId, connectedAt: row.connectedAt, accountId: ACCOUNT_ID };
  vi.setSystemTime(TEST_TIME - 16 * 60_000);
  await t.mutation(internal.payments.intake.beginPaymentRead, { ...identity, externalPaymentId: "pay_old_provisional" });
  vi.setSystemTime(TEST_TIME - 14 * 60_000);
  await t.mutation(internal.payments.intake.beginPaymentRead, { ...identity, externalPaymentId: "pay_new_provisional" });
  vi.setSystemTime(TEST_TIME);

  const requests = stubApi((url) => url.pathname === "/api/v1/payments" ? listPage([])
    : Response.json(paymentFixture({ id: url.pathname.split("/").at(-1) })));
  await t.action(internal.payments.reconcile.sweepRecent, { connectionId, through: TEST_TIME });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(requests.filter((url) => url.pathname !== "/api/v1/payments").map((url) => url.pathname))
    .toEqual(["/api/v1/payments/pay_old_provisional"]);
  expect(await t.run((ctx) => ctx.db.query("providerPayments").take(2))).toMatchObject([
    { externalPaymentId: "pay_old_provisional", status: "paid" },
    { externalPaymentId: "pay_new_provisional", status: "unknown" },
  ]);
});

test.each([false, true])("queues a superseded detail only without a newer stored read (covered: %s)", async (covered) => {
  const fixture = await whopFixture();
  const { t, connectionId } = fixture;
  const row = (await connection(fixture))!;
  const identity = { connectionId, connectedAt: row.connectedAt, accountId: ACCOUNT_ID, externalPaymentId: PAYMENT_ID };
  stubApi(async (url) => {
    if (url.pathname === "/api/v1/payments") {
      return listPage(url.searchParams.has("created_after") ? [PAYMENT_ID] : []);
    }
    const generation = (await t.mutation(internal.payments.intake.beginPaymentRead, identity))!;
    if (covered) {
      const payment = normalizePayment(paymentSchema.parse(paymentFixture({ updated_at: iso(TEST_TIME + 1000) })));
      await t.mutation(internal.payments.intake.storePaymentRead, { ...identity, generation, payment });
    }
    return Response.json(paymentFixture());
  });
  await t.action(internal.payments.reconcile.sweepRecent, { connectionId, through: TEST_TIME });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(await connection(fixture)).toMatchObject({ lastSuccessfulSweepAt: TEST_TIME });
  const payment = await t.run((ctx) => ctx.db.query("providerPayments").first());
  expect(payment).toMatchObject({ status: covered ? "paid" : "unknown", refreshGeneration: 2 });
  expect(payment?.retryReadAttempts).toBe(covered ? undefined : 1);
  if (covered) expect(payment?.retryReadAt).toBeUndefined();
  else expect(payment?.retryReadAt).toEqual(expect.any(Number));
});

test("uses a single indexed fence page regardless of unfenced terminal history", async () => {
  const fixture = await whopFixture();
  const { t, tenantId, connectionId } = fixture;
  await t.run(async (ctx) => {
    for (const adverseState of ["partially_refunded", "refunded", "dispute_won", "dispute_lost"] as const) {
      for (let i = 0; i < 25; i++) {
        await insertProviderFact(ctx, tenantId, connectionId, {
          externalPaymentId: `pay_${adverseState}_${i}`, adverseState,
        });
      }
    }
    await insertProviderFact(ctx, tenantId, connectionId, {
      externalPaymentId: PAYMENT_ID, adverseState: "refunded", adverseFencedAt: TEST_TIME,
    });
  });
  const requests = stubApi((url) => url.pathname === "/api/v1/payments" ? listPage([])
    : Response.json(paymentFixture({ substatus: "refunded" })));
  expect(await t.query(internal.payments.reconcile.listKnownPayments, {
    connectionId, selector: { kind: "fenced" }, paginationOpts: { cursor: null, numItems: 1 },
  })).toEqual({ ids: [PAYMENT_ID], cursor: null });

  // Leave only one page per stage. Paging terminal rows would exhaust this budget.
  await t.action(internal.payments.reconcile.sweepRecent, {
    connectionId, through: TEST_TIME, pages: SWEEP_PAGE_BUDGET - 13,
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(await connection(fixture)).toMatchObject({ lastSuccessfulSweepAt: TEST_TIME });
  expect(requests).toHaveLength(5);
  expect(requests.filter((url) => url.pathname !== "/api/v1/payments").map((url) => url.pathname))
    .toEqual([`/api/v1/payments/${PAYMENT_ID}`]);
});
