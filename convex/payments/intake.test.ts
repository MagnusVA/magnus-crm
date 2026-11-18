import { internal } from "../_generated/api";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { insertDeal, insertPayment, insertPerson, insertProgram } from "../../tests/enrollmentFixtures";
import {
  ACCOUNT_ID, PAYMENT_ID, SIGNING_SECRET, TEST_TIME, iso, paymentFixture, signedHeaders, whopFixture,
} from "../../tests/whopFixtures";
import type { Id } from "../_generated/dataModel";
import { normalizePayment, paymentSchema } from "./whop/normalize";

type Fixture = Awaited<ReturnType<typeof whopFixture>>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TEST_TIME);
  vi.stubEnv("WORKOS_CLIENT_ID", "client_fixture");
  vi.stubEnv("WORKOS_API_KEY", "sk_fixture");
  vi.stubEnv("WORKOS_WEBHOOK_SECRET", "whsec_fixture");
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function deliver(
  t: Fixture["t"],
  connectionId: Id<"tenantPaymentConnections">,
  {
    webhookId = "msg_fixture", accountId, companyId, type = "payment.succeeded", data = { id: PAYMENT_ID },
  }: { webhookId?: string; accountId?: string; companyId?: string; type?: string; data?: unknown } = {},
) {
  const body = JSON.stringify({
    id: webhookId, account_id: accountId ?? (companyId === undefined ? ACCOUNT_ID : undefined),
    company_id: companyId, type, data,
  });
  return t.fetch(`/webhooks/whop?c=${connectionId}`, {
    method: "POST",
    headers: await signedHeaders(body, webhookId, SIGNING_SECRET, Date.now()),
    body,
  });
}

function readIdentity(connectionId: Id<"tenantPaymentConnections">) {
  return { connectionId, accountId: ACCOUNT_ID, connectedAt: TEST_TIME - 60_000, externalPaymentId: PAYMENT_ID };
}

function facts(overrides: Record<string, unknown> = {}) {
  return normalizePayment(paymentSchema.parse(paymentFixture(overrides)));
}

function providerPayments(fixture: Fixture) {
  return fixture.t.run((ctx) =>
    ctx.db.query("providerPayments")
      .withIndex("by_tenantId_and_connectionId_and_externalPaymentId",
        (q) => q.eq("tenantId", fixture.tenantId).eq("connectionId", fixture.connectionId))
      .take(10),
  );
}

test("rejects a correctly signed delivery for the wrong account and stores nothing", async () => {
  const { t, connectionId } = await whopFixture();
  const response = await deliver(t, connectionId, { accountId: "biz_other_fixture" });
  expect(response.status).toBe(401);
  expect(await response.text()).toBe("Account mismatch");
  const saved = await t.run(async (ctx) => ({
    receipts: await ctx.db.query("paymentWebhookReceipts").take(10),
    files: await ctx.db.system.query("_storage").take(10),
  }));
  expect(saved).toEqual({ receipts: [], files: [] });
}, 20_000);

test("returns 404 for unknown and disconnected connections", async () => {
  const { t, connectionId } = await whopFixture({ status: "disconnected" });
  expect((await deliver(t, connectionId)).status).toBe(404);
  expect((await t.fetch("/webhooks/whop?c=unknown-fixture", { method: "POST" })).status).toBe(404);
});

test("deduplicates permanently and performs the Whop read in the workpool", async () => {
  const fixture = await whopFixture();
  const { t, connectionId } = fixture;
  const fetchMock = vi.fn(async (url: string) => {
    expect(new URL(url).pathname).toBe(`/api/v1/payments/${PAYMENT_ID}`);
    return Response.json(paymentFixture());
  });
  vi.stubGlobal("fetch", fetchMock);
  expect((await deliver(t, connectionId)).status).toBe(200);
  expect((await deliver(t, connectionId)).status).toBe(200);
  expect(fetchMock).not.toHaveBeenCalled();
  const before = await t.run(async (ctx) => ({
    receipts: await ctx.db.query("paymentWebhookReceipts").take(10),
    files: await ctx.db.system.query("_storage").take(10),
  }));
  expect(before.files).toHaveLength(0);
  expect(before.receipts).toHaveLength(1);
  expect(before.receipts[0]).toMatchObject({
    status: "received", webhookId: "msg_fixture", externalPaymentId: PAYMENT_ID,
    bodySha256: expect.stringMatching(/^[a-f0-9]{64}$/), rawBody: expect.stringContaining(PAYMENT_ID),
  });

  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const receipt = await t.query(internal.payments.intake.receipt, { receiptId: before.receipts[0]._id });
  expect(receipt).toMatchObject({ status: "processed", attempts: 1 });
  expect(await providerPayments(fixture)).toMatchObject([{ totalMinor: 243750, status: "paid" }]);
  expect(await t.run((ctx) => ctx.db.query("paymentRecords").take(1))).toEqual([]);
});

