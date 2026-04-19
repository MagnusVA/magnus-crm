export type ResolutionAction =
  | "log_payment"
  | "schedule_follow_up"
  | "mark_no_show"
  | "mark_lost"
  | "acknowledged"
  | "disputed";

export type CloserResponseKey =
  | "forgot_to_press"
  | "did_not_attend"
  | "no_response";

export type ResolutionMix = Record<ResolutionAction, number>;
export type CloserResponseMix = Record<CloserResponseKey, number>;

export interface ReviewerWorkloadRow {
  userId: string;
  reviewerName: string;
  resolved: number;
  avgLatencyMs: number | null;
}

export interface ReviewBacklogSnapshot {
  pendingCount: number;
  isTruncated: boolean;
  measuredAt: number;
}

export interface ReviewsReportMetrics {
  backlog: ReviewBacklogSnapshot;
  resolvedCount: number;
  unclassifiedResolved: number;
  resolutionMix: ResolutionMix;
  manualTimeCorrectionCount: number;
  manualTimeCorrectionRate: number | null;
  avgResolveLatencyMs: number | null;
  closerResponseMix: CloserResponseMix;
  disputeRate: number | null;
  disputedRevenueMinor: number;
  disputedPaymentsCount: number;
  isResolvedRangeTruncated: boolean;
  isDisputedRevenueTruncated: boolean;
  reviewerWorkload: ReviewerWorkloadRow[];
}

export const REPORT_SCAN_CAP = 2000;

export const RESOLUTION_ACTIONS = [
  "log_payment",
  "schedule_follow_up",
  "mark_no_show",
  "mark_lost",
  "acknowledged",
  "disputed",
] as const satisfies ReadonlyArray<ResolutionAction>;

export const RESOLUTION_LABELS: Record<ResolutionAction, string> = {
  log_payment: "Logged Payment",
  schedule_follow_up: "Scheduled Follow-Up",
  mark_no_show: "Marked No-Show",
  mark_lost: "Marked Lost",
  acknowledged: "Acknowledged",
  disputed: "Disputed",
};

export const RESOLUTION_COLORS: Record<ResolutionAction, string> = {
  log_payment: "var(--primary)",
  schedule_follow_up: "var(--chart-2)",
  mark_no_show: "var(--status-no-show)",
  mark_lost: "var(--status-lost)",
  acknowledged: "var(--chart-1)",
  disputed: "var(--destructive)",
};

export const CLOSER_RESPONSE_KEYS = [
  "forgot_to_press",
  "did_not_attend",
  "no_response",
] as const satisfies ReadonlyArray<CloserResponseKey>;

export const CLOSER_RESPONSE_LABELS: Record<CloserResponseKey, string> = {
  forgot_to_press: "Forgot to Press Start",
  did_not_attend: "Lead Did Not Attend",
  no_response: "No Response",
};

export const CLOSER_RESPONSE_COLORS: Record<CloserResponseKey, string> = {
  forgot_to_press: "var(--chart-1)",
  did_not_attend: "var(--status-no-show)",
  no_response: "var(--muted-foreground)",
};

export function formatRate(rate: number | null): string {
  if (rate === null) {
    return "\u2014";
  }

  return `${(rate * 100).toFixed(1)}%`;
}

export function formatDurationMs(durationMs: number | null): string {
  if (durationMs === null) {
    return "\u2014";
  }

  const totalMinutes = Math.round(durationMs / 60_000);
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }

  const totalHours = Math.floor(totalMinutes / 60);
  const remainingMinutes = totalMinutes % 60;
  if (totalHours < 24) {
    return remainingMinutes === 0
      ? `${totalHours}h`
      : `${totalHours}h ${remainingMinutes}m`;
  }

  const days = Math.floor(totalHours / 24);
  const remainingHours = totalHours % 24;
  return remainingHours === 0 ? `${days}d` : `${days}d ${remainingHours}h`;
}

export function getShareOfTotal(count: number, total: number): number {
  if (total <= 0) {
    return 0;
  }

  return count / total;
}
