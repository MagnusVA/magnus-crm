import type { ReportKind, ReportFormat } from "../../convex/operations/reports/contracts";
import type { ReportColumn } from "./document";

const col = (
  key: string,
  label: string,
  format?: ReportColumn["format"],
  currencyKey?: string,
): ReportColumn => ({
  key,
  label,
  ...(format ? { format } : {}),
  ...(currencyKey ? { currencyKey } : {}),
});
const storedMoney = (key: string, label: string) =>
  col(key, `${label} (stored hundredths)`, "number", "currency");
const hours = col("scheduledHours", "Scheduled Hours", "decimal");
const leads = [col("submissions", "Submissions", "number"), hours, col("leadsPerHour", "Leads/Hr", "decimal")];
const callPerformance = [col("booked", "Calls", "number"), col("showed", "Showed", "number"), col("canceled", "Canceled", "number"), col("noShows", "No Shows", "number"), col("showUpRate", "Show-up Rate", "percent")];
const paymentPerformance = [col("currency", "Currency"), col("paymentSales", "Sales", "number"), storedMoney("paymentRevenueMinor", "Revenue"), col("paymentCloseRate", "Close Rate", "percent"), storedMoney("avgPaymentDealMinor", "Avg Sale")];

export const reportTitles: Record<ReportKind, string> = {
  "lead-gen": "Lead Gen Performance", qualifications: "Qualifications Performance",
  "booked-calls": "Booked Calls Performance", "sales-calls": "Sales Calls Performance",
};

export const sectionDefinitions: Record<string, { title: string; columns: ReportColumn[] }> = {
  lead_gen_daily_summary: { title: "Daily Summary", columns: [col("dayKey", "Day"), col("workerLabel", "LeadGenSpecialist"), col("teamLabel", "Team"), col("source", "Source"), ...leads.slice(0, 2)] },
  lead_gen_worker: { title: "Specialist Performance", columns: [col("label", "Lead Gen Specialist"), col("email", "Email"), col("teamLabel", "Team"), ...leads] },
  lead_gen_team: { title: "Team Performance", columns: [col("label", "Team"), ...leads] },
  lead_gen_team_worker: { title: "Team Specialist Performance", columns: [col("teamLabel", "Team"), col("workerLabel", "Specialist"), ...leads] },
  lead_gen_source: { title: "Source Split", columns: [col("source", "Source"), ...leads] },
  lead_gen_origin: { title: "Posts and Reels", columns: [col("originValue", "Origin"), col("originKind", "Kind"), col("source", "Source"), col("uniqueProspects", "Unique Prospects", "number"), col("submissions", "Submissions", "number"), col("dayCount", "Days", "number")] },
  lead_gen_team_origin: { title: "Team Posts and Reels", columns: [col("teamLabel", "Team"), col("originValue", "Origin"), col("originKind", "Kind"), col("source", "Source"), col("uniqueProspects", "Unique Prospects", "number"), col("submissions", "Submissions", "number"), col("dayCount", "Days", "number")] },
  qualification_opener: { title: "Qualifier Performance", columns: [col("label", "Qualifier"), col("qualified", "Qualifications", "number"), hours, col("qualifiedPerHour", "Qualifications/Hr", "decimal"), col("lastEventAt", "Last Submission", "timestamp")] },
  qualifications_summary: { title: "Overall", columns: [col("totalQualified", "Qualifications", "number"), col("dailyQuota", "Daily Team Quota", "number"), col("target", "Team Goal", "number"), col("progress", "Progress", "number"), col("businessDayCount", "Days", "number")] },
  booked_closer: { title: "DM Closer Performance", columns: [col("label", "DM Closer"), col("teamLabel", "Team"), col("booked", "Bookings", "number"), hours, col("bookedPerHour", "Bookings/Hr", "decimal")] },
  booking_team: { title: "Team Goals", columns: [col("label", "Team"), col("progress", "Bookings", "number"), col("dailyQuota", "Daily Quota", "number"), col("target", "Team Goal", "number")] },
  booked_calls_summary: { title: "Overall", columns: [col("totalBooked", "Bookings", "number"), col("totalTarget", "Team Goals", "number"), col("businessDayCount", "Days", "number")] },
  sales_calls_summary: { title: "Overall calls", columns: [col("totalCalls", "Calls", "number"), col("showed", "Showed", "number"), col("canceled", "Canceled", "number"), col("noShows", "No Shows", "number"), col("showUpRate", "Show-up Rate", "percent")] },
  sales_summary_money: { title: "Overall payments by currency", columns: [col("currency", "Currency"), col("paymentSalesCount", "Sales", "number"), storedMoney("cashCollectedMinor", "Cash Collected"), col("closeRate", "Close Rate", "percent"), storedMoney("avgCashPerSaleMinor", "Avg Sale")] },
  sales_closer: { title: "Closer call performance", columns: [col("label", "Closer"), ...callPerformance] },
  sales_closer_money: { title: "Closer payment performance by currency", columns: [col("label", "Closer"), ...paymentPerformance] },
  sales_program: { title: "Program call performance", columns: [col("label", "Program"), ...callPerformance] },
  sales_program_money: { title: "Program payment performance by currency", columns: [col("label", "Program"), ...paymentPerformance.slice(0, 3)] },
  sales_reconciliation: { title: "Payment Attribution", columns: [col("currency", "Currency"), col("paymentSales", "Payments", "number"), storedMoney("paymentRevenueMinor", "Total"), col("attributedSales", "Attributed Payments", "number"), storedMoney("attributedRevenueMinor", "Attributed"), col("unattributedSales", "Unattributed Payments", "number"), storedMoney("unattributedRevenueMinor", "Unattributed")] },
  raw_submission: { title: "Raw Submissions", columns: [col("submittedAt", "SubmittedAt", "timestamp"), col("workerLabel", "Specialist"), col("workerEmail", "Email"), col("teamLabel", "Team"), col("normalizedHandle", "ProspectHandle"), col("rawHandle", "RawHandle"), col("profileUrl", "ProfileURL"), col("source", "Source"), col("originKind", "OriginKind"), col("originValue", "OriginValue"), col("voidedAt", "VoidedAt", "timestamp"), col("voidReason", "VoidReason"), col("submissionId", "SubmissionId"), col("prospectId", "ProspectId"), col("workerId", "WorkerId"), col("teamId", "TeamId")] },
  raw_qualification: { title: "Raw Qualifications", columns: [col("eventId", "EventId"), col("submittedAt", "SubmittedAt", "timestamp"), col("slackUserId", "SlackUserId"), col("slackTeamId", "SlackTeamId"), col("qualifierLabel", "Qualifier"), col("fullNameSnapshot", "ProspectName"), col("platform", "Platform"), col("handleSnapshot", "Handle"), col("leadId", "LeadId"), col("opportunityId", "OpportunityId"), col("resultKind", "ResultKind")] },
  raw_booking: { title: "Raw Bookings", columns: [col("meetingId", "MeetingId"), col("opportunityId", "OpportunityId"), col("leadId", "LeadId"), col("bookedAt", "BookedAt", "timestamp"), col("scheduledAt", "ScheduledAt", "timestamp"), col("meetingStatus", "MeetingStatus"), col("opportunityStatus", "OpportunityStatus"), col("bookingProgramName", "BookingProgram"), col("leadLabel", "Lead"), col("leadHandle", "Handle"), col("initialSource", "Source"), col("selfReportedIncome", "Income"), col("attributionTeamId", "TeamId"), col("attributionTeamLabel", "Team"), col("dmCloserId", "DmCloserId"), col("dmCloserLabel", "DmCloser")] },
  raw_call: { title: "Raw Calls", columns: [col("meetingId", "MeetingId"), col("opportunityId", "OpportunityId"), col("assignedCloserId", "CloserId"), col("scheduledAt", "ScheduledAt", "timestamp"), col("status", "Status"), col("bookingProgramId", "BookingProgramId"), col("bookingProgramName", "BookingProgram"), col("soldProgramId", "SoldProgramId"), col("soldProgramName", "SoldProgram"), col("leadId", "LeadId"), col("leadLabel", "Lead")] },
  raw_payment: { title: "Raw Payments", columns: [col("paymentId", "PaymentId"), col("recordedAt", "RecordedAt", "timestamp"), col("opportunityId", "OpportunityId"), storedMoney("amountMinor", "Amount"), col("currency", "Currency"), col("paymentType", "PaymentType"), col("programId", "ProgramId"), col("programName", "Program"), col("attributedCloserId", "AttributedCloserId")] },
};