test("fences a refund even when it arrives before payment success", async () => {
  const fixture = await whopFixture();
  const { t, connectionId } = fixture;
  const reads: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    reads.push(path);
    vi.setSystemTime(Date.now() + 200);
    if (path.endsWith("/refunds/ref_fixture"))
      return Response.json({
        id: "ref_fixture", payment_id: PAYMENT_ID, account_id: ACCOUNT_ID,
        status: "succeeded", updated_at: iso(TEST_TIME + 1000),
      });
    // A later success delivery can still hit a replica returning the same
    // revision without the refund. It cannot undo the adverse snapshot.
    if (reads.length > 2) return Response.json(paymentFixture({ updated_at: iso(TEST_TIME + 1000) }));
    return Response.json(paymentFixture({
      substatus: "refunded",
      updated_at: iso(TEST_TIME + 1000),
      refunded_at: iso(TEST_TIME + 1000),
      refunded_amount: { amount: "2437.50", currency: "usd", decimals: 2 },
    }));
  }));
  expect((await deliver(t, connectionId, {
    webhookId: "msg_refund_fixture",
    type: "refund.created",
    data: { id: "ref_fixture", payment: { id: PAYMENT_ID } },
  })).status).toBe(200);
  const [provisional] = await providerPayments(fixture);
  expect(provisional).toMatchObject({ adverseFencedAt: TEST_TIME, reviewState: "not_actionable" });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(reads).toEqual(["/api/v1/refunds/ref_fixture", `/api/v1/payments/${PAYMENT_ID}`]);
  expect((await deliver(t, connectionId)).status).toBe(200);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const [payment] = await providerPayments(fixture);
  expect(payment).toMatchObject({
    _id: provisional._id, firstSeenAt: provisional.firstSeenAt,
    status: "paid", adverseState: "refunded", refundedMinor: 243750,
  });
  expect(payment.adverseFencedAt).toBeUndefined();
});

test("rejects stale revisions and any response from an older refresh generation", async () => {
  const fixture = await whopFixture();
  const { t, connectionId } = fixture;
  const identity = readIdentity(connectionId);
  const first = (await t.mutation(internal.payments.intake.beginPaymentRead, identity))!;
  const second = (await t.mutation(internal.payments.intake.beginPaymentRead, identity))!;
  expect(second).toBeGreaterThan(first);
  expect(await t.mutation(internal.payments.intake.storePaymentRead, {
    ...identity, generation: second, payment: facts(),
  })).toBe("stored");
  expect(await t.mutation(internal.payments.intake.storePaymentRead, {
    ...identity, generation: first, payment: facts({ status: "open", updated_at: iso(TEST_TIME + 1000) }),
  })).toBe("superseded");
  const third = (await t.mutation(internal.payments.intake.beginPaymentRead, identity))!;
  expect(await t.mutation(internal.payments.intake.storePaymentRead, {
    ...identity, generation: third, payment: facts({ status: "pending", updated_at: iso(TEST_TIME - 1) }),
  })).toBe("stale");
  expect(await providerPayments(fixture)).toMatchObject([{ status: "paid", sourceUpdatedAt: TEST_TIME }]);
});

