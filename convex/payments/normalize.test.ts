import { expect, test } from "vitest";
import { paymentFixture, TEST_TIME } from "../../tests/whopFixtures";
import { normalizePayment, paymentSchema, webhookObject } from "./whop/normalize";

function normalize(overrides: Record<string, unknown> = {}) {
  return normalizePayment(paymentSchema.parse(paymentFixture(overrides)));
}

test.each([
  ["2437.50", "usd", 2, 243750],
  ["0.10", "usd", 2, 10],
  ["1000", "usd", 2, 100000],
  ["1.001", "kwd", 3, undefined],
  ["1000", "jpy", 0, undefined],
  ["1.012345678901234567", "eth", 18, undefined],
])("normalizes %s %s exactly at precision %i", (amount, currency, decimals, expected) => {
  const total = { amount, currency, decimals };
  expect(normalize({ total, amount_charged: total })).toMatchObject({
    totalMinor: expected,
    buyerChargedMinor: expected,
    currency: currency.toUpperCase(),
    decimals,
  });
});

test("derives status, refunds, titles and purchaser identity from allowlisted facts", () => {
  const result = normalize({
    status: "a_future_status",
    substatus: "partially_refunded",
    refunded_amount: { amount: "0.10", currency: "usd", decimals: 2 },
    payer_name: "Fixture buyer",
    failure_message: "Fixture error text",
    decline_code: "arbitrary_vendor_text",
  });
  expect(result).toMatchObject({
    status: "unknown",
    adverseState: "partially_refunded",
    refundedMinor: 10,
    paidAt: TEST_TIME,
    payerEmail: "synthetic-payer@example.invalid",
    payerPhone: "+12025550100",
    productTitle: "Fixture product",
    variantTitle: "Fixture variant",
    lineItemCount: 1,
    declineCode: "other",
  });
  expect(result).not.toHaveProperty("failure_message");
  expect(result).not.toHaveProperty("payer_name");
});

test("keeps no placeholder email or locally formatted phone", () => {
  const result = normalize({
    customer_email: "email@example.invalid", customer_phone: "(202) 555-0100",
    decline_code: "insufficient_funds",
  });
  expect(result.payerEmail).toBeUndefined();
  expect(result.payerPhone).toBeUndefined();
  expect(result.declineCode).toBe("insufficient_funds");
});

test("uses refund amounts and dispute fields when substatus is unchanged", () => {
  expect(normalize({
    refunded_amount: { amount: "2437.50", currency: "usd", decimals: 2 },
  }).adverseState).toBe("refunded");
  expect(normalize({
    dispute_created_at: new Date(TEST_TIME).toISOString(),
  }).adverseState).toBe("dispute_open");
});

test("extracts only object ids from the legacy refund webhook shape", () => {
  expect(webhookObject("refund.created", { id: "refund_fixture", payment: null })).toEqual({
    externalObjectId: "refund_fixture", externalPaymentId: undefined,
  });
  expect(webhookObject("refund.created", {
    id: "refund_fixture", payment: { id: "pay_fixture", name: "Fixture buyer" },
  })).toEqual({ externalObjectId: "refund_fixture", externalPaymentId: "pay_fixture" });
});
