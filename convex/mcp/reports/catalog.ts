import { getReportDefinition } from "../../analytics/registry";
import { termHelp } from "../../../lib/reporting/definitions";
export const assistantDefinition = (id: string) => getReportDefinition(id);
export const REPORT_PANELS = {
    scorecard: ["scorecard.funnel", "scorecard.cash", "scorecard.follow_through", "scorecard.origins", "scorecard.answers"],
    calls: ["calls.summary"],
    people: ["people.members", "people.closers", "people.setters", "people.dm_closers", "people.lead_gen"],
    attribution: ["attribution.lanes", "attribution.paths"],
    pipeline: ["pipeline.now"],
    qualifications: ["qualifications.dashboard"],
    lead_gen: ["lead_gen.overview", "lead_gen.workers", "lead_gen.top_origins_by_team", "lead_gen.prospect_conversions", "lead_gen.respark_performance"],
} as const;
export type ReportName = keyof typeof REPORT_PANELS;
export const CURRENT_REPORT_PAGES = ["scorecard", "calls", "people", "attribution"] as const;
export const LIVE_PANELS = new Set(["pipeline.now", "people.members", "people.profile"]);
export const REPORT_DEFINITIONS: Record<ReportName, Record<string, string>> = {
    scorecard: { bookingsMade: termHelp("bookingsMade"), dealsWon: termHelp("dealsWon"), cash: termHelp("cash"), finalCash: termHelp("finalCash"), tasksOnTime: termHelp("tasksOnTime"), answers: "People answering a booking question, and how many held a call or bought. The default question matches the Scorecard picker; fieldKey chooses another." },
    calls: { scheduled: termHelp("callsScheduled"), due: termHelp("callsDue"), recorded: termHelp("recorded"), showRate: termHelp("showRate"), moved: termHelp("moved"), rebooked: termHelp("rebooked"), timeToRecord: termHelp("timeToRecord") },
    people: { closeRate: termHelp("closeRate"), creditedCash: termHelp("creditedCash"), perScheduledHour: termHelp("perScheduledHour"), bookRate: termHelp("bookRate") },
    attribution: { cash: termHelp("cash"), creditedCash: termHelp("creditedCash"), shared: termHelp("shared"), coverage: termHelp("attributionCoverage") },
    pipeline: { scope: "Current open deals, stage age, missing next steps, overdue tasks, owed call results and booking reviews. Independent of range." },
    qualifications: { totalQualified: "Slack qualification events by submitted time.", qualifiedPerHour: termHelp("perScheduledHour"), goal: "Daily quota multiplied by days at least one qualifier works; all days when none have schedules." },
    lead_gen: { submissions: "Non-voided capture submissions.", uniqueProspects: "Distinct prospect-days in daily buckets; never rebuilt from split answers.", leadsPerHour: termHelp("perScheduledHour"), origins: "Posts and reels ranked by prospect-day counts and submissions, as the Operations page.", conversions: "Prospects first captured in range and the lifecycle stages subsequently reached; capture-credited deals.", resparks: "Respark results worked in range, plus respark-credit deals ever booked." },
};
