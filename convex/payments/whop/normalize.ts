import { z } from "zod";
import type { Infer } from "convex/values";
import type { providerAdverseStateValidator } from "../schema";
import {
  isPlaceholderEmail,
  normalizeEmail,
  normalizePhone,
} from "../../lib/normalization";

export const whopId = z.string().max(200).regex(/^[a-zA-Z0-9_-]+$/);
const code = z.string().max(100).regex(/^[a-z0-9_]+$/);
const timestamp = z.iso.datetime({ offset: true }).transform(Date.parse);

function exactMinorUnits(amount: string, decimals: number): bigint | undefined {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(amount);
  if (!match) return undefined;
  const [, sign, whole, fraction = ""] = match;
  if (/[1-9]/.test(fraction.slice(decimals))) return undefined;
  const magnitude = BigInt(whole + fraction.slice(0, decimals).padEnd(decimals, "0"));
  return sign ? -magnitude : magnitude;
}

const currency = z.string().regex(/^(?:[a-z]{3}|usdt|whop_usd)$/i).transform((value) => value.toUpperCase());
const money = z.object({
  amount: z.string().max(100),
  currency,
  decimals: z.number().int().min(0).max(30),
}).transform(({ amount, currency, decimals }, ctx) => {
  const minor = exactMinorUnits(amount, decimals);
  if (minor === undefined) {
    ctx.addIssue({ code: "custom", message: "Invalid minor units" });
    return z.NEVER;
  }
  return { minor, currency, decimals };
});

const declineCodes: ReadonlySet<string> = new Set([
  "insufficient_funds", "lost_card", "stolen_card", "expired_card",
  "suspected_fraud", "invalid_card_number", "invalid_cvc", "incorrect_pin",
  "authentication_required", "card_not_supported", "currency_not_supported",
  "duplicate_transaction", "generic_decline", "invalid_account", "invalid_amount",
  "processing_error", "restricted_card", "card_declined_by_issuer",
  "bank_declined", "issuer_unavailable", "three_d_secure_failed",
  "provider_declined", "high_risk", "try_again_later",
  "bank_insufficient_funds", "bank_account_closed", "bank_payment_stopped",
]);

const paymentStatuses = z.enum([
  "draft", "open", "authorized", "paid", "pending", "uncollectible", "unresolved", "void",
]);

export const paymentSchema = z.object({
  id: whopId,
  account_id: whopId.nullable(),
  status: z.string(),
  substatus: code.nullish(),
  billing_reason: code.nullish(),
  created_at: timestamp,
  updated_at: timestamp,
  paid_at: timestamp.nullish(),
  currency,
  total: money.nullish(),
  amount_charged: money.nullish(),
  refunded_amount: money.nullish(),
  refunded_at: timestamp.nullish(),
  dispute_created_at: timestamp.nullish(),
  dispute_alerted_at: timestamp.nullish(),
  auto_refunded: z.boolean().optional(),
  membership_id: whopId.nullish(),
  member_id: whopId.nullish(),
  user: z.object({ id: whopId }).nullish(),
  product_id: whopId.nullish(),
  variant_id: whopId.nullish(),
  checkout_configuration_id: whopId.nullish(),
  line_items: z.array(z.object({
    product_title: z.string().nullish(),
    variant_title: z.string().nullish(),
  })).optional(),
  payment_method_type: code.nullish(),
  financing_installments_count: z.number().int().nonnegative().nullish(),
  payments_failed: z.number().int().nonnegative().optional(),
  decline_code: z.string().nullish(),
  customer_email: z.string().max(320).nullish(),
  customer_phone: z.string().max(80).nullish(),
});

export const refundSchema = z.object({
  id: whopId,
  account_id: whopId.nullable(),
  payment_id: whopId,
  status: z.enum(["pending", "requires_action", "succeeded", "failed", "canceled"]),
  amount: money.nullish(),
  updated_at: timestamp,
});

const paymentReference = z.object({ id: whopId });
const refundWebhookSchema = z.object({
  id: whopId,
  payment: paymentReference.nullish(),
});

export const disputeSchema = z.object({
  id: whopId,
  account_id: whopId.nullable(),
  payment: paymentReference,
  status: code,
  updated_at: timestamp,
});

export const disputeAlertSchema = z.object({
  id: whopId,
  account_id: whopId.nullable(),
  payment_id: whopId.nullable(),
  auto_refunded: z.boolean(),
  updated_at: timestamp,
});

export const webhookEnvelopeSchema = z.object({
  type: z.string(),
  account_id: z.unknown().optional(),
  company_id: z.unknown().optional(),
  data: z.unknown(),
});

export const whopEventType = z.enum([
  "payment.created", "payment.authorized", "payment.pending", "payment.requires_action",
  "payment.succeeded", "payment.failed", "payment.canceled",
  "refund.created", "refund.updated", "dispute.created", "dispute.updated", "dispute_alert.created",
]);
export type AdverseEvent = "refund" | "dispute" | "dispute_alert";