test("an equal-timestamp read cannot clear a pending refund", async () => {
  const fixture = await whopFixture();
  const { t, connectionId } = fixture;
  const identity = readIdentity(connectionId);
  const first = (await t.mutation(internal.payments.intake.beginPaymentRead, identity))!;
  await t.mutation(internal.payments.intake.storePaymentRead, { ...identity, generation: first, payment: facts() });
  await deliver(t, connectionId, {
    type: "refund.created",
    data: { id: "ref_fixture", payment: { id: PAYMENT_ID } },
  });
  const generation = (await t.mutation(internal.payments.intake.beginPaymentRead, identity))!;
  expect(await t.mutation(internal.payments.intake.storePaymentRead, {
    ...identity, generation,
    payment: facts({ substatus: "refunded" }),

  })).toBe("fenced");
  expect(await providerPayments(fixture)).toMatchObject([{
    adverseFencedAt: TEST_TIME, adverseState: "refund_pending",
  }]);

  const cleanGeneration = (await t.mutation(internal.payments.intake.beginPaymentRead, identity))!;
  expect(await t.mutation(internal.payments.intake.storePaymentRead, {
    ...identity, generation: cleanGeneration, payment: facts({ updated_at: iso(TEST_TIME + 1) }),
  })).toBe("fenced");

  const refundGeneration = (await t.mutation(internal.payments.intake.beginPaymentRead, identity))!;
  expect(await t.mutation(internal.payments.intake.storePaymentRead, {
    ...identity, generation: refundGeneration,
    payment: facts({
      updated_at: iso(TEST_TIME + 2), substatus: "refunded",
      refunded_amount: { amount: "2437.50", currency: "usd", decimals: 2 },
    }),
  })).toBe("fenced");
  const [reconciled] = await providerPayments(fixture);
  expect(reconciled.adverseState).toBe("refunded");
  expect(reconciled.adverseFencedAt).toBe(TEST_TIME);
});

test("preserves the human resolution, clears optional stale facts, and never adds cash", async () => {
  const fixture = await whopFixture();
  const { t, tenantId, connectionId } = fixture;
  const identity = readIdentity(connectionId);
  const first = (await t.mutation(internal.payments.intake.beginPaymentRead, identity))!;
  await t.mutation(internal.payments.intake.storePaymentRead, { ...identity, generation: first, payment: facts() });
  const [before] = await providerPayments(fixture);
  const resolution = await t.run(async (ctx) => {
    const leadId = await insertPerson(ctx, tenantId);
    const opportunityId = await insertDeal(ctx, tenantId, leadId);
    const programId = await insertProgram(ctx, tenantId, "Fixture program");
    const paymentRecordId = await insertPayment(ctx, {
      tenantId, opportunityId, programId, recordedAt: TEST_TIME,
    });
    const fields = { leadId, opportunityId, paymentRecordId, matchMethod: "person", reviewState: "linked" } as const;
    await ctx.db.patch("providerPayments", before._id, fields);
    return fields;
  });
  const second = (await t.mutation(internal.payments.intake.beginPaymentRead, identity))!;
  await t.mutation(internal.payments.intake.storePaymentRead, {
    ...identity, generation: second,
    payment: facts({ status: "open", updated_at: iso(TEST_TIME + 1), paid_at: null, customer_email: null }),
  });
  const [after] = await providerPayments(fixture);
  expect(after).toMatchObject({ ...resolution, firstSeenAt: before.firstSeenAt, status: "open" });
  expect(after.paidAt).toBeUndefined();
  expect(after.payerEmail).toBeUndefined();
  expect(await t.run((ctx) => ctx.db.query("paymentRecords").take(10))).toHaveLength(1);
});

