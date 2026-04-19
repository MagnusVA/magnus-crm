export type OutcomeKey =
  | "sold"
  | "lost"
  | "no_show"
  | "canceled"
  | "rescheduled"
  | "dq"
  | "follow_up"
  | "in_progress"
  | "scheduled";

export interface CallMetrics {
  bookedCalls: number;
  canceledCalls: number;
  noShows: number;
  reviewRequiredCalls: number;
  callsShowed: number;
  confirmedAttendanceDenominator: number;
  showUpRate: number | null;
}

export interface MeetingTimeKpis {
  startedMeetingsCount: number;
  onTimeStartCount: number;
  lateStartCount: number;
  totalLateStartMs: number;
  completedWithDurationCount: number;
  overranCount: number;
  totalOverrunMs: number;
  totalActualDurationMs: number;
  scheduleAdherentCount: number;
  manuallyCorrectedCount: number;
  onTimeStartRate: number | null;
  avgLateStartMs: number | null;
  overranRate: number | null;
  avgOverrunMs: number | null;
  avgActualDurationMs: number | null;
  scheduleAdherenceRate: number | null;
}

export interface CloserData {
  closerId: string;
  closerName: string;
  newCalls: CallMetrics;
  followUpCalls: CallMetrics;
  meetingTime: MeetingTimeKpis;
  sales: number;
  cashCollectedMinor: number;
  adminLoggedRevenueMinor: number;
  closeRate: number | null;
  avgCashCollectedMinor: number | null;
}

export interface TeamTotals {
  newBookedCalls: number;
  newCanceled: number;
  newNoShows: number;
  newReviewRequired: number;
  newShowed: number;
  followUpBookedCalls: number;
  followUpCanceled: number;
  followUpNoShows: number;
  followUpReviewRequired: number;
  followUpShowed: number;
  totalSales: number;
  totalRevenue: number;
  totalRevenueMinor: number;
  newConfirmedAttendanceDenominator: number;
  newShowUpRate: number | null;
  followUpConfirmedAttendanceDenominator: number;
  followUpShowUpRate: number | null;
  totalReviewRequired: number;
  overallConfirmedDenominator: number;
  overallShowUpRate: number | null;
  overallCloseRate: number | null;
  totalAdminLoggedRevenueMinor: number;
  avgCashCollectedMinor: number | null;
  excludedRevenueMinor: number;
  excludedSales: number;
}

export interface DerivedOutcomes {
  lostDeals: number;
  rebookRate: number | null;
  rebookNumerator: number;
  rebookDenominator: number;
}

export interface ActionsPerCloserMetrics {
  totalCloserActions: number;
  distinctCloserActors: number;
  daySpanDays: number;
  actionsPerCloserPerDay: number | null;
  topCloserActors: Array<{
    userId: string;
    actorName: string;
    count: number;
  }>;
  isTruncated: boolean;
}

export interface TeamOutcomeMix {
  teamOutcome: Record<OutcomeKey, number>;
  closerOutcomes: Array<{
    closerId: string;
    closerName: string;
    outcomes: Record<OutcomeKey, number>;
  }>;
  derived: DerivedOutcomes;
  isTruncated: boolean;
}
