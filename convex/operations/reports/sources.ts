import { REPORT_SOURCE_ORDER } from "./catalog";
import type { ReportKind, ReportFormat, ReportPurpose } from "./contracts";

export function sourcesForReport(job: {
  reportKind: ReportKind;
  purpose: ReportPurpose;
  format?: ReportFormat;
}) {
  const sources = REPORT_SOURCE_ORDER[job.reportKind];
  if (
    job.purpose === "dashboard" ||
    job.format === "pdf" ||
    job.format === "xlsx"
  ) {
    return sources.filter(
      (key) => key !== "lead_gen_submissions" && key !== "sales_calls",
    );
  }
  if (job.format === "summary_csv")
    return sources.filter(
      (key) => key !== "lead_gen_submissions" && key !== "sales_calls",
    );
  const keep: Record<ReportKind, string[]> = {
    "lead-gen": ["lead_gen_workers", "teams", "lead_gen_submissions"],
    qualifications: ["slack_users", "qualification_events"],
    "booked-calls": ["teams", "dm_closers", "booked_meetings"],
    "sales-calls": [
      "users",
      "programs",
      job.format === "payments_csv" ? "sales_payments" : "sales_calls",
    ],
  };
  return sources.filter((key) => keep[job.reportKind].includes(key));
}
