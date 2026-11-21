// Mirror the payment fields and identity normalization used by Convex.
// Keep open-ended provider labels out of the report, even during fixture replay.
export const DAY = 86_400_000;
export const BILLING_REASONS = new Set([
  "subscription_create", "subscription_cycle", "subscription_update",
  "one_time", "manual", "subscription",
]);

const FINANCING_METHODS = new Set([
  "addi", "affirm", "afterpay", "afterpay_clearpay", "alma", "billie",
  "capchase_pay", "card_installments_three", "card_installments_six",
  "card_installments_twelve", "claritypay", "clearpay", "flex_pay",
  "klarna", "kriya", "kueski", "mondu", "oney", "oney_3x", "oney_4x",
  "paypal_pay_later", "scalapay", "sequra", "sezzle", "splitit", "sunbit",
  "tabby", "tamara", "zip",
]);

// PaymentMethodTypes in the pinned Whop API schema.
const PAYMENT_METHODS = new Set([
  ...FINANCING_METHODS,
  ...`acss_debit alipay alipayhk amazon_pay apple apple_pay au_bank_transfer
  au_becs_debit bacs_debit bancolombia bancontact bank_wire blik boleto bre_b
  ca_bank_transfer card card_present cashapp coinbase crypto crypto_subscription
  custom customer_balance demo_pay duitnow_qr efecty eps eu_bank_transfer fpx
  gb_bank_transfer gcash giropay google_pay gopay grabpay id_bank_transfer ideal
  interac international_bank_wire kakao_pay klarna_pay_now konbini kr_card kr_market
  link mb_way m_pesa mercado_pago mercado_pago_ar mercado_pago_mx mobilepay modo
  multibanco naver_pay nequi netbanking ng_bank ng_bank_transfer ng_card ng_market
  ng_ussd ng_wallet nupay nz_bank_account opay oxxo p24 pago_efectivo pse pay_by_bank
  payco paynow paypal paypal_express paypay payto payto_email payto_phone
  payto_bank_account pix pix_automatico platform_balance promptpay qris rapipago
  rechnung revolut_pay samsung_pay satispay sencillito sepa_debit servipag shop_pay
  shopeepay sofort south_korea_market spei swish touch_n_go twint upi us_bank_account
  us_bank_transfer venmo verve vipps webpay wechat_pay whop_pay yape coinflow unknown`.split(/\s+/),
]);

const STATUSES = new Set([
  "draft", "open", "authorized", "paid", "pending", "uncollectible", "unresolved", "void",
]);

const CURRENCIES = new Set([
  ...Intl.supportedValuesOf("currency"), "BTC", "ETH", "USDT", "WHOP_USD",
]);

const PLACEHOLDER_PHONE_DIGITS = new Set([
  "1234567890", "12345678910", "11234567890", "0123456789", "0987654321",
  "12342342342", "12345678901", "12123456789", "12345678945", "61423567890",
  "61234567891", "912345678990", "529876543210", "431234567", "6281234567890",
  "447462345678", "254712345678", "61422345678", "3593456789", "46701234567",
  "33234567891", "493012345678", "49234567891", "41791234567",
]);

export function usableEmail(raw) {
  if (typeof raw !== "string") return undefined;
  const email = raw.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return undefined;
  const [local, domain] = email.split("@");
  if (local === "email" || domain === "notanemail.com") return undefined;
  return email;
}

export function usablePhone(raw) {
  if (typeof raw !== "string" || !raw.trim().startsWith("+")) return undefined;
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return undefined;
  if (/^(\d)\1+$/.test(digits) || PLACEHOLDER_PHONE_DIGITS.has(digits)) return undefined;
  const national = /^1(\d{10})$/.exec(digits)?.[1];
  if (national) {
    const repetitive = national.slice(0, 9) === national.slice(0, 3).repeat(3);
    const sequential = "0123456789 9876543210".includes(national.slice(0, 7)) ||
      "0123456789 9876543210".includes(national.slice(1, 8)) ||
      "0123456789 9876543210".includes(national.slice(2, 9)) ||
      "0123456789 9876543210".includes(national.slice(3));
    if (repetitive || sequential) return undefined;
  }
  return `+${digits}`;
}

