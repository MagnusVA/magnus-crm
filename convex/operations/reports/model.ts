import type { Id } from "../../_generated/dataModel";
import type {
  ReportContribution,
  ReportKind,
  ReportSourceFilter,
  ScalarRecord,
  ScalarValue,
} from "./contracts";

export const REPORT_PAGE_SIZE = 50;
export const REPORT_PAGE_MAX_ROWS_READ = 100;
export const REPORT_PAGE_MAX_BYTES_READ = 1_000_000;

export type OperationsReportKind = ReportKind;
export type LeadGenSource = Exclude<ReportSourceFilter, "all">;
export type ReportScalar = ScalarValue;
export type { ReportContribution };

export type ReportSourcePageRequest = {
  tenantId: Id<"tenants">;
  reportKind: OperationsReportKind;
  sourceKey: string;
  startTimestamp: number;
  endTimestampExclusive: number;
  startDayKey: string;
  endDayKeyExclusive: string;
  sourceFilter: ReportSourceFilter;
  teamId: Id<"attributionTeams"> | null;
  workerId: Id<"leadGenWorkers"> | null;
  cursor: string | null;
};

export type ReportAggregateRecord = {
  section: string;
  rowKey: string;
  fields: ScalarRecord;
};

export type ReportResultRecord = ReportAggregateRecord;

export type ReportSourceRow =
  | {
      kind: "lead_gen_daily";
      statKey: string;
      workerId: string;
      teamId: string | null;
      source: LeadGenSource;
      requestedSourceFilter?: ReportSourceFilter;
      dayKey: string;
      submissions: number;
      uniqueProspects: number;
      duplicates: number;
      scheduledHours: number;
    }
  | {
      kind: "lead_gen_origin";
      originKey: string;
      source: LeadGenSource;
      originKind: string;
      originValue: string;
      dayKey: string;
      submissions: number;
      uniqueProspects: number;
    }
  | {
      kind: "lead_gen_team_origin";
      teamId: string | null;
      originKey: string;
      source: LeadGenSource;
      originKind: string;
      originValue: string;
      dayKey: string;
      submissions: number;
      uniqueProspects: number;
    }
  | {
      kind: "lead_gen_submission";
      submissionId: string;
      prospectId: string;
      workerId: string;
      workerDisplayName: string;
      workerEmail: string;
      userId: string;
      teamId: string | null;
      teamName: string | null;
      source: LeadGenSource;
      originKind: string;
      originValue: string | null;
      originRankable: boolean;
      submittedAt: number;
      voidedAt: number | null;
      voidedByUserId: string | null;
      voidReason: string | null;
      normalizedHandle: string | null;
      rawHandle: string | null;
      profileUrl: string | null;
      clientSubmissionKey: string | null;
      createdAt: number;
    }
  | {
      kind: "lead_gen_source_dimension";
      source: LeadGenSource;
    }
  | {
      kind: "lead_gen_worker";
      workerId: string;
      userId: string;
      teamId: string | null;
      label: string;
      email: string;
      isActive: boolean;
    }
  | {
      kind: "lead_gen_schedule";
      workerId: string;
      weekday: string;
      scheduledHours: number;
    }
  | {
      kind: "team";
      teamId: string;
      label: string;
      isActive: boolean;
      bookingDailyQuota: number | null;
    }
  | {
      kind: "tenant";
      slackQualificationDailyTeamQuota: number | null;
    }
  | {
      kind: "qualification_event";
      eventId: string;
      submittedAt: number;
      slackUserId: string;
      slackTeamId: string;
      fullNameSnapshot: string;
      platform: string;
      handleSnapshot: string;
      leadId: string | null;
      opportunityId: string | null;
      resultKind: string;
    }
  | {
      kind: "slack_user";
      slackUserId: string;
      label: string;
    }
  | {
      kind: "qualifier_schedule";
      slackUserId: string;
      weekday: string;
      scheduledHours: number;
    }
  | {
      kind: "booked_meeting";
      meetingId: string;
      opportunityId: string;
      leadId: string | null;
      bookedAt: number;
      scheduledAt: number;
      meetingStatus: string;
      opportunityStatus: string | null;
      bookingProgramId: string | null;
      bookingProgramName: string | null;
      leadLabel: string;
      leadHandle: string | null;
      initialSource: string | null;
      selfReportedIncome: number | null;
      attributionTeamId: string | null;
      attributionTeamLabel: string | null;
      dmCloserId: string;
      dmCloserLabel: string | null;
    }
  | {
      kind: "dm_closer";
      dmCloserId: string;
      userId: string | null;
      teamId: string;
      label: string;
      isActive: boolean;
      hourlyRateMinor: number | null;
    }
  | {
      kind: "dm_closer_schedule";
      dmCloserId: string;
      weekday: string;
      scheduledHours: number;
    }
  | {
      kind: "sales_meeting_stat";
      assignedCloserId: string;
      bookingProgramId: string | null;
      meetingStatus: string;
      count: number;
    }
  | {
      kind: "sales_call";
      meetingId: string;
      opportunityId: string;
      assignedCloserId: string;
      scheduledAt: number;
      status: string;
      bookingProgramId: string | null;
      bookingProgramName: string | null;
      soldProgramId: string | null;
      soldProgramName: string | null;
      leadId: string | null;
      leadLabel: string;
    }
  | {
      kind: "sales_payment";
      paymentId: string;
      recordedAt: number;
      opportunityId: string | null;
      amountMinor: number;
      currency: string;
      paymentType: string;
      programId: string;
      programName: string;
      effectiveCloserId: string | null;
    }
  | {
      kind: "user";
      userId: string;
      label: string;
      role: string;
      isActive: boolean;
    }
  | {
      kind: "program";
      programId: string;
      label: string;
    };

export type ReportSourcePage = {
  page: ReportSourceRow[];
  isDone: boolean;
  continueCursor: string;
  splitCursor: string | null;
  pageStatus: "SplitRecommended" | "SplitRequired" | null;
  rowsRead: number;
  estimatedBytes: number;
};
