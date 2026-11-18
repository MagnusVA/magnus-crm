import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";
import { convexTestModules } from "../test.setup";
import { WHOP_API_VERSION_DATE } from "./whop/client";

const connection = api.payments.connection;
const live = { environment: "live" } as const;
const sandbox = { environment: "sandbox" } as const;
const apiKey = "test_whop_api_key_1111";
const nextKey = "test_whop_api_key_2222";
const webhookSecret = "ws_test_secret_first_synthetic_fixture";
const nextSecret = "ws_test_secret_second_synthetic_fixture";
const accountId = "biz_TestAccount";
const now = Date.parse("2026-11-17T15:00:00Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.stubEnv("WORKOS_CLIENT_ID", "client_test");
  vi.stubEnv("CONVEX_SITE_URL", "https://test.convex.site");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function fixture() {
  const t = convexTest({ schema, modules: convexTestModules });
  const ids = await t.run(async (ctx) => {
    const tenantId = await ctx.db.insert("tenants", {
      companyName: "Test",
      contactEmail: "admin@example.com",
      workosOrgId: "org_test",
      status: "active",
      inviteExpiresAt: 0,
      createdBy: "test",
    });
    const otherTenantId = await ctx.db.insert("tenants", {
      companyName: "Other",
      contactEmail: "other@example.com",
      workosOrgId: "org_other",
      status: "active",
      inviteExpiresAt: 0,
      createdBy: "test",
    });
    const adminId = await ctx.db.insert("users", {
      tenantId,
      workosUserId: "user_admin",
      email: "admin@example.com",
      role: "tenant_admin",
      isActive: true,
    });
    const ownerId = await ctx.db.insert("users", {
      tenantId,
      workosUserId: "user_owner",
      email: "owner@example.com",
      role: "tenant_master",
      isActive: true,
    });
    await ctx.db.insert("users", {
      tenantId,
      workosUserId: "user_closer",
      email: "closer@example.com",
      role: "closer",
      isActive: true,
    });
    await ctx.db.insert("users", {
      tenantId: otherTenantId,
      workosUserId: "user_other",
      email: "other@example.com",
      role: "tenant_admin",
      isActive: true,
    });
    return { tenantId, adminId, ownerId };
  });
  return {
    t,
    ...ids,
    admin: t.withIdentity({ subject: "user_admin", org_id: "org_test" }),
    owner: t.withIdentity({ subject: "user_owner", org_id: "org_test" }),
    closer: t.withIdentity({ subject: "user_closer", org_id: "org_test" }),
    other: t.withIdentity({ subject: "user_other", org_id: "org_other" }),
  };
}

function stubWhop(responses: { payments?: () => Response; account?: () => Response; dispute?: () => Response; alert?: () => Response } = {}) {
  const fetchMock = vi.fn(async (url: string, _init: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === "/api/v1/payments") {
      return responses.payments?.() ?? Response.json({ data: [{ account_id: accountId }] });
    }
    if (path === "/api/v1/accounts/me") {
      return responses.account?.() ?? Response.json({ id: accountId, title: "Test Whop" });
    }
    if (path === "/api/v1/disputes") return responses.dispute?.() ?? Response.json({ data: [] });
    if (path === "/api/v1/dispute_alerts") return responses.alert?.() ?? Response.json({ data: [] });
    throw new Error("Unexpected test request");
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("Whop connection", () => {
  it("checks account-scoped payments, pins the version, and returns the masked view", async () => {
    const f = await fixture();
    const fetchMock = stubWhop();
    const connectionId = await f.admin.action(connection.connect, {
      ...live,
      apiKey: ` ${apiKey} `,
      accountId,
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `https://api.whop.com/api/v1/payments?account_id=${accountId}&first=1`,
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: `Bearer ${apiKey}`,
          "Api-Version-Date": WHOP_API_VERSION_DATE,
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2, "https://api.whop.com/api/v1/accounts/me", expect.any(Object),
    );
    await f.owner.mutation(connection.setWebhookSecret, { connectionId, webhookSecret });
    const view = await f.owner.query(connection.getConnection, live);
    expect(view).toEqual({
      connectionId,
      status: "connected",
      environment: "live",
      accountId,
      accountTitle: "Test Whop",
      autoImportAfter: now,
      connectedAt: now,
      connectedByUserId: f.adminId,
      keyLast4: "1111",
      unreadablePayments: 0,
      disputeAccess: "ok",
      hasWebhookSecret: true,
      webhookUrl: `https://test.convex.site/webhooks/whop?c=${connectionId}`,
      webhookEvents: [
        "payment.created", "payment.succeeded", "payment.failed", "payment.pending",
        "payment.authorized", "payment.requires_action",
        "payment.canceled", "refund.created", "refund.updated", "dispute.created",
        "dispute.updated", "dispute_alert.created",
      ],
    });
    expect(JSON.stringify(view)).not.toContain(apiKey);
    expect(JSON.stringify(view)).not.toContain(webhookSecret);
    expect(await f.t.run((ctx) => ctx.db.get("tenantPaymentConnections", connectionId)))
      .toMatchObject({ credentialKind: "account_key", apiVersionDate: WHOP_API_VERSION_DATE });
  });

  it("allows only one connected environment and accepts an empty account without title scope", async () => {
    const f = await fixture();
    const fetchMock = stubWhop({
      payments: () => Response.json({ data: [] }),
      account: () => new Response(null, { status: 403 }),
    });
    const liveId = await f.admin.action(connection.connect, { ...live, apiKey, accountId });
    await expect(f.admin.action(connection.connect, { ...sandbox, apiKey, accountId }))
      .rejects.toMatchObject({ data: { code: "whop.other_environment_connected" } });
    expect(await f.admin.query(connection.getConnection, sandbox)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await f.admin.mutation(connection.disconnect, { connectionId: liveId });
    const sandboxId = await f.admin.action(connection.connect, { ...sandbox, apiKey, accountId });
    expect(sandboxId).not.toBe(liveId);
    expect(fetchMock).toHaveBeenNthCalledWith(
      5,
      `https://sandbox-api.whop.com/api/v1/payments?account_id=${accountId}&first=1`,
      expect.any(Object),
    );
    const view = await f.admin.query(connection.getConnection, sandbox);
    expect(view).toMatchObject({ connectionId: sandboxId, environment: "sandbox" });
    expect(view?.accountTitle).toBeUndefined();
  });

  it.each([
    { status: 401, code: "unauthorized" },
    { status: 403, code: "forbidden" },
    { status: 429, code: "provider_unavailable" },
    { status: 503, code: "provider_unavailable" },
  ])("maps HTTP $status to $code without exposing provider text", async ({ status, code }) => {
    const f = await fixture();
    const fetchMock = stubWhop({ payments: () => new Response(apiKey, { status }) });
    await expect(f.admin.action(connection.connect, { ...live, apiKey, accountId }))
      .rejects.toMatchObject({ data: {
        code: `whop.${code}`,
        message: expect.not.stringContaining(apiKey),
      } });
    expect(fetchMock).toHaveBeenCalledTimes(status === 403 ? 2 : 1);
    expect(await f.admin.query(connection.getConnection, live)).toBeNull();
  });

  it("rejects a different payment account and a different key account", async () => {
    const f = await fixture();
    const args = { ...live, apiKey, accountId };
    stubWhop({ payments: () => Response.json({ data: [{ account_id: "biz_Another" }] }) });
    await expect(f.admin.action(connection.connect, args))
      .rejects.toMatchObject({ data: { code: "whop.account_mismatch" } });
    stubWhop({
      payments: () => new Response(null, { status: 403 }),
      account: () => Response.json({ id: "biz_Another", title: "Other Whop" }),
    });
    await expect(f.admin.action(connection.connect, args))
      .rejects.toMatchObject({ data: { code: "whop.account_mismatch" } });
    expect(await f.admin.query(connection.getConnection, live)).toBeNull();
  });

  it("rotates the secret for 24 hours and preserves the row, cutoff and freshness on reconnect", async () => {
    const f = await fixture();
    stubWhop();
    const connectionId = await f.admin.action(connection.connect, { ...live, apiKey, accountId });
    await f.admin.mutation(connection.setWebhookSecret, { connectionId, webhookSecret });
    vi.setSystemTime(now + 1_000);
    await f.admin.mutation(connection.setWebhookSecret, { connectionId, webhookSecret: nextSecret });
    vi.setSystemTime(now + 2_000);
    await f.admin.mutation(connection.setWebhookSecret, { connectionId, webhookSecret: nextSecret });
    await f.t.run((ctx) => ctx.db.patch("tenantPaymentConnections", connectionId, {
      lastWebhookAt: now + 10,
      lastSuccessfulSweepAt: now + 20,
      lastFullScanAt: now + 30,
      status: "invalid_key",
      lastErrorCode: "unauthorized",
    }));
    expect(await f.admin.query(connection.getConnection, live)).toMatchObject({
      status: "invalid_key", lastErrorCode: "unauthorized",
    });
    stubWhop({ account: () => new Response(null, { status: 403 }) });
    expect(await f.owner.action(connection.connect, { ...live, apiKey: nextKey, accountId }))
      .toBe(connectionId);

    const view = await f.admin.query(connection.getConnection, live);
    expect(view).toMatchObject({
      connectionId,
      status: "connected",
      accountTitle: "Test Whop",
      keyLast4: "2222",
      hasWebhookSecret: true,
      autoImportAfter: now,
      connectedAt: now + 2_000,
      connectedByUserId: f.ownerId,
      lastWebhookAt: now + 10,
      lastSuccessfulSweepAt: now + 20,
      lastFullScanAt: now + 30,
    });
    expect(view?.lastErrorCode).toBeUndefined();
    expect(await f.t.run((ctx) => ctx.db.get("tenantPaymentConnections", connectionId)))
      .toMatchObject({
        apiKey: nextKey,
        webhookSecret: nextSecret,
        previousWebhookSecret: webhookSecret,
        previousWebhookSecretUntil: now + 1_000 + 24 * 60 * 60 * 1000,
      });
  });

  it("keeps the account attached to its history and clears credentials on disconnect", async () => {
    const f = await fixture();
    stubWhop();
    const connectionId = await f.admin.action(connection.connect, { ...live, apiKey, accountId });
    await f.admin.mutation(connection.setWebhookSecret, { connectionId, webhookSecret });
    await f.admin.mutation(connection.setWebhookSecret, { connectionId, webhookSecret: nextSecret });
    const receiptId = await f.t.run((ctx) => ctx.db.insert("paymentWebhookReceipts", {
      tenantId: f.tenantId,
      connectionId,
      webhookId: "test_hook",
      eventType: "payment.created",
      bodySha256: "test_body_hash",
      status: "processed",
      attempts: 1,
      receivedAt: now,
    }));
    await f.admin.mutation(connection.disconnect, { connectionId });
    expect(await f.admin.query(connection.getConnection, live)).toMatchObject({
      connectionId, status: "disconnected", keyLast4: "", hasWebhookSecret: false,
    });
    const row = await f.t.run((ctx) => ctx.db.get("tenantPaymentConnections", connectionId));
    expect(row?.apiKey).toBe("");
    expect(row?.webhookSecret).toBeUndefined();
    expect(row?.previousWebhookSecret).toBeUndefined();
    expect(row?.previousWebhookSecretUntil).toBeUndefined();
    expect(await f.t.run((ctx) => ctx.db.get("paymentWebhookReceipts", receiptId)))
      .toMatchObject({ connectionId, status: "processed" });

    const differentAccount = "biz_Another";
    stubWhop({
      payments: () => Response.json({ data: [] }),
      account: () => Response.json({ id: differentAccount, title: "Other Whop" }),
    });
    await expect(f.admin.action(connection.connect, { ...live, apiKey, accountId: differentAccount }))
      .rejects.toMatchObject({ data: { code: "whop.account_mismatch" } });
    expect(await f.admin.query(connection.getConnection, live)).toMatchObject({ accountId });
  });

  it("rejects signed-out users and closers, and isolates a known connection ID from another tenant", async () => {
    const f = await fixture();
    const fetchMock = stubWhop();
    await expect(f.t.query(connection.getConnection, live))
      .rejects.toMatchObject({ data: { code: "auth.not_authenticated" } });
    const connectionId = await f.admin.action(connection.connect, { ...live, apiKey, accountId });
    await expect(f.closer.query(connection.getConnection, live))
      .rejects.toMatchObject({ data: { code: "auth.insufficient_permissions" } });
    await expect(f.closer.action(connection.connect, { ...live, apiKey, accountId }))
      .rejects.toMatchObject({ data: { code: "auth.insufficient_permissions" } });
    await expect(f.closer.mutation(connection.setWebhookSecret, { connectionId, webhookSecret }))
      .rejects.toMatchObject({ data: { code: "auth.insufficient_permissions" } });
    await expect(f.closer.mutation(connection.disconnect, { connectionId }))
      .rejects.toMatchObject({ data: { code: "auth.insufficient_permissions" } });
    expect(await f.other.query(connection.getConnection, live)).toBeNull();
    await expect(f.other.mutation(connection.setWebhookSecret, { connectionId, webhookSecret }))
      .rejects.toMatchObject({ data: { code: "whop.connection_not_found" } });
    await expect(f.other.mutation(connection.disconnect, { connectionId }))
      .rejects.toMatchObject({ data: { code: "whop.connection_not_found" } });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

describe("connection ownership and webhook setup", () => {
  it.each(["connected", "invalid_key"] as const)("keeps an account exclusive while its original tenant is %s", async (status) => {
    const f = await fixture();
    stubWhop();
    const args = { ...live, apiKey, accountId };
    const first = await f.admin.action(connection.connect, args);
    await f.t.run((ctx) => ctx.db.patch("tenantPaymentConnections", first, { status }));
    await expect(f.other.action(connection.connect, args))
      .rejects.toMatchObject({ data: { code: "whop.account_in_use" } });
    await expect(f.admin.action(connection.connect, args)).resolves.toBe(first);
    await f.admin.mutation(connection.disconnect, { connectionId: first });
    const second = await f.other.action(connection.connect, args);
    expect(second).not.toBe(first);
    await expect(f.admin.action(connection.connect, args))
      .rejects.toMatchObject({ data: { code: "whop.account_in_use" } });
  });

  it.each(["dispute", "alert"] as const)("warns about unavailable %s access on an empty account", async (missing) => {
    const f = await fixture();
    const fetchMock = stubWhop({
      payments: () => Response.json({ data: [] }),
      [missing]: () => new Response(null, { status: 403 }),
    });
    await f.admin.action(connection.connect, { ...live, apiKey, accountId });
    const view = await f.admin.query(connection.getConnection, live);
    expect(view).toMatchObject({ status: "connected", disputeAccess: "forbidden" });
    for (const part of ["disputes", "dispute_alerts"]) {
      expect(fetchMock).toHaveBeenCalledWith(
        `https://api.whop.com/api/v1/${part}?account_id=${accountId}&first=1`,
        expect.any(Object),
      );
    }
  });

  it("rejects undocumented or short webhook secrets without rotating the current key", async () => {
    const f = await fixture();
    stubWhop();
    const connectionId = await f.admin.action(connection.connect, { ...live, apiKey, accountId });
    const valid = `whsec_${btoa("synthetic_standard_webhook_key")}`;
    await f.admin.mutation(connection.setWebhookSecret, { connectionId, webhookSecret: valid });
    for (const value of ["ws_synthetic_short", "whsec_QQ==", "undocumented_synthetic_webhook_key"]) {
      await expect(f.admin.mutation(connection.setWebhookSecret, { connectionId, webhookSecret: value }))
        .rejects.toMatchObject({ data: { code: "whop.invalid_webhook_secret" } });
    }
    const stored = await f.t.run((ctx) => ctx.db.get("tenantPaymentConnections", connectionId));
    expect(stored?.webhookSecret).toBe(valid);
    expect(stored?.previousWebhookSecret).toBeUndefined();
  });
});