test("rejects a payment read from another account and isolates same ids by tenant", async () => {
  const first = await whopFixture();
  const { t, connectionId } = first;
  const second = await t.run(async (ctx) => {
    const tenantId = await ctx.db.insert("tenants", {
      companyName: "Second fixture tenant", contactEmail: "admin@second.example.invalid",
      workosOrgId: "org_intake_fixture_two", status: "active", inviteExpiresAt: 0, createdBy: "fixture",
    });
    const connectedByUserId = await ctx.db.insert("users", {
      tenantId, workosUserId: "user_intake_fixture_two", email: "admin@second.example.invalid",
      role: "tenant_admin", isActive: true,
    });
    const connection = (await ctx.db.get("tenantPaymentConnections", connectionId))!;
    const id = await ctx.db.insert("tenantPaymentConnections", {
      tenantId, connectedByUserId, accountId: "biz_second_fixture",
      webhookSecret: SIGNING_SECRET, provider: connection.provider, apiKey: connection.apiKey,
      keyLast4: connection.keyLast4, status: connection.status, connectedAt: connection.connectedAt,
      autoImportAfter: connection.autoImportAfter, environment: connection.environment,
      credentialKind: connection.credentialKind, apiVersionDate: connection.apiVersionDate,
      disputeAccess: connection.disputeAccess,
    });
    return { connectionId: id, tenantId };
  });
  expect((await deliver(t, second.connectionId)).status).toBe(401);
  expect((await deliver(t, connectionId)).status).toBe(200);
  expect((await deliver(t, second.connectionId, { accountId: "biz_second_fixture" })).status).toBe(200);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(paymentFixture())));
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(await providerPayments(first)).toMatchObject([{ status: "paid", tenantId: first.tenantId }]);
  expect(await providerPayments({ ...first, ...second })).toMatchObject([{
    status: "unknown", tenantId: second.tenantId, sourceUpdatedAt: 0,
  }]);
  const receipts = await t.run((ctx) => ctx.db.query("paymentWebhookReceipts").take(10));
  expect(receipts).toMatchObject([
    { tenantId: first.tenantId, status: "processed", webhookId: "msg_fixture" },
    { tenantId: second.tenantId, status: "ignored", failureCode: "account_mismatch", webhookId: "msg_fixture" },
  ]);
});

test("marks paid history and non-paid facts without a cash write", async () => {
  const fixture = await whopFixture({ autoImportAfter: TEST_TIME + 1 });
  const { t, connectionId } = fixture;
  const identity = readIdentity(connectionId);
  const first = (await t.mutation(internal.payments.intake.beginPaymentRead, identity))!;
  await t.mutation(internal.payments.intake.storePaymentRead, { ...identity, generation: first, payment: facts() });
  expect(await providerPayments(fixture)).toMatchObject([{ reviewState: "historical" }]);
  const second = (await t.mutation(internal.payments.intake.beginPaymentRead, identity))!;
  await t.mutation(internal.payments.intake.storePaymentRead, {
    ...identity, generation: second, payment: facts({ status: "pending", updated_at: iso(TEST_TIME + 1) }),
  });
  expect(await providerPayments(fixture)).toMatchObject([{ reviewState: "not_actionable" }]);
});

test("stops retrying failed processing after eight attempts", async () => {
  const { t, connectionId } = await whopFixture();
  const fetchMock = vi.fn(async () => new Response("fixture provider failure", { status: 503 }));
  vi.stubGlobal("fetch", fetchMock);
  await deliver(t, connectionId);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(fetchMock).toHaveBeenCalledTimes(8);
  expect(await t.run((ctx) => ctx.db.query("paymentWebhookReceipts").take(10))).toMatchObject([
    { status: "failed", attempts: 8, failureCode: "attempts_exhausted" },
  ]);
});

test("accepts a signed legacy company ID and rejects a conflicting signed account ID", async () => {
  const { t, connectionId } = await whopFixture();
  expect((await deliver(t, connectionId, { webhookId: "legacy", companyId: ACCOUNT_ID, type: "other" })).status)
    .toBe(200);
  expect((await deliver(t, connectionId, { webhookId: "wrong_legacy", companyId: "biz_other", type: "other" })).status)
    .toBe(401);
  expect((await deliver(t, connectionId, {
    webhookId: "conflict", companyId: "biz_other", accountId: ACCOUNT_ID, type: "other",
  })).status).toBe(401);
  const receipts = await t.run((ctx) => ctx.db.query("paymentWebhookReceipts").take(10));
  expect(receipts).toMatchObject([{ webhookId: "legacy" }]);
});

test("checks headers and configured signing material before consuming the body", async () => {
  const { t, connectionId } = await whopFixture();
  const path = `/webhooks/whop?c=${connectionId}`;
  const pull = vi.fn((controller: ReadableStreamDefaultController) => controller.close());
  const init = (headers?: Headers) => ({
    method: "POST", duplex: "half", headers,
    body: new ReadableStream({ pull }, { highWaterMark: 0 }),
  });
  expect((await t.fetch(path, init())).status).toBe(401);
  expect(pull).not.toHaveBeenCalled();
  await t.run((ctx) => ctx.db.patch("tenantPaymentConnections", connectionId, { webhookSecret: "ws_short" }));
  expect((await t.fetch(path, init(await signedHeaders("fixture", "msg_fixture")))).status).toBe(401);
  expect(pull).not.toHaveBeenCalled();
});

