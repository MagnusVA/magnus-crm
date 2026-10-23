/**
 * Centralised status configuration for the entire application.
 *
 * Every surface that renders a status (badges, dots, calendar blocks,
 * pipeline strips, admin tables) MUST use this config to ensure
 * visual consistency.
 */

import type { DealPosition } from "../convex/opportunities/stages";

// ─── Meeting statuses ────────────────────────────────────────────────

export const MEETING_STATUSES = [
  "scheduled",
  "completed",
  "canceled",
  "no_show",
] as const;

export type MeetingStatus = (typeof MEETING_STATUSES)[number];

// ─── Tenant statuses ────────────────────────────────────────────────

export const TENANT_STATUSES = [
  "pending_signup",
  "pending_calendly",
  "provisioning_webhooks",
  "active",
  "calendly_disconnected",
  "suspended",
  "invite_expired",
] as const;

export type TenantStatus = (typeof TENANT_STATUSES)[number];

// ─── Deal position display config ────────────────────────────────────

type DealPositionVisualConfig = {
  /** Badge background + text classes. */
  badgeClass: string;
  /** Small dot or accent fill. */
  dotClass: string;
};

/**
 * The colours of each place a screen shows a deal (docs/plans/phase-5-deal-status.md
 * §4.1). Keyed by the position, so a new one fails the typecheck until it
 * has colours. Labels come from `dealPositionLabel` in
 * `convex/opportunities/stageLabels.ts`.
 */
export const dealPositionConfig: Record<DealPosition, DealPositionVisualConfig> = {
  qualified: {
    badgeClass:
      "bg-cyan-500/10 text-cyan-700 border-cyan-200 dark:text-cyan-400 dark:border-cyan-900",
    dotClass: "bg-cyan-500",
  },
  booked: {
    badgeClass:
      "bg-blue-500/10 text-blue-700 border-blue-200 dark:text-blue-400 dark:border-blue-900",
    dotClass: "bg-blue-500",
  },
  call_held: {
    badgeClass:
      "bg-indigo-500/10 text-indigo-700 border-indigo-200 dark:text-indigo-400 dark:border-indigo-900",
    dotClass: "bg-indigo-500",
  },
  follow_up: {
    badgeClass:
      "bg-violet-500/10 text-violet-700 border-violet-200 dark:text-violet-400 dark:border-violet-900",
    dotClass: "bg-violet-500",
  },
  won: {
    badgeClass:
      "bg-emerald-500/10 text-emerald-700 border-emerald-200 dark:text-emerald-400 dark:border-emerald-900",
    dotClass: "bg-emerald-500",
  },
  lost: {
    badgeClass:
      "bg-red-500/10 text-red-700 border-red-200 dark:text-red-400 dark:border-red-900",
    dotClass: "bg-red-500",
  },
};

// ─── Meeting block config (calendar) ─────────────────────────────────

export type MeetingAttendanceStatus = MeetingStatus | "not_recorded";

export function meetingAttendanceDisplay(
  meeting: { status: MeetingStatus; scheduledAt: number; durationMinutes: number },
  now: number,
): MeetingAttendanceStatus {
  return meeting.status === "scheduled" &&
    meeting.scheduledAt + meeting.durationMinutes * 60_000 <= now
    ? "not_recorded"
    : meeting.status;
}

type MeetingBlockConfig = {
  label: string;
  blockClass: string;
  textClass: string;
  badgeClass: string;
  dotClass: string;
};

export const meetingStatusConfig: Record<MeetingAttendanceStatus, MeetingBlockConfig> = {
  scheduled: {
    label: "Scheduled",
    blockClass: "bg-blue-500/10 border-l-blue-500",
    textClass: "text-blue-700 dark:text-blue-300",
    badgeClass: "bg-blue-500/10 text-blue-700 border-blue-200 dark:text-blue-400 dark:border-blue-900",
    dotClass: "bg-blue-500",
  },
  completed: {
    label: "Completed",
    blockClass: "bg-emerald-500/10 border-l-emerald-500",
    textClass: "text-emerald-700 dark:text-emerald-300",
    badgeClass: "bg-emerald-500/10 text-emerald-700 border-emerald-200 dark:text-emerald-400 dark:border-emerald-900",
    dotClass: "bg-emerald-500",
  },
  canceled: {
    label: "Canceled",
    blockClass: "bg-muted/60 border-l-muted-foreground",
    textClass: "text-muted-foreground line-through",
    badgeClass: "bg-muted text-muted-foreground border-border",
    dotClass: "bg-muted-foreground",
  },
  no_show: {
    label: "No Show",
    blockClass: "bg-orange-500/10 border-l-orange-500",
    textClass: "text-orange-700 dark:text-orange-300",
    badgeClass: "bg-orange-500/10 text-orange-700 border-orange-200 dark:text-orange-400 dark:border-orange-900",
    dotClass: "bg-orange-500",
  },
  not_recorded: {
    label: "Not recorded",
    blockClass: "bg-amber-500/10 border-l-amber-500/60",
    textClass: "text-amber-700 dark:text-amber-300",
    badgeClass: "bg-amber-500/10 text-amber-700 border-amber-200 dark:text-amber-400 dark:border-amber-900",
    dotClass: "bg-amber-500/60",
  },
};

// ─── Tenant status config ────────────────────────────────────────────

type TenantStatusConfig = {
  label: string;
  badgeVariant: "default" | "secondary" | "destructive" | "outline" | "ghost";
};

export const tenantStatusConfig: Record<TenantStatus, TenantStatusConfig> = {
  pending_signup: { label: "Pending Signup", badgeVariant: "outline" },
  pending_calendly: { label: "Pending Calendly", badgeVariant: "secondary" },
  provisioning_webhooks: { label: "Provisioning", badgeVariant: "secondary" },
  active: { label: "Active", badgeVariant: "default" },
  calendly_disconnected: {
    label: "Disconnected",
    badgeVariant: "destructive",
  },
  suspended: { label: "Suspended", badgeVariant: "ghost" },
  invite_expired: { label: "Invite Expired", badgeVariant: "destructive" },
};

// ─── Connection health config ────────────────────────────────────────

type ConnectionStatusConfig = {
  label: string;
  iconClass: string;
  badgeVariant: "default" | "secondary" | "destructive" | "outline";
  badgeClass: string;
};

export const connectionStatusConfig = {
  connected: {
    label: "Active",
    iconClass: "text-emerald-600 dark:text-emerald-400",
    badgeVariant: "outline" as const,
    badgeClass: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  },
  expiring: {
    label: "Expiring Soon",
    iconClass: "text-amber-600 dark:text-amber-400",
    badgeVariant: "outline" as const,
    badgeClass: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  },
  expired: {
    label: "Token Expired",
    iconClass: "text-destructive",
    badgeVariant: "destructive" as const,
    badgeClass: "",
  },
  disconnected: {
    label: "Disconnected",
    iconClass: "text-destructive",
    badgeVariant: "destructive" as const,
    badgeClass: "",
  },
} satisfies Record<string, ConnectionStatusConfig>;