export function exportSections(kind: ReportKind, format: ReportFormat): string[] {
  if (format === "payments_csv") return ["raw_payment"];
  if (format === "raw_csv") return [{ "lead-gen": "raw_submission", qualifications: "raw_qualification", "booked-calls": "raw_booking", "sales-calls": "raw_call" }[kind]];
  if (format === "summary_csv" && kind === "lead-gen") return ["lead_gen_daily_summary"];
  if (format === "xlsx" && kind === "lead-gen") return ["lead_gen_team_worker", "lead_gen_team_origin", "lead_gen_team"];
  return {
    "lead-gen": ["lead_gen_team", "lead_gen_worker", "lead_gen_source", "lead_gen_origin", "lead_gen_team_origin"],
    qualifications: ["qualifications_summary", "qualification_opener"],
    "booked-calls": ["booked_calls_summary", "booking_team", "booked_closer"],
    "sales-calls": ["sales_calls_summary", "sales_summary_money", "sales_closer", "sales_closer_money", "sales_program", "sales_program_money", "sales_reconciliation"],
  }[kind];
}

/** CSV retains stored integer hundredths; presentation files display each row's currency. */
export function exportSectionDefinition(section: string, format: ReportFormat) {
  const definition = sectionDefinitions[section];
  if (!definition || (format !== "xlsx" && format !== "pdf")) return definition;
  return {
    ...definition,
    columns: definition.columns.map((column): ReportColumn => column.currencyKey
      ? { ...column, label: column.label.replace(" (stored hundredths)", ""), format: "money" }
      : column),
  };
}