test("enforces 256 KiB with or without Content-Length", async () => {
  const { t, connectionId } = await whopFixture();
  const path = `/webhooks/whop?c=${connectionId}`;
  const headers = await signedHeaders("fixture", "msg_fixture");
  const maxBytes = 256 * 1024;
  const body = new Uint8Array(maxBytes + 1);
  expect((await t.fetch(path, { method: "POST", headers, body })).status).toBe(413);
  headers.set("content-length", String(maxBytes + 1));
  expect((await t.fetch(path, { method: "POST", headers })).status).toBe(413);
  headers.set("content-length", "12");
  expect((await t.fetch(path, { method: "POST", headers, body })).status).toBe(413);
  expect(await t.run((ctx) => ctx.db.query("paymentWebhookReceipts").take(1))).toEqual([]);
});

test("samples invalid signature warnings once per connection per minute", async () => {
  const { t, connectionId } = await whopFixture();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const reject = () => t.fetch(`/webhooks/whop?c=${connectionId}`, { method: "POST" });
    await Promise.all([reject(), reject()]);
    vi.setSystemTime(TEST_TIME + 59_999);
    await reject();
    expect(warn.mock.calls.filter(([line]) => String(line).includes("whop.webhook.rejected"))).toHaveLength(1);
    vi.setSystemTime(TEST_TIME + 60_000);
    await reject();
    expect(warn.mock.calls.filter(([line]) => String(line).includes("whop.webhook.rejected"))).toHaveLength(2);
  } finally {
    warn.mockRestore();
  }
});

test.each(["failed", "canceled"] as const)("clears a %s refund fence after a fresh clean payment read", async (status) => {
  const fixture = await whopFixture();
  const { t, connectionId } = fixture;
  const identity = readIdentity(connectionId);
  const generation = (await t.mutation(internal.payments.intake.beginPaymentRead, identity))!;
  await t.mutation(internal.payments.intake.storePaymentRead, { ...identity, generation, payment: facts() });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    vi.setSystemTime(Date.now() + 200);
    return new URL(url).pathname.endsWith("/refunds/ref_terminal")
      ? Response.json({ id: "ref_terminal", account_id: ACCOUNT_ID, payment_id: PAYMENT_ID, status, updated_at: iso(TEST_TIME + 100) })
      : Response.json(paymentFixture());
  }));
  await deliver(t, connectionId, { type: "refund.updated", data: { id: "ref_terminal", payment: { id: PAYMENT_ID } } });
  expect((await providerPayments(fixture))[0]).toMatchObject({ adverseState: "refund_pending" });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect((await providerPayments(fixture))[0].adverseFencedAt).toBeUndefined();
  expect((await providerPayments(fixture))[0].adverseState).toBe("none");
  expect(await t.run((ctx) => ctx.db.query("paymentWebhookReceipts").take(2)))
    .toMatchObject([{ status: "processed", attempts: 1 }]);
});

test("a late settled refund delivery can confirm a payment revision already committed by a sweep", async () => {
  const fixture = await whopFixture();
  const { t, connectionId } = fixture;
  const identity = readIdentity(connectionId);
  const refunded = {
    substatus: "partially_refunded", refunded_at: iso(TEST_TIME),
    refunded_amount: { amount: "10.00", currency: "usd", decimals: 2 },
  };
  const generation = (await t.mutation(internal.payments.intake.beginPaymentRead, identity))!;
  await t.mutation(internal.payments.intake.storePaymentRead, { ...identity, generation, payment: facts(refunded) });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    vi.setSystemTime(Date.now() + 200);
    return new URL(url).pathname.endsWith("/refunds/ref_prior")
      ? Response.json({
        id: "ref_prior", account_id: ACCOUNT_ID, payment_id: PAYMENT_ID,
        status: "succeeded", updated_at: iso(TEST_TIME), amount: refunded.refunded_amount,
      })
      : Response.json(paymentFixture(refunded));
  }));
  await deliver(t, connectionId, { type: "refund.updated", data: { id: "ref_prior", payment: { id: PAYMENT_ID } } });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const [row] = await providerPayments(fixture);
  expect(row).toMatchObject({ adverseState: "partially_refunded", refundedMinor: 1000, sourceUpdatedAt: TEST_TIME });
  expect(row.adverseFencedAt).toBeUndefined();
  expect(await t.run((ctx) => ctx.db.query("paymentWebhookReceipts").take(2)))
    .toMatchObject([{ status: "processed", attempts: 1 }]);
});

