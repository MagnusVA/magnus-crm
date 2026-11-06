import type { PaymentType } from "@/convex/lib/paymentTypes";
import type { BillingPaymentStatus } from "@/convex/billing/types";

// Words, figures and shared classes for the Billing queue and payment page.
// Billing dates follow the viewer's browser time zone (the band says so).

export const PAYMENT_TYPE_LABELS: Record<PaymentType, string> = {
  monthly: "Monthly",
  split: "Split",
  pif: "Paid in full",
  deposit: "Deposit",
};

export const STATUS_LABELS: Record<BillingPaymentStatus, string> = {
  recorded: "Needs review",
  verified: "Reviewed",
  disputed: "Disputed",
};

/** One condensed status word, coloured by meaning: owed amber, lost red, done slate. */
export const STATUS_INK: Record<BillingPaymentStatus, string> = {
  recorded: "text-warning-ink",
  verified: "text-muted-foreground",
  disputed: "text-danger-ink",
};

export const STATUS_WORD =
  "font-condensed text-[13px] leading-[1.1] font-bold tracking-[0.08em] whitespace-nowrap uppercase";

/** Column heads and fact-group labels: 11px condensed caps. */
export const LABEL =
  "font-condensed text-[11px] leading-[1.2] font-semibold tracking-[0.14em] text-muted-foreground uppercase";

/** A time or amount in a column. */
export const FIGURE = "font-condensed text-[15px] leading-tight font-semibold tabular-nums";

/**
 * The band's board-tone outline button (Qualifications' band buttons). Give it
 * to a Button directly.
 */
export const BAND_BUTTON_CLASS =
  "h-[34px] rounded-[7px] border-board-foreground/15 bg-board-raised px-3 text-[13px] text-board-foreground hover:bg-board-foreground/10 hover:text-board-foreground aria-expanded:bg-board-foreground/10 aria-expanded:text-board-foreground dark:border-board-foreground/15 dark:bg-board-raised dark:hover:bg-board-foreground/10";

/** The same look for a shared trigger, set from a `display: contents` wrapper. */
export const BAND_BUTTON_WRAPPER =
  "contents [&>button]:h-[34px] [&>button]:rounded-[7px] [&>button]:border-board-foreground/15 [&>button]:bg-board-raised [&>button]:px-3 [&>button]:text-[13px] [&>button]:text-board-foreground [&>button:hover]:bg-board-foreground/10 [&>button:hover]:text-board-foreground [&>button[aria-expanded=true]]:bg-board-foreground/10 [&>button[aria-expanded=true]]:text-board-foreground";

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(options: Intl.DateTimeFormatOptions) {
  const key = JSON.stringify(options);
  let cached = formatters.get(key);
  if (!cached) {
    cached = new Intl.DateTimeFormat("en-US", options);
    formatters.set(key, cached);
  }
  return cached;
}

function sameYear(at: number, now: number) {
  return new Date(at).getFullYear() === new Date(now).getFullYear();
}

/** "Nov 3", or "Nov 3, 2025" outside this year. */
export function formatPaidDate(at: number, now = Date.now()) {
  return formatter(
    sameYear(at, now) ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" },
  ).format(at);
}

/** "4:12 PM" */
export function formatPaidClock(at: number) {
  return formatter({ hour: "numeric", minute: "2-digit" }).format(at);
}

/** "Nov 3, 4:12 PM", with the year outside this year. */
export function formatPaidAt(at: number, now = Date.now()) {
  return `${formatPaidDate(at, now)}, ${formatPaidClock(at)}`;
}

/** The customer's name, then email, then phone. */
export function customerName(customer: { fullName: string | null; email: string | null; phone?: string | null }) {
  return customer.fullName || customer.email || customer.phone || null;
}

export function formatBytes(size: number | null) {
  if (size === null) return null;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function isImageContentType(contentType: string | null) {
  return contentType?.startsWith("image/") ?? false;
}

export function isPdfContentType(contentType: string | null) {
  return contentType === "application/pdf";
}

/** "Image", "PDF", or the file's subtype. */
export function proofTypeLabel(contentType: string | null) {
  if (!contentType) return "File";
  if (isImageContentType(contentType)) return "Image";
  if (isPdfContentType(contentType)) return "PDF";
  return contentType.split("/").pop()?.toUpperCase() ?? "File";
}

export function plural(count: number, one: string, many = `${one}s`) {
  return `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
}
