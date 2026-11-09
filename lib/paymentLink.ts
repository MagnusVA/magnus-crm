// Relative, not "@/", so Convex functions can import this module too.
import type { PaymentType } from "../convex/lib/paymentTypes";

/**
 * The payment link (docs/plans/closer-assistant.md §6.3 "The link", decision
 * 27). An agent that can't pass a proof file hands the closer a link with
 * the payment's values filled in; no payment exists until the closer
 * attaches the receipt in the browser, under their normal login and the
 * page's ownership check. The payment is then recorded as `web`.
 *
 * Two pages take the values:
 *
 * - the receipt page, `/workspace/closer/pay?meetingId=…` (or `followUpId=…`)
 *   `&amount=…&currency=…&type=…&program=…`, made for a phone: the values
 *   read-only, one proof drop zone and one button. `buildPaymentLink`
 *   builds it, and it is the link an agent returns.
 * - the full dialog, `/workspace/closer/meetings/<meetingId>?logPayment=1&…`
 *   or `/workspace/closer/reminders/<followUpId>?logPayment=1&…`, where every
 *   value can change. `buildPaymentDialogLink` builds it, and the receipt
 *   page's "Edit in full" opens it.
 *
 * This module has no React or Convex runtime imports, so Convex functions
 * can import it too (as `../../lib/paymentLink`).
 */

export const PAYMENT_LINK_TYPES = ["monthly", "split", "pif", "deposit"] as const satisfies readonly PaymentType[];

/** The receipt page's path. */
export const PAYMENT_RECEIPT_PATH = "/workspace/closer/pay";

/** The query flag that opens the payment dialog on a meeting or task page. */
export const LOG_PAYMENT_PARAM = "logPayment";

/** Where the payment goes: a meeting's result, or a call-back task's. */
export type PaymentLinkTarget =
  | { meetingId: string; followUpId?: undefined }
  | { followUpId: string; meetingId?: undefined };

/** The values the link fills in. Each is optional; the page asks for the rest. */
export type PaymentLinkValues = {
  /** In major units, such as 1500 or 99.5. */
  amount?: number;
  /** An ISO 4217 code, such as "USD". */
  currency?: string;
  paymentType?: PaymentType;
  programId?: string;
};

export type PaymentLinkInput = PaymentLinkTarget & PaymentLinkValues;

type LinkOptions = {
  /**
   * The app's origin, such as "https://app.example.com", for an absolute
   * link. Without it the link is a path.
   */
  baseUrl?: string;
};

function valueParams(values: PaymentLinkValues): [string, string][] {
  const params: [string, string][] = [];
  if (values.amount !== undefined && Number.isFinite(values.amount) && values.amount > 0) {
    params.push(["amount", String(Math.round(values.amount * 100) / 100)]);
  }
  if (values.currency?.trim()) params.push(["currency", values.currency.trim().toUpperCase()]);
  if (values.paymentType) params.push(["type", values.paymentType]);
  if (values.programId) params.push(["program", values.programId]);
  return params;
}

function withQuery(path: string, params: [string, string][], options: LinkOptions): string {
  const query = new URLSearchParams(params).toString();
  const relative = query ? `${path}?${query}` : path;
  return options.baseUrl ? new URL(relative, options.baseUrl).toString() : relative;
}

/**
 * The receipt page's link, the one an agent hands out:
 * `/workspace/closer/pay?meetingId=…&amount=…&currency=…&type=…&program=…`.
 */
export function buildPaymentLink(input: PaymentLinkInput, options: LinkOptions = {}): string {
  const target: [string, string] = input.meetingId
    ? ["meetingId", input.meetingId]
    : ["followUpId", input.followUpId!];
  return withQuery(PAYMENT_RECEIPT_PATH, [target, ...valueParams(input)], options);
}

/**
 * The full payment dialog's link, on the meeting or task page:
 * `/workspace/closer/meetings/<meetingId>?logPayment=1&amount=…`.
 */
export function buildPaymentDialogLink(input: PaymentLinkInput, options: LinkOptions = {}): string {
  const path = input.meetingId
    ? `/workspace/closer/meetings/${encodeURIComponent(input.meetingId)}`
    : `/workspace/closer/reminders/${encodeURIComponent(input.followUpId!)}`;
  return withQuery(path, [[LOG_PAYMENT_PARAM, "1"], ...valueParams(input)], options);
}

type ReadableParams = Pick<URLSearchParams, "get">;

/**
 * The values a link carries, each dropped when it isn't valid: an amount
 * must be a positive number, a type one of the four, and a currency three
 * letters. The mutations check them all again.
 */
export function readPaymentLinkValues(params: ReadableParams): PaymentLinkValues {
  const values: PaymentLinkValues = {};
  const amount = Number(params.get("amount"));
  if (params.get("amount") && Number.isFinite(amount) && amount > 0) {
    values.amount = Math.round(amount * 100) / 100;
  }
  const currency = params.get("currency")?.trim().toUpperCase();
  if (currency && /^[A-Z]{3}$/.test(currency)) values.currency = currency;
  const type = params.get("type");
  if (type && (PAYMENT_LINK_TYPES as readonly string[]).includes(type)) {
    values.paymentType = type as PaymentType;
  }
  const program = params.get("program")?.trim();
  if (program) values.programId = program;
  return values;
}

/** The receipt page's target and values, or null when it names neither. */
export function readPaymentLink(params: ReadableParams): PaymentLinkInput | null {
  const values = readPaymentLinkValues(params);
  const meetingId = params.get("meetingId")?.trim();
  if (meetingId) return { meetingId, ...values };
  const followUpId = params.get("followUpId")?.trim();
  if (followUpId) return { followUpId, ...values };
  return null;
}

/** Whether a meeting or task page was opened to log a payment. */
export function opensPaymentDialog(params: ReadableParams): boolean {
  return params.get(LOG_PAYMENT_PARAM) === "1";
}