test("settling one adverse resource leaves another pending resource fenced", async () => {
  const fixture = await whopFixture();
  const { t, connectionId } = fixture;
  const first = { type: "refund.updated", data: { id: "ref_first", payment: { id: PAYMENT_ID } } };
  await deliver(t, connectionId, { ...first, webhookId: "msg_first" });
  await deliver(t, connectionId, {
    type: "refund.created", data: { id: "ref_second", payment: { id: PAYMENT_ID } }, webhookId: "msg_second",
  });
  const receipts = await t.run((ctx) => ctx.db.query("paymentWebhookReceipts").take(2));
  const identity = readIdentity(connectionId);
  const generation = (await t.mutation(internal.payments.intake.beginPaymentRead, identity))!;
  expect(await t.mutation(internal.payments.intake.storePaymentRead, {
    ...identity, generation, payment: facts(),
    evidence: [{ receiptId: receipts[0]._id, kind: "refund", state: "failed", updatedAt: TEST_TIME }],
  })).toBe("fenced");
  expect((await providerPayments(fixture))[0]).toMatchObject({ adverseState: "refund_pending", adverseFencedAt: TEST_TIME });
  expect(await t.run((ctx) => ctx.db.get("paymentWebhookReceipts", receipts[1]._id)))
    .toMatchObject({ adversePending: true });
});

test.each([false, true])("depends on a durable successor before accepting a superseded read (%s)", async (covered) => {
  const fixture = await whopFixture();
  const { t, connectionId } = fixture;
  const identity = readIdentity(connectionId);
  let reads = 0;
  vi.stubGlobal("fetch", vi.fn(async () => {
    vi.setSystemTime(Date.now() + 200);
    if (++reads === 1) {
      const successor = (await t.mutation(internal.payments.intake.beginPaymentRead, identity))!;
      if (covered) await t.mutation(internal.payments.intake.storePaymentRead, {
        ...identity, generation: successor, payment: facts({ updated_at: iso(TEST_TIME + 1) }),
      });
    }
    return Response.json(paymentFixture());
  }));
  await deliver(t, connectionId);
  const [receipt] = await t.run((ctx) => ctx.db.query("paymentWebhookReceipts").take(1));
  await t.action(internal.payments.intake.processReceipt, { receiptId: receipt._id, attempt: 1 });
  expect(await t.run((ctx) => ctx.db.get("paymentWebhookReceipts", receipt._id)))
    .toMatchObject({ status: covered ? "processed" : "received", attempts: 1 });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(reads).toBe(covered ? 1 : 2);
  expect(await t.run((ctx) => ctx.db.get("paymentWebhookReceipts", receipt._id)))
    .toMatchObject({ status: "processed", attempts: covered ? 1 : 2 });
});

test.each(["refund", "dispute"] as const)(
  "a forbidden %s resource still refreshes the known payment and retains the fence", async (kind) => {
    const fixture = await whopFixture({ disputeAccess: "forbidden" });
    const { t, connectionId } = fixture;
    const fetchMock = vi.fn(async (url: string) => {
      vi.setSystemTime(Date.now() + 200);
      return new URL(url).pathname.includes(`/${kind}s/`)
        ? new Response(null, { status: 403 })
        : Response.json(paymentFixture());
    });
    vi.stubGlobal("fetch", fetchMock);
    await deliver(t, connectionId, {
      type: `${kind}.created`, data: { id: `${kind}_fixture`, payment: { id: PAYMENT_ID } },
    });
    const [receipt] = await t.run((ctx) => ctx.db.query("paymentWebhookReceipts").take(1));
    await t.action(internal.payments.intake.processReceipt, { receiptId: receipt._id, attempt: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await providerPayments(fixture))[0]).toMatchObject({
      status: "paid", adverseState: kind === "refund" ? "refund_pending" : "dispute_open", adverseFencedAt: TEST_TIME,
    });
    expect(await t.run((ctx) => ctx.db.get("paymentWebhookReceipts", receipt._id)))
      .toMatchObject({ status: "received", adversePending: true });
  },
);

