import { getReportDefinition } from "../../analytics/registry";
import { numbersDefinition } from "./metrics";
export const assistantDefinition = (id: string) => id === "mcp.metrics" ? numbersDefinition : getReportDefinition(id);
export const REPORT_PANELS = {
    revenue: ["revenue.metrics", "revenue.details", "revenue.trend", "revenue.booked_vs_sold"],
    booked_vs_sold: ["revenue.booked_vs_sold"],
    team: ["team.metrics", "team.operations", "team.outcomes", "team.actions"],
    pipeline: ["pipeline.distribution", "pipeline.aging", "pipeline.backlog_and_loss", "pipeline.show_rate"],
    goals: ["goals.assembly"],
    leads: ["leads.conversion_metrics", "leads.form_kpis"],
    reminders: ["reminders.funnel"],
    qualifications: ["qualifications.dashboard"],
    lead_gen: ["lead_gen.overview", "lead_gen.workers", "lead_gen.top_origins_by_team", "lead_gen.prospect_conversions", "lead_gen.respark_performance"],
} as const;
export type ReportName = keyof typeof REPORT_PANELS;
export const reportPage = (id: string) => id.startsWith("goals.") ? "goals" : assistantDefinition(id).page ?? "revenue";
export const REPORT_DEFINITIONS: Record<ReportName, Record<string, string>> = {
    revenue: { finalRevenueMinor: "Non-deposit, non-disputed cash in minor units (final_cash).", depositRevenueMinor: "Deposit cash, separate from final_cash.", totalDeals: "Non-deposit payment rows, not distinct deals.", avgDealMinor: "Final cash divided by non-deposit payment rows; withheld without a currency.", byOrigin: "Final cash by payment origin.", byCloser: "Final payment rows attributed to active closers.", byProgram: "Final and deposit cash and payment-row counts by sold program.", trend: "Payment amounts and row counts by business date.", booked_vs_sold: "Payment rows by first booked program and sold program; minor-unit sums withheld without currency." },
    booked_vs_sold: { paymentCount: "Payment rows by first booked program and sold program.", totalAmountMinor: "Non-disputed cash, including deposits. Withheld without currency." },
    team: { calls: "Scheduled meetings in the business-day range, split into new and follow-up calls and attendance.", showRate: "Held divided by held plus no-show.", closeRate: "First-held-call cohort won deals divided by cohort deals, attributed to the first held call.", revenue: "Non-deposit payment rows, attributed to active closers. Currency-blended sums withheld.", sales: "Non-deposit payment row count.", outcomes: "Meeting outcomes derived from deal stage, payments and reschedules over the whole requested range.", actions: "Closer-source domain events; distinct actors and actions per actor per day are non-additive.", operations: "Meeting bucket counts. Page program/team filters narrow this panel only." },
    pipeline: { distribution: "Current open deals by stage, independent of range.", aging: "Current open-deal age, stale deals and stage velocity, independent of range.", backlog: "Current pending follow-ups, independent of range.", losses: "Person-recorded losses by lost time, excluding system losses.", showRate: "Held divided by held plus no-show over business days." },
    goals: { directory: "Current team membership, work schedules and daily team quotas.", qualifications: "Last 30 completed business days' qualification events and scheduled hours.", booked: "Last 30 completed business days' first-booking credits and scheduled hours. Goals count days anyone in the group works, or all days when no schedules exist." },
    leads: { newLeads: "People reaching Qualified in the range.", totalConversions: "Program enrollments created in the range.", conversionRate: "Conversions divided by new qualified leads.", avgMeetingsPerSale: "Meetings on converted deals divided by conversions with a winning deal.", avgTimeToConversionMs: "Mean time from first seen to enrollment, in milliseconds.", topAnswerPerField: "Top non-empty trimmed answer for each field. Source exposes only its top answer, so split rankings are withheld." },
    reminders: { created: "Manual reminders created in the range.", completed: "Those reminders completed.", completionRate: "Completed divided by created.", outcomeMix: "Completed reminders by recorded completion outcome.", chainLengthHistogram: "Distinct deals bucketed by reminder chain length. Non-additive across windows.", reminderDrivenFinalRevenueMinor: "Non-deposit payments logged from reminders; separate from reminderDrivenDepositRevenueMinor. Withheld without currency." },
    qualifications: { totalQualified: "Slack qualification events by submitted time.", qualifiedPerHour: "Qualification events divided by scheduled hours.", goal: "Daily quota multiplied by days at least one qualifier works; all days when none have schedules." },
    lead_gen: { submissions: "Non-voided capture submissions.", uniqueProspects: "Distinct prospect-days in daily buckets; never rebuilt from split answers.", leadsPerHour: "Submissions divided by scheduled hours.", origins: "Posts and reels ranked by prospect-day counts and submissions, as the page.", conversions: "Prospects first captured in range and the lifecycle stages subsequently reached; capture-credited deals.", resparks: "Respark results worked in range, plus respark-credit deals ever booked." },
};
