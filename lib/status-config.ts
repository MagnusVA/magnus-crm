/**
 * Centralised status configuration for the entire application.
 *
 * Every surface that renders a status (badges, dots, calendar blocks,
 * pipeline strips, admin tables) MUST use this config to ensure
 * visual consistency.
 */

// ─── Opportunity statuses ────────────────────────────────────────────

export const OPPORTUNITY_STATUSES = [
  "scheduled",
  "in_progress",
  "meeting_overran",
  "payment_received",
  "follow_up_scheduled",
  "reschedule_link_sent",
  "lost",
  "canceled",
  "no_show",
] as const;

export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];

export function isValidOpportunityStatus(
  value: string,
): value is OpportunityStatus {
  return (OPPORTUNITY_STATUSES as readonly string[]).includes(value);
}

// ─── Meeting statuses ────────────────────────────────────────────────

export const MEETING_STATUSES = [
  "scheduled",
  "in_progress",
  "completed",
  "canceled",
  "no_show",
  "meeting_overran",
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

// ─── Opportunity display config ──────────────────────────────────────

type StatusVisualConfig = {
  label: string;
  /** Badge background + text classes. */
  badgeClass: string;
  /** Small status dot fill. */
  dotClass: string;
  /** Pipeline strip card background. */
  stripBg: string;
};

export const opportunityStatusConfig: Record<
  OpportunityStatus,
  StatusVisualConfig
> = {
  scheduled: {
    label: "Scheduled",
    badgeClass:
      "bg-blue-500/10 text-blue-700 border-blue-200 dark:text-blue-400 dark:border-blue-900",
    dotClass: "bg-blue-500",
    stripBg:
      "bg-blue-500/5 hover:bg-blue-500/10 border-blue-200/60 dark:border-blue-900/60",
  },
  in_progress: {
    label: "In Progress",
    badgeClass:
      "bg-amber-500/10 text-amber-700 border-amber-200 dark:text-amber-400 dark:border-amber-900",
    dotClass: "bg-amber-500",
    stripBg:
      "bg-amber-500/5 hover:bg-amber-500/10 border-amber-200/60 dark:border-amber-900/60",
  },
  meeting_overran: {
    label: "Meeting Overran",
    badgeClass:
      "bg-yellow-500/10 text-yellow-700 border-yellow-200 dark:text-yellow-400 dark:border-yellow-900",
    dotClass: "bg-yellow-500",
    stripBg:
      "bg-yellow-500/5 hover:bg-yellow-500/10 border-yellow-200/60 dark:border-yellow-900/60",
  },
  follow_up_scheduled: {
    label: "Follow-up",
    badgeClass:
      "bg-violet-500/10 text-violet-700 border-violet-200 dark:text-violet-400 dark:border-violet-900",
    dotClass: "bg-violet-500",
    stripBg:
      "bg-violet-500/5 hover:bg-violet-500/10 border-violet-200/60 dark:border-violet-900/60",
  },
  reschedule_link_sent: {
    label: "Reschedule Sent",
    badgeClass:
      "bg-sky-500/10 text-sky-700 border-sky-200 dark:text-sky-400 dark:border-sky-900",
    dotClass: "bg-sky-500",
    stripBg:
      "bg-sky-500/5 hover:bg-sky-500/10 border-sky-200/60 dark:border-sky-900/60",
  },
  payment_received: {
    label: "Won",
    badgeClass:
      "bg-emerald-500/10 text-emerald-700 border-emerald-200 dark:text-emerald-400 dark:border-emerald-900",
    dotClass: "bg-emerald-500",
    stripBg:
      "bg-emerald-500/5 hover:bg-emerald-500/10 border-emerald-200/60 dark:border-emerald-900/60",
  },
  lost: {
    label: "Lost",
    badgeClass:
      "bg-red-500/10 text-red-700 border-red-200 dark:text-red-400 dark:border-red-900",
    dotClass: "bg-red-500",
    stripBg:
      "bg-red-500/5 hover:bg-red-500/10 border-red-200/60 dark:border-red-900/60",
  },
  canceled: {
    label: "Canceled",
    badgeClass: "bg-muted text-muted-foreground border-border",
    dotClass: "bg-muted-foreground",
    stripBg: "bg-muted/50 hover:bg-muted border-border/60",
  },
  no_show: {
    label: "No Show",
    badgeClass:
      "bg-orange-500/10 text-orange-700 border-orange-200 dark:text-orange-400 dark:border-orange-900",
    dotClass: "bg-orange-500",
    stripBg:
      "bg-orange-500/5 hover:bg-orange-500/10 border-orange-200/60 dark:border-orange-900/60",
  },
};

// ─── Meeting block config (calendar) ─────────────────────────────────

type MeetingBlockConfig = {
  label: string;
  blockClass: string;
  textClass: string;
};

export const meetingStatusConfig: Record<MeetingStatus, MeetingBlockConfig> = {
  scheduled: {
    label: "Scheduled",
    blockClass: "bg-blue-500/10 border-l-blue-500",
    textClass: "text-blue-700 dark:text-blue-300",
  },
  in_progress: {
    label: "In Progress",
    blockClass: "bg-amber-500/10 border-l-amber-500",
    textClass: "text-amber-700 dark:text-amber-300",
  },
  completed: {
    label: "Completed",
    blockClass: "bg-emerald-500/10 border-l-emerald-500",
    textClass: "text-emerald-700 dark:text-emerald-300",
  },
  canceled: {
    label: "Canceled",
    blockClass: "bg-muted/60 border-l-muted-foreground",
    textClass: "text-muted-foreground line-through",
  },
  no_show: {
    label: "No Show",
    blockClass: "bg-orange-500/10 border-l-orange-500",
    textClass: "text-orange-700 dark:text-orange-300",
  },
  meeting_overran: {
    label: "Meeting Overran",
    blockClass: "bg-yellow-500/10 border-l-yellow-500",
    textClass: "text-yellow-700 dark:text-yellow-400",
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

// ─── Pipeline display order ──────────────────────────────────────────

export const PIPELINE_DISPLAY_ORDER: OpportunityStatus[] = [
  "scheduled",
  "in_progress",
  "meeting_overran",
  "follow_up_scheduled",
  "payment_received",
  "reschedule_link_sent",
  "lost",
  "canceled",
  "no_show",
];
