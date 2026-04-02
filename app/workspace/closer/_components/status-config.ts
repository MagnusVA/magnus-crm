/**
 * Shared status configuration for closer dashboard components.
 *
 * Centralises labels, badge classes, calendar‑block classes, and pipeline‑strip
 * colors so every surface that renders status uses the same visual language.
 */

// ─── Opportunity statuses ────────────────────────────────────────────────────

export const OPPORTUNITY_STATUSES = [
  "scheduled",
  "in_progress",
  "payment_received",
  "follow_up_scheduled",
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

// ─── Meeting statuses ────────────────────────────────────────────────────────

export const MEETING_STATUSES = [
  "scheduled",
  "in_progress",
  "completed",
  "canceled",
  "no_show",
] as const;

export type MeetingStatus = (typeof MEETING_STATUSES)[number];

// ─── Opportunity display config ──────────────────────────────────────────────

type OpportunityStatusConfig = {
  label: string;
  /** Badge background + text classes. */
  badgeClass: string;
  /** Small status‑dot fill. */
  dotClass: string;
  /** Pipeline‑strip card background. */
  stripBg: string;
};

export const opportunityStatusConfig: Record<
  OpportunityStatus,
  OpportunityStatusConfig
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
  follow_up_scheduled: {
    label: "Follow-up",
    badgeClass:
      "bg-violet-500/10 text-violet-700 border-violet-200 dark:text-violet-400 dark:border-violet-900",
    dotClass: "bg-violet-500",
    stripBg:
      "bg-violet-500/5 hover:bg-violet-500/10 border-violet-200/60 dark:border-violet-900/60",
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

// ─── Meeting block config (calendar) ─────────────────────────────────────────

type MeetingStatusConfig = {
  label: string;
  /** Calendar block: background + left‑border accent. */
  blockClass: string;
  /** Calendar block text colour. */
  textClass: string;
};

export const meetingStatusConfig: Record<MeetingStatus, MeetingStatusConfig> = {
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
};

// ─── Pipeline strip display order ────────────────────────────────────────────

export const PIPELINE_DISPLAY_ORDER: OpportunityStatus[] = [
  "scheduled",
  "in_progress",
  "follow_up_scheduled",
  "payment_received",
  "lost",
  "canceled",
  "no_show",
];
