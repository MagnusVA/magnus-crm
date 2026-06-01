import type { Id } from "../_generated/dataModel";
import type { MemberAvatarIdentity } from "../lib/memberIdentity";

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
  duplicates: number;
  scheduledHours: number;
  leadsPerHour: number | null;
  topWorkers: Array<{
    workerId: Id<"leadGenWorkers">;
    worker: MemberAvatarIdentity;
    displayName: string;
    submissions: number;
    leadsPerHour: number | null;
  }>;
};

export type TopQualifierRow = {
  slackUserId: string;
  displayName: string | null;
  avatarUrl: string | null;
  qualifier: MemberAvatarIdentity;
  isDeleted: boolean;
  total: number;
  uniqueOpportunityCount: number;
  booked: number;
  ratio: number | null;
};

export type TopDmCloserRow = {
  dmCloserId: Id<"dmClosers">;
  dmCloser: MemberAvatarIdentity;
  displayName: string;
  teamName: string | null;
  booked: number;
};

export type PhoneCloserOperations = {
  rows: Array<{
    closerId: Id<"users">;
    closer: MemberAvatarIdentity;
    closerName: string;
    scheduled: number;
    showRate: number | null;
    closeRate: number | null;
    cashCollectedMinor: number;
  }>;
  totals: {
    scheduled: number;
    showRate: number | null;
    closeRate: number | null;
    cashCollectedMinor: number;
  };
};

export type TopOriginRow = {
  originKey: string;
  source: "instagram" | "meta_business";
  originKind: "post" | "reel" | string;
  originValue: string;
  uniqueProspects: number;
};

export type TopOriginsByTeamRow = {
  teamId: Id<"attributionTeams"> | null;
  teamName: string;
  isActive: boolean | null;
  totalUniqueProspects: number;
  origins: TopOriginRow[];
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
  topOrigins: SectionResult<{ rows: TopOriginsByTeamRow[] }>;
};
