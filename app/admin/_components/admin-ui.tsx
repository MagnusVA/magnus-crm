import type { Doc } from "@/convex/_generated/dataModel";
import { cn } from "@/lib/utils";

// Words, inks and formats shared by the System admin page (DESIGN.md, the
// Departures Board). No hooks here.

export type TenantStatus = Doc<"tenants">["status"];

export type TenantRow = Doc<"tenants"> & { calendlyWebhookUri?: string };

/** What the invite link card shows after a create or a new link. */
export type InviteResult = {
  tenantId: string;
  workosOrgId: string;
  companyName: string;
  inviteUrl: string;
  expiresAt: number;
};

/** The page's measure and container: everything folds by the page's width. */
export const ADMIN_ROOT = "@container mx-auto flex w-full max-w-[1100px] min-w-0 flex-col gap-3.5 pb-6 text-sm short:gap-3";

export const TENANT_STATUS_LABEL: Record<TenantStatus, string> = {
  pending_signup: "Pending signup",
  invite_expired: "Invite expired",
  pending_calendly: "Pending Calendly",
  provisioning_webhooks: "Provisioning",
  active: "Active",
  calendly_disconnected: "Disconnected",
  suspended: "Suspended",
};

/** Amber while the company owes a step, red when it failed or lapsed, ink when live, slate otherwise. */
const TENANT_STATUS_INK: Record<TenantStatus, string> = {
  pending_signup: "text-warning-ink",
  pending_calendly: "text-warning-ink",
  invite_expired: "text-danger-ink",
  calendly_disconnected: "text-danger-ink",
  provisioning_webhooks: "text-muted-foreground",
  active: "text-foreground",
  suspended: "text-muted-foreground",
};

/** The band's tabs, in the order a company moves through them. */
export const STATUS_TABS: Array<TenantStatus | undefined> = [
  undefined,
  "pending_signup",
  "invite_expired",
  "pending_calendly",
  "provisioning_webhooks",
  "active",
  "calendly_disconnected",
  "suspended",
];

/** The empty line under a tab. */
export const EMPTY_FOR_STATUS: Record<TenantStatus, string> = {
  pending_signup: "No tenants are pending signup.",
  invite_expired: "No tenants have an expired invite.",
  pending_calendly: "No tenants are waiting on Calendly.",
  provisioning_webhooks: "No tenants are provisioning.",
  active: "No tenants are active.",
  calendly_disconnected: "No tenants are disconnected.",
  suspended: "No tenants are suspended.",
};

/** Only these can be sent a new invite link. */
export function hasOpenInvite(status: TenantStatus) {
  return status === "pending_signup" || status === "invite_expired";
}

export const STATUS_WORD =
  "font-condensed text-[13px] leading-[1.1] font-bold tracking-[0.08em] whitespace-nowrap uppercase";

/** A date or time in a column: condensed, tabular. */
export const FIGURE = "font-condensed text-[15px] leading-tight font-semibold tabular-nums";

export function TenantStatusWord({ status, className }: { status: TenantStatus; className?: string }) {
  return (
    <span className={cn(STATUS_WORD, TENANT_STATUS_INK[status], className)}>{TENANT_STATUS_LABEL[status]}</span>
  );
}

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

function sameDay(at: number, now: number) {
  return new Date(at).toDateString() === new Date(now).toDateString();
}

/** "Oct 28", or "Dec 11, 2025" outside this year. */
export function formatDay(at: number, now: number) {
  return formatter(
    sameYear(at, now) ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" },
  ).format(at);
}

/** "4:12 PM" */
export function formatClock(at: number) {
  return formatter({ hour: "numeric", minute: "2-digit" }).format(at);
}

/** "Nov 3, 4:12 PM", with the year outside this year. */
export function formatDayTime(at: number, now: number) {
  return `${formatDay(at, now)}, ${formatClock(at)}`;
}

/** "Nov 9, 2026, 11:20 AM": the full moment, for a `title`. */
export function formatFull(at: number) {
  return formatter({ month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(at);
}

/** An invite's end in a row: the time when it's today, else the day. */
export function formatInviteEnd(at: number, now: number) {
  return sameDay(at, now) ? formatClock(at) : formatDay(at, now);
}

export function plural(count: number, one: string, many = `${one}s`) {
  return `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
}