test("marks an unavailable connection's queued or incoming receipt failed without retrying", async () => {
  const { t, connectionId } = await whopFixture();
  const fetchMock = vi.fn(async () => new Response(null, { status: 401 }));
  vi.stubGlobal("fetch", fetchMock);
  await deliver(t, connectionId);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  await deliver(t, connectionId, { webhookId: "invalid_key_delivery" });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(await t.run((ctx) => ctx.db.query("paymentWebhookReceipts").take(10))).toMatchObject([
    { status: "failed", failureCode: "connection_unavailable", attempts: 1 },
    { status: "failed", failureCode: "connection_unavailable", attempts: 0 },
  ]);

  await t.run((ctx) => ctx.db.patch("tenantPaymentConnections", connectionId, { status: "connected" }));
  await deliver(t, connectionId, { webhookId: "queued_before_disconnect" });
  await t.run((ctx) => ctx.db.patch("tenantPaymentConnections", connectionId, { status: "disconnected" }));
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect((await t.run((ctx) => ctx.db.query("paymentWebhookReceipts").take(10)))[2])
    .toMatchObject({ status: "failed", failureCode: "connection_unavailable", attempts: 1 });
});

test("handled Whop request failures are tagged as integration errors without provider text", async () => {
  const { t, connectionId } = await whopFixture();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async () => new Response("synthetic provider message", { status: 503 })));
  try {
    await deliver(t, connectionId);
    const [receipt] = await t.run((ctx) => ctx.db.query("paymentWebhookReceipts").take(1));
    await t.action(internal.payments.intake.processReceipt, { receiptId: receipt._id, attempt: 1 });
    const signal = log.mock.calls.find(([line]) => String(line).includes("whop.webhook.read_failed"))?.[0];
    expect(signal).toContain('"obs_kind":"exception"');
    expect(signal).toContain('"integration":"whop"');
    expect(signal).toContain("Whop request failed: HTTP 503 provider_unavailable");
    expect(signal).not.toContain("synthetic provider message");
  } finally {
    log.mockRestore();
  }
});

test("a signed refund resource requires a canonical refund at least as large in magnitude", async () => {
  const fixture = await whopFixture();
  const { t, connectionId } = fixture;
  let refundedAmount = "10.00";
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    vi.setSystemTime(Date.now() + 200);
    if (new URL(url).pathname.includes("/refunds/")) {
      return Response.json({
        id: "ref_signed_fixture", account_id: ACCOUNT_ID, payment_id: PAYMENT_ID, status: "succeeded",
        updated_at: iso(TEST_TIME), amount: { amount: "-20.00", currency: "usd", decimals: 2 },
      });
    }
    return Response.json(paymentFixture({
      refunded_at: iso(TEST_TIME), refunded_amount: { amount: refundedAmount, currency: "usd", decimals: 2 },
    }));
  }));
  await deliver(t, connectionId, {
    type: "refund.updated", data: { id: "ref_signed_fixture", payment: { id: PAYMENT_ID } },
  });
  const [receipt] = await t.run((ctx) => ctx.db.query("paymentWebhookReceipts").take(1));
  await t.action(internal.payments.intake.processReceipt, { receiptId: receipt._id, attempt: 1 });
  expect((await providerPayments(fixture))[0]).toMatchObject({
    adverseState: "partially_refunded", refundedMinor: 1000, adverseFencedAt: TEST_TIME,
  });
  expect(await t.run((ctx) => ctx.db.get("paymentWebhookReceipts", receipt._id)))
    .toMatchObject({ adversePending: true });

  refundedAmount = "-20.00";
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const [resolved] = await providerPayments(fixture);
  expect(resolved.adverseFencedAt).toBeUndefined();
  expect(resolved).toMatchObject({ adverseState: "partially_refunded", refundedMinor: 2000 });
  expect(await t.run((ctx) => ctx.db.get("paymentWebhookReceipts", receipt._id)))
    .toMatchObject({ status: "processed", attempts: 2 });
});
