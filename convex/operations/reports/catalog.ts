import type { OperationsReportKind } from "./model";

export const REPORT_SOURCE_ORDER: Record<OperationsReportKind, readonly string[]> = {
  "lead-gen": [
    "lead_gen_sources",
    "lead_gen_workers",
    "teams",
    "lead_gen_worker_schedules",
    "lead_gen_daily",
    "lead_gen_origins",
    "lead_gen_team_origins",
    "lead_gen_submissions",
  ],
  qualifications: [
    "tenant",
    "slack_users",
    "qualifier_schedules",
    "qualification_events",
  ],
  "booked-calls": [
    "teams",
    "dm_closers",
    "dm_closer_schedules",
    "booked_meetings",
  ],
  "sales-calls": [
    "users",
    "programs",
    "sales_meeting_stats",
    "sales_calls",
    "sales_payments",
  ],
};

export const REPORT_FINALIZATION_ORDER: Record<
  OperationsReportKind,
  readonly string[]
> = {
  "lead-gen": [
    "lead_gen_summary",
    "lead_gen_daily_summary",
    "lead_gen_worker",
    "lead_gen_team",
    "lead_gen_source",
    "lead_gen_team_worker",
    "lead_gen_team_source",
    "lead_gen_origin",
    "lead_gen_team_origin",
    "raw_submission",
  ],
  qualifications: [
    "qualification_opener",
    "raw_qualification",
    "qualifications_summary",
  ],
  "booked-calls": [
    "booked_closer",
    "booking_team",
    "raw_booking",
    "booked_calls_summary",
  ],
  "sales-calls": [
    "sales_closer",
    "sales_closer_money",
    "sales_program",
    "sales_program_money",
    "sales_summary_money",
    "sales_reconciliation",
    "raw_call",
    "raw_payment",
    "sales_calls_summary",
  ],
};

export const REPORT_SECTION_DEPENDENCIES: Readonly<Record<string, readonly string[]>> = {
  lead_gen_summary: ["lead_gen_daily"],
  lead_gen_daily_summary: ["lead_gen_daily"],
  lead_gen_worker: ["lead_gen_worker_dimension", "lead_gen_daily"],
  lead_gen_team: ["team_dimension", "lead_gen_daily"],
  lead_gen_source: ["lead_gen_worker_schedules", "lead_gen_daily"],
  lead_gen_team_worker: ["team_dimension", "lead_gen_worker_dimension", "lead_gen_daily"],
  lead_gen_team_source: ["team_dimension", "lead_gen_daily"],
  lead_gen_origin: ["lead_gen_origins"],
  lead_gen_team_origin: ["teams", "lead_gen_team_origins"],
  raw_submission: ["lead_gen_submissions"],
  qualifications_summary: ["tenant", "qualification_events"],
  qualification_opener: ["slack_user_dimension", "qualifier_schedules", "qualification_events"],
  raw_qualification: ["qualification_events"],
  booked_calls_summary: ["booked_meetings", "teams"],
  booked_closer: ["dm_closer_dimension", "dm_closer_schedules", "booked_meetings"],
  booking_team: ["team_dimension", "booked_meetings"],
  raw_booking: ["booked_meetings"],
  sales_calls_summary: ["sales_meeting_stats"],
  sales_summary_money: ["sales_meeting_stats", "sales_payments"],
  sales_closer: ["user_dimension", "sales_meeting_stats"],
  sales_closer_money: ["user_dimension", "sales_meeting_stats", "sales_payments"],
  sales_program: ["program_dimension", "sales_meeting_stats"],
  sales_program_money: ["program_dimension", "sales_meeting_stats", "sales_payments"],
  sales_reconciliation: ["sales_payments"],
  raw_call: ["sales_calls"],
  raw_payment: ["sales_payments"],
};

export function getReportSourceOrder(args: {
  reportKind: OperationsReportKind;
  workerId?: string | null;
  teamId?: string | null;
}) {
  if (args.reportKind === "lead-gen" && (args.workerId || args.teamId)) {
    return REPORT_SOURCE_ORDER["lead-gen"]
      .filter(
        (source) =>
          source !== "lead_gen_origins" && source !== "lead_gen_team_origins",
      )
      .flatMap((source) =>
        source === "lead_gen_submissions"
          ? ["lead_gen_filtered_origin_submissions", source]
          : [source],
      );
  }
  return REPORT_SOURCE_ORDER[args.reportKind];
}
