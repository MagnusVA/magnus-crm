import { bookingHarness } from "./bookingHarness";
import { WHOP_API_VERSION_DATE } from "../convex/payments/whop/client";
import type { Doc } from "../convex/_generated/dataModel";

export const TEST_TIME = Date.parse("2026-11-17T12:00:00.000Z");
export const ACCOUNT_ID = "biz_intake_fixture";
export const PAYMENT_ID = "pay_intake_fixture";
export const SIGNING_SECRET = "ws_intake_fixture";
export const TEST_DAY_MS = 86_400_000;

export function iso(time: number) {
  return new Date(time).toISOString();
}

export function paymentFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYMENT_ID,
    account_id: ACCOUNT_ID,
    status: "paid",
    substatus: "succeeded",
    currency: "usd",
    created_at: iso(TEST_TIME - 1000),
    updated_at: iso(TEST_TIME),
    paid_at: iso(TEST_TIME),
    total: { amount: "2437.50", currency: "usd", decimals: 2 },
    amount_charged: { amount: "2440", currency: "usd", decimals: 2 },
    refunded_amount: null,
    line_items: [{ product_title: "Fixture product", variant_title: "Fixture variant" }],
    customer_email: " SYNTHETIC-PAYER@EXAMPLE.INVALID ",
    customer_phone: "+1 (202) 555-0100",
    ...overrides,
  };
}

export async function whopFixture(overrides: Partial<Doc<"tenantPaymentConnections">> = {}) {
  const harness = await bookingHarness({ transactionLimits: true });
  const { t, tenantId } = harness;
  const connectionId = await t.run(async (ctx) => {
    const users = await ctx.db.query("users")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId)).take(2);
    return ctx.db.insert("tenantPaymentConnections", {
      tenantId,
      provider: "whop",
      environment: "sandbox",
      credentialKind: "account_key",
      apiKey: "api_intake_fixture",
      keyLast4: "ture",
      accountId: ACCOUNT_ID,
      connectedByUserId: users[0]._id,
      webhookSecret: SIGNING_SECRET,
      status: "connected",
      apiVersionDate: WHOP_API_VERSION_DATE,
      connectedAt: TEST_TIME - 60_000,
      autoImportAfter: TEST_TIME - 60_000,
      ...overrides,
    });
  });
  return { ...harness, connectionId };
}

export async function signedHeaders(
  body: string,
  webhookId: string,
  secret: string | Uint8Array<ArrayBuffer> = SIGNING_SECRET,
  now = TEST_TIME,
) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    typeof secret === "string" ? encoder.encode(secret) : secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const timestamp = String(Math.floor(now / 1000));
  const signature = new Uint8Array(await crypto.subtle.sign(
    "HMAC", key, encoder.encode(`${webhookId}.${timestamp}.${body}`),
  ));
  return new Headers({
    "webhook-id": webhookId,
    "webhook-timestamp": timestamp,
    "webhook-signature": `v1,${btoa(String.fromCharCode(...signature))}`,
  });
}
