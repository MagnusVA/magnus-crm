import { sectionDefinitions } from "./presentation";
import { formatCell, type ReportColumn } from "./document";
import type { ScalarRecord } from "../../convex/operations/reports/contracts";

export function summaryCards(kind: string, fields: ScalarRecord) {
  const keys: Record<string, ReportColumn[]> = {
    "lead-gen": [
      { key: "submissions", label: "Submissions" },
      { key: "scheduledHours", label: "Scheduled Hours", format: "decimal" },
      { key: "leadsPerHour", label: "Leads/Hr", format: "decimal" },
    ],
    qualifications: sectionDefinitions.qualifications_summary.columns,
    "booked-calls": sectionDefinitions.booked_calls_summary.columns,
    "sales-calls": [
      { key: "totalCalls", label: "Calls" },
      { key: "showed", label: "Showed" },
      { key: "canceled", label: "Canceled" },
      { key: "noShows", label: "No Shows" },
      { key: "showUpRate", label: "Show-up Rate", format: "percent" },
    ],
  };
  return (keys[kind] ?? []).map((column) => ({
    label: column.label,
    value: formatCell(fields[column.key], column.format),
  }));
}
