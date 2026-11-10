import type { Doc } from "../_generated/dataModel";
import { shiftLabel } from "./eodMessage";

/** Plain-text blocks prevent mentions, links and formatting in dictated text. */
export function buildLeadGenShiftMessage(report: Doc<"leadGenShiftReports">, workerName: string) {
  const n = report.numbers;
  const text = [
    `${workerName} · End of shift · ${report.dayKey}`,
    shiftLabel(report.periodStart, report.periodEnd, report.timeZone),
    `Raw leads ${n.rawLeads} · Resparks ${n.resparks} · Entries ${n.entries} · Not a fit ${n.notAFit}`,
    `Scheduled hours ${n.scheduledHours ?? "unknown"} · Leads per scheduled hour ${n.leadsPerHour === null ? "not available" : n.leadsPerHour.toFixed(2)}`,
    ...(report.hoursStatus === "unknown" ? ["Magnus couldn't read the schedule in full. Hours and the hourly rate are unknown."] : []),
    ...(report.narrative ? [report.narrative] : []),
    ...(report.note ? [`Team note: ${report.note}`] : []),
    "Numbers from Magnus. Text confirmed by the lead generator.",
  ].join("\n\n");
  // Fallback text can otherwise notify mentions even with plain-text blocks.
  const fallback = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return { text: fallback, mrkdwn: false, parse: "none", link_names: false,
    blocks: [{ type: "section", text: { type: "plain_text", text, emoji: false } }] };
}
