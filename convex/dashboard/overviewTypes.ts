import type { Id } from "../_generated/dataModel";

export type SectionResult<T> =
  | {
      status: "ready";
      data: T;
      truncated: boolean;
      message: null;
    }
  | {
      status: "empty";
      data: T;
      truncated: false;
      message: string;
    }
  | {
      status: "capped";
      data: null;
      truncated: true;
      message: string;
    }
  | {
      status: "error";
      data: null;
      truncated: false;
      message: string;
    };

export type LeadGenOverview = {
  totalSubmissions: number;
  uniqueProspects: number;
  duplicates: number;
  scheduledHours: number;
  leadsPerHour: number | null;
  topWorkers: Array<{
    workerId: Id<"leadGenWorkers">;
    displayName: string;
    submissions: number;
    uniqueProspects: number;
    scheduledHours: number;
    leadsPerHour: number | null;
  }>;
};

export type TopQualifierRow = {
  slackUserId: string;
  displayName: string | null;
  avatarUrl: string | null;
  isDeleted: boolean;
  total: number;
  uniqueOpportunityCount: number;
  booked: number;
  ratio: number | null;
  scheduledHours: number;
  qualifiedPerHour: number | null;
};

export type TopDmCloserRow = {
  dmCloserId: Id<"dmClosers">;
  displayName: string;
  teamName: string | null;
  booked: number;
  scheduledHours: number;
  bookedPerHour: number | null;
};

export type PhoneCloserOperations = {
  rows: Array<{
    closerId: Id<"users">;
    closerName: string;
    scheduled: number;
    completed: number;
    noShows: number;
    reviewRequired: number;
    showRate: number | null;
    noShowRate: number | null;
  }>;
  totals: {
    scheduled: number;
    completed: number;
    noShows: number;
    reviewRequired: number;
    showRate: number | null;
    noShowRate: number | null;
  };
};

export type TopOriginRow = {
  originKey: string;
  source: "instagram" | "meta_business";
  originKind: "post" | "reel" | string;
  originValue: string;
  submissions: number;
  uniqueProspects: number;
};

export type PublicOverviewRange = {
  startBusinessDate: string;
  endBusinessDateInclusive: string;
  endBusinessDateExclusive: string;
  dayCount: number;
  label: string;
  operationsBoundary: "utc_day_key";
};

export type OverviewDashboard = {
  range: PublicOverviewRange;
  leadGen: SectionResult<LeadGenOverview>;
  topQualifiers: SectionResult<{
    rows: TopQualifierRow[];
    totalQualified: number;
  }>;
  topDmClosers: SectionResult<{
    rows: TopDmCloserRow[];
    totalBooked: number;
  }>;
  phoneCloserOperations: SectionResult<PhoneCloserOperations>;
  topOrigins: SectionResult<{ rows: TopOriginRow[] }>;
};

export type OverviewLeaderboardKind = "lead_gen" | "qualifiers" | "dm_closers";

export type LeaderboardFilters = {
  search?: string;
  schedule?: "all" | "scheduled" | "unscheduled";
  activity?: "all" | "with_activity" | "without_activity";
};

export type ExpandedOverviewLeaderboard =
  | {
      kind: "lead_gen";
      rows: LeadGenOverview["topWorkers"];
      totalRows: number;
      filteredRows: number;
      truncated: boolean;
      cappedMessage: string | null;
    }
  | {
      kind: "qualifiers";
      rows: TopQualifierRow[];
      totalRows: number;
      filteredRows: number;
      truncated: boolean;
      cappedMessage: string | null;
    }
  | {
      kind: "dm_closers";
      rows: TopDmCloserRow[];
      totalRows: number;
      filteredRows: number;
      truncated: boolean;
      cappedMessage: string | null;
    };