export function adverseEvent(eventType: string): AdverseEvent | undefined {
  if (eventType.startsWith("refund.")) return "refund";
  if (eventType.startsWith("dispute.")) return "dispute";
  if (eventType === "dispute_alert.created") return "dispute_alert";
  return undefined;
}

export function webhookObject(eventType: string, data: unknown) {
  if (eventType.startsWith("payment.")) {
    const object = paymentReference.safeParse(data).data;
    return { externalPaymentId: object?.id, externalObjectId: object?.id };
  }
  if (eventType.startsWith("refund.")) {
    const object = refundWebhookSchema.safeParse(data).data;
    return { externalPaymentId: object?.payment?.id, externalObjectId: object?.id };
  }
  if (eventType.startsWith("dispute.")) {
    const object = z.object({ id: whopId, payment: paymentReference }).safeParse(data).data;
    return { externalPaymentId: object?.payment.id, externalObjectId: object?.id };
  }
  if (eventType === "dispute_alert.created") {
    const object = z.object({ id: whopId, payment_id: whopId.nullish() }).safeParse(data).data;
    return { externalPaymentId: object?.payment_id ?? undefined, externalObjectId: object?.id };
  }
  return {};
}

export type WhopPayment = z.infer<typeof paymentSchema>;

function paymentAdverseState(payment: WhopPayment): Infer<typeof providerAdverseStateValidator> {
  switch (payment.substatus) {
    case "dispute_lost":
      return "dispute_lost";
    case "dispute_needs_response":
    case "dispute_under_review":
    case "dispute_warning":
    case "dispute_warning_needs_response":
    case "dispute_warning_under_review":
    case "open_dispute":
      return "dispute_open";
    case "refunded":
    case "auto_refunded":
      return "refunded";
    case "partially_refunded":
      return "partially_refunded";
  }
  if (payment.auto_refunded) return "refunded";
  const refund = payment.refunded_amount;
  if (refund && refund.minor > 0n) {
    const total = payment.total;
    if (
      total && total.currency === refund.currency &&
      total.decimals === refund.decimals && refund.minor >= total.minor
    ) return "refunded";
    return "partially_refunded";
  }
  if (payment.refunded_at) return "refund_pending";
  if (payment.substatus === "dispute_won") return "dispute_won";
  if (
    payment.dispute_alerted_at ||
    (payment.dispute_created_at &&
      payment.substatus !== "dispute_closed" && payment.substatus !== "dispute_warning_closed")
  ) return "dispute_open";
  return "none";
}

function toSafeMinorUnits(minor: bigint): number {
  const result = Number(minor);
  if (!Number.isSafeInteger(result)) throw new Error("Whop minor units exceed the safe integer range");
  return result;
}

export function normalizePayment(payment: WhopPayment) {
  const email = payment.customer_email && normalizeEmail(payment.customer_email);
  const phone = payment.customer_phone?.trim();
  const firstItem = payment.line_items?.[0];
  const total = payment.total;
  const charged = payment.amount_charged;
  return {
    externalPaymentId: payment.id,
    status: paymentStatuses.safeParse(payment.status).data ?? "unknown" as const,
    substatus: payment.substatus ?? undefined,
    billingReason: payment.billing_reason ?? undefined,
    sourceUpdatedAt: payment.updated_at,
    sourceCreatedAt: payment.created_at,
    paidAt: payment.paid_at ?? undefined,
    totalMinor: total?.decimals === 2 ? toSafeMinorUnits(total.minor) : undefined,
    currency: total?.currency ?? payment.currency,
    decimals: total?.decimals ?? charged?.decimals ?? 0,
    buyerChargedMinor: charged?.decimals === 2 ? toSafeMinorUnits(charged.minor) : undefined,
    buyerChargedCurrency: charged?.currency,
    refundedMinor: toSafeMinorUnits(payment.refunded_amount?.minor ?? 0n),
    adverseState: paymentAdverseState(payment),
    refundedAt: payment.refunded_at ?? undefined,
    disputeCreatedAt: payment.dispute_created_at ?? undefined,
    membershipId: payment.membership_id ?? undefined,
    memberId: payment.member_id ?? undefined,
    providerUserId: payment.user?.id,
    productId: payment.product_id ?? undefined,
    variantId: payment.variant_id ?? undefined,
    checkoutConfigurationId: payment.checkout_configuration_id ?? undefined,
    productTitle: firstItem?.product_title?.slice(0, 500),
    variantTitle: firstItem?.variant_title?.slice(0, 500),
    lineItemCount: payment.line_items?.length ?? 0,
    paymentMethodType: payment.payment_method_type ?? undefined,
    financingInstallmentsCount: payment.financing_installments_count ?? undefined,
    failedAttemptCount: payment.payments_failed ?? 0,
    declineCode: payment.decline_code
      ? (declineCodes.has(payment.decline_code) ? payment.decline_code : "other")
      : undefined,
    payerEmail: email && !isPlaceholderEmail(email) ? email : undefined,
    payerPhone: phone?.startsWith("+") ? normalizePhone(phone) : undefined,
  };
}