export function exactMinorUnits(amount, decimals) {
  if (typeof amount !== "string" || amount.length > 100) return undefined;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30) return undefined;
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(amount);
  if (!match) return undefined;
  const [, sign, whole, fraction = ""] = match;
  if (/[1-9]/.test(fraction.slice(decimals))) return undefined;
  const minor = BigInt(whole + fraction.slice(0, decimals).padEnd(decimals, "0"));
  return sign ? -minor : minor;
}

export function formatMinorUnits(minor, decimals) {
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString().padStart(decimals + 1, "0");
  const amount = decimals === 0 ? digits : `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
  return negative ? `-${amount}` : amount;
}

export function scaleMinorUnits(minor, decimals, scale) {
  return minor * 10n ** BigInt(scale - decimals);
}

function currencyCode(raw) {
  if (typeof raw !== "string" || !/^(?:[a-z]{3}|usdt|whop_usd)$/i.test(raw)) return undefined;
  return raw.toUpperCase();
}

export function reportCurrency(currency) {
  return CURRENCIES.has(currency) ? currency : "Unrecognized or missing currency";
}

function money(raw) {
  if (raw == null) return undefined;
  const currency = currencyCode(raw.currency);
  const minor = exactMinorUnits(raw.amount, raw.decimals);
  if (!currency || minor === undefined) throw new Error("Whop returned invalid money. No report was written.");
  return { minor, currency, decimals: raw.decimals };
}

export function timestamp(raw) {
  if (raw == null) return undefined;
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(raw)) return undefined;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function count(raw) {
  return Number.isSafeInteger(raw) && raw >= 0 ? raw : undefined;
}

function disputeState(substatus, row, refunded) {
  if (substatus === "dispute_lost") return substatus;
  if ([
    "open_dispute", "dispute_warning", "dispute_warning_needs_response",
    "dispute_warning_under_review", "dispute_needs_response", "dispute_under_review",
  ].includes(substatus)) return "dispute_open";
  if (refunded) return undefined;
  if (substatus === "dispute_won") return substatus;
  if (row.dispute_alerted_at || (row.dispute_created_at &&
    substatus !== "dispute_closed" && substatus !== "dispute_warning_closed")) return "dispute_open";
  return undefined;
}

export function normalizePayment(row) {
  const createdAt = timestamp(row.created_at);
  if (typeof row.id !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(row.id) || createdAt === undefined) {
    throw new Error("Whop returned a payment with an invalid identifier or creation timestamp.");
  }
  const total = money(row.total);
  const refund = money(row.refunded_amount);
  const method = PAYMENT_METHODS.has(row.payment_method_type) ? row.payment_method_type : undefined;
  const financingInstallments = count(row.financing_installments_count);
  const installments = financingInstallments ?? count(row.payment_instrument?.installment_count);
  const refunded = ["refunded", "partially_refunded", "auto_refunded"].includes(row.substatus) ||
    row.auto_refunded === true || (refund?.minor ?? 0n) > 0n || Boolean(row.refunded_at);
  const disputeHold = Boolean(disputeState(row.substatus, row, refunded));
  return {
    id: row.id,
    status: STATUSES.has(row.status) ? row.status : "unknown",
    createdAt,
    updatedAt: timestamp(row.updated_at) ?? createdAt,
    paidAt: timestamp(row.paid_at),
    total,
    currency: total?.currency ?? currencyCode(row.currency),
    decimals: total?.decimals ?? count(row.amount_charged?.decimals),
    email: usableEmail(row.customer_email),
    phone: usablePhone(row.customer_phone),
    productId: row.product_id,
    variantId: row.variant_id,
    membershipId: row.membership_id,
    checkoutId: row.checkout_configuration_id,
    lineItemCount: Array.isArray(row.line_items) ? row.line_items.length : 0,
    billingReason: BILLING_REASONS.has(row.billing_reason) ? row.billing_reason : undefined,
    paymentMethod: method ?? (row.payment_method_type == null ? "Missing" : "Other"),
    installments,
    financing: (financingInstallments ?? installments ?? 0) > 1 || FINANCING_METHODS.has(method),
    refunded,
    disputed: disputeHold || Boolean(row.dispute_created_at || row.dispute_alerted_at ||
      ["dispute_won", "dispute_lost", "dispute_closed", "dispute_warning_closed"].includes(row.substatus)),
    disputeHold,
  };
}
