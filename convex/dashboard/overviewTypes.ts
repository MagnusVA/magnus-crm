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
};

export type TopDmCloserRow = {
  dmCloserId: Id<"dmClosers">;
  displayName: string;
  teamName: string | null;
  scheduled: number;
  completed: number;
  noShows: number;
  reviewRequired: number;
  showRate: number | null;
};

export type PhoneCloserOperations = {
  rows: Array<{
    closerId: Id<"users">;
    closerName: string;
    scheduled: number;
    noShows: number;
    noShowRate: number | null;
    closeRate: number | null;
    cashCollectedMinor: number;
  }>;
  totals: {
    scheduled: number;
    noShows: number;
    noShowRate: number | null;
    closeRate: number | null;
    cashCollectedMinor: number;
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
  topQualifiers: SectionResult<{ rows: TopQualifierRow[] }>;
  topDmClosers: SectionResult<{ rows: TopDmCloserRow[] }>;
  phoneCloserOperations: SectionResult<PhoneCloserOperations>;
  topOrigins: SectionResult<{ rows: TopOriginRow[] }>;
};
