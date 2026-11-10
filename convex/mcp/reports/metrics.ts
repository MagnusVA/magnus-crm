import { ReportRequestError } from "../../../lib/assistantReportPlan";
import type { ToolRequest } from "./contracts";
import type { MetricRow } from "../../../lib/assistantReportMerge";
import { termHelp, type ReportTermKey } from "../../../lib/reporting/definitions";
import { pageCurrency, type PageAnswers } from "../../../lib/reporting/pageFigures/panels";
import { callsFigures, attendanceRates } from "../../../lib/reporting/pageFigures/calls";
import { cashFigures, followThroughFigures } from "../../../lib/reporting/pageFigures/scorecard";
import { closerPageFigures, rolePageFigures, totalCloserRow } from "../../../lib/reporting/pageFigures/people";
import { laneViews } from "../../../lib/reporting/pageFigures/attribution";
import type { CallsSummary } from "../../reports/calls";
import type { CashOutput, FunnelOutput, FollowThroughOutput } from "../../reports/scorecard";
import type { PeopleClosers } from "../../reports/people";
import type { PeopleRoleReport } from "../../reports/peopleRoles";
import type { AttributionLanes } from "../../reports/attribution";
import type { ReaderOutput } from "../../analytics/definition";
import type { getOverview } from "../../leadGen/reporting";
import type { listResparkPerformance } from "../../leadGen/resparkReports";
import type { getQualificationsDashboard } from "../../operations/qualificationsDashboard";

export const ASSISTANT_METRICS = ["callsScheduled", "bookingsMade", "rebooked", "moved", "canceled", "callsDue", "notRecorded", "showRate", "recorded", "showRateFloor", "firstCallShowRate", "timeToRecord", "closeRate", "dealsWon", "cash", "finalCash", "cashPerWonDeal", "creditedCash", "shared", "attributionCoverage", "perScheduledHour", "bookRate", "tasksOnTime", "captures", "qualificationEvents", "resparks", "prospectDays"] as const;
export type AssistantMetric = typeof ASSISTANT_METRICS[number];
type Request = Extract<ToolRequest, { kind: "numbers" }>;
const operations = { captures: "Operations capture submissions, excluding voided captures.", qualificationEvents: "Operations Slack qualification events by submission time.", resparks: "Operations respark results worked in range.", prospectDays: "Operations distinct prospect-days, summed from daily buckets; a person captured on two days counts twice." };
export const METRIC_DEFINITIONS = Object.fromEntries(ASSISTANT_METRICS.map(id => [id, id in operations ? operations[id as keyof typeof operations] : termHelp(id as ReportTermKey)])) as Record<AssistantMetric, string>;
const CALLS = new Set(["callsScheduled", "rebooked", "moved", "canceled", "callsDue", "notRecorded", "showRate", "recorded", "showRateFloor", "firstCallShowRate", "timeToRecord"]);
const CLOSER_GROUP = new Set(["callsDue", "notRecorded", "showRate", "recorded", "timeToRecord", "closeRate", "cash", "finalCash", "dealsWon", "tasksOnTime", "creditedCash"]);
const DAY = new Set(["bookingsMade", "dealsWon", "cash", "finalCash", "callsDue", "notRecorded", "moved", "canceled", "showRate", "recorded", "showRateFloor"]);
const MONEY = new Set(["cash", "finalCash", "cashPerWonDeal", "creditedCash", "shared"]);
const RATIOS = new Set(["showRate", "recorded", "showRateFloor", "firstCallShowRate", "closeRate", "attributionCoverage", "bookRate", "tasksOnTime"]);
export function creditRole(role: Request["role"]) { return role === "closers" ? "closer" : role === "setters" ? "setter" : role === "dm_closers" ? "dm_closer" : role; }
export function metricPanels(metric: AssistantMetric, request: Request): string[] {
  if (request.groupBy === "closer" && CLOSER_GROUP.has(metric) && metric !== "tasksOnTime") return ["people.closers"];
  if (metric === "dealsWon") return [request.scope === "sold_program" || request.groupBy === "program" ? "scorecard.cash" : request.scope === "first_payment_closer" ? "people.closers" : "scorecard.funnel"];
  if (CALLS.has(metric)) return ["calls.summary"];
  if (metric === "bookingsMade") return ["scorecard.funnel"];
  if (["cash", "finalCash", "cashPerWonDeal"].includes(metric)) return request.groupBy === "day" ? ["scorecard.funnel"] : ["scorecard.cash"];
  if (metric === "tasksOnTime") return ["scorecard.follow_through"];
  if (metric === "creditedCash" && !request.memberId) return ["attribution.lanes"];
  if (["creditedCash", "perScheduledHour", "bookRate"].includes(metric)) {
    const role = creditRole(request.role) ?? "setter";
    return [role === "closer" ? "people.closers" : role === "setter" ? "people.setters" : role === "dm_closer" ? "people.dm_closers" : "people.lead_gen"];
  }
  if (["shared", "attributionCoverage"].includes(metric)) return ["attribution.lanes"];
  if (metric === "closeRate") return ["people.closers"];
  if (metric === "qualificationEvents") return ["qualifications.dashboard"];
  if (metric === "resparks") return ["lead_gen.respark_performance"];
  return ["lead_gen.overview"];
}
export function validateNumbers(request: Request) {
  if (!request.metrics.length || request.metrics.length > ASSISTANT_METRICS.length) throw new ReportRequestError(`Choose 1 to ${ASSISTANT_METRICS.length} page terms.`);
  const role = creditRole(request.role);
  if (request.metrics.includes("dealsWon") && request.scope && request.groupBy === "closer" && request.scope !== "first_payment_closer") throw new ReportRequestError("groupBy closer supports dealsWon only with scope first_payment_closer.");
  if (request.groupBy === "team") throw new ReportRequestError("groupBy team is not supported by these page panels. Choose closer, program, or a supported day series.");
  for (const metric of request.metrics) {
    if (["creditedCash", "shared", "attributionCoverage", "perScheduledHour"].includes(metric) && (!role || role === "everyone")) throw new ReportRequestError(`${metric} needs a role.`);
    if (metric === "creditedCash" && role === "dm_team" && request.memberId) throw new ReportRequestError("DM team credited cash is shown on Attribution, not on a member row. Choose a member role for this scalar.");
    if (metric === "bookRate" && role && role !== "setter") throw new ReportRequestError("bookRate is the setter page's qualification cohort.");
    if (metric === "perScheduledHour" && !["setter", "dm_closer", "lead_gen"].includes(role ?? "")) throw new ReportRequestError("perScheduledHour supports setters, dm_closers and lead_gen.");
    if (["perScheduledHour", "bookRate"].includes(metric) && !request.memberId) throw new ReportRequestError(`${metric} is a person's page figure. Choose memberId.`);
    if (request.groupBy === "closer" && (!CLOSER_GROUP.has(metric) || request.memberId || metric === "creditedCash" && role !== "closer" || request.programId || request.closerId)) throw new ReportRequestError(`${metric} cannot group by closer with these filters using the page builder.`);
    if (request.groupBy === "program" && (!["cash", "finalCash", "dealsWon"].includes(metric) || metric === "dealsWon" && request.scope && request.scope !== "sold_program")) throw new ReportRequestError(`${metric} cannot group by program. The Cash page supports cash, finalCash and dealsWon with scope sold_program.`);
    if (request.groupBy === "day" && (!DAY.has(metric) || metric === "dealsWon" && request.scope && request.scope !== "booked_program_activity")) throw new ReportRequestError(`${metric} has no matching by-day series on the page.`);
    const panels = metricPanels(metric, request);
    if (request.programId && panels.some(p => !p.startsWith("scorecard.") && !p.startsWith("calls."))) throw new ReportRequestError(`${metric} has no program filter on its page.`);
    if (request.closerId && panels.some(p => !p.startsWith("calls."))) throw new ReportRequestError(`${metric} has no closer filter on its page. Use groupBy closer or memberId where supported.`);
    if (request.memberId && panels.some(p => !p.startsWith("people."))) throw new ReportRequestError(`${metric} has no member filter on its page.`);
  }
}

/** Scalar extraction happens only after the page has merged its source answers. */
/** One unit per term, whether or not its input was complete. */
const unitOf = (id: AssistantMetric): MetricRow["unit"] => MONEY.has(id) ? "minor" : RATIOS.has(id) ? "ratio" : id === "timeToRecord" ? "minutes" : id === "perScheduledHour" ? "per_hour" : "count";

/**
 * `currencyAnswers` picks each page's currency: the current period's answers,
 * so a comparison period reads the same currency instead of choosing its own.
 */
export function projectNumbers(answers: PageAnswers, request: Request, currencyAnswers: PageAnswers = answers): MetricRow[] {
  const rows: MetricRow[] = [];
  const put = (id: AssistantMetric, value: number | null, group: string | null = null, period = "total", currency?: string, scope?: string) => rows.push({ id, value, unit: unitOf(id), group, period, ...(currency ? { currency } : {}), ...(scope ? { scope } : {}), ...(value === null ? { nullReason: "no_denominator" } : {}) });
  for (const metric of [...new Set(request.metrics)]) {
    const panel = metricPanels(metric, request)[0];
    const data = answers.get(panel);
    const currency = pageCurrency(currencyAnswers, panel.split(".")[0], request.currency);
    const scope = metric === "dealsWon" ? request.groupBy === "program" ? "sold_program" : request.scope ?? "booked_program_activity" : undefined;
    if (!data) { rows.push({ id: metric, value: null, unit: unitOf(metric), group: null, period: "total", ...(MONEY.has(metric) ? { currency } : {}), nullReason: "incomplete_input" }); continue; }
    if (request.groupBy === "closer" && panel === "people.closers") {
      for (const r of (data as PeopleClosers).rows) put(metric, closerPageFigures(r, currency)[metric as keyof ReturnType<typeof closerPageFigures>] ?? null, r.userId, "total", MONEY.has(metric) ? currency : undefined, metric === "dealsWon" ? "first_payment_closer" : undefined);
    } else if (request.groupBy === "program") {
      const entry = (data as CashOutput).currencies.find(c => c.currency === currency);
      for (const r of entry?.byProgram ?? []) put(metric, metric === "cash" ? r.cashMinor : metric === "finalCash" ? r.finalMinor : r.dealsWon, r.programId, "total", MONEY.has(metric) ? currency : undefined, scope);
    } else if (request.groupBy === "day") {
      if (panel === "calls.summary") for (const r of (data as CallsSummary).byDay) {
        const rates = attendanceRates(r), due = rates.due;
        const v: Record<string, number | null> = { moved: r.moved, canceled: r.canceled, notRecorded: r.notRecorded, callsDue: due, showRate: rates.showRate, recorded: rates.recordedRate, showRateFloor: due > 0 ? r.held / due : null };
        put(metric, v[metric], null, r.dayKey);
      } else for (const r of (data as FunnelOutput).byDay) put(metric, metric === "cash" ? r.cash.find(c => c.currency === currency)?.cashMinor ?? 0 : metric === "finalCash" ? r.cash.find(c => c.currency === currency)?.finalMinor ?? 0 : metric === "bookingsMade" ? r.bookingsMade : r.dealsWon, null, r.dayKey, MONEY.has(metric) ? currency : undefined, scope);
    } else if (panel === "calls.summary") put(metric, callsFigures(data as CallsSummary)[metric as keyof ReturnType<typeof callsFigures>] as number | null);
    else if (panel === "scorecard.funnel") put(metric, (data as FunnelOutput).activity[metric as "bookingsMade" | "dealsWon"], null, "total", undefined, scope);
    else if (panel === "scorecard.cash") put(metric, cashFigures(data as CashOutput, currency)[metric as "cash" | "finalCash" | "cashPerWonDeal" | "dealsWon"], null, "total", MONEY.has(metric) ? currency : undefined, scope);
    else if (panel === "scorecard.follow_through") {
      const r = data as FollowThroughOutput;
      const figures = followThroughFigures(r);
      if (request.groupBy === "closer") for (const c of figures.byCloser) put(metric, c.tasksOnTime, c.userId);
      else put(metric, figures.tasksOnTime);
    } else if (panel === "people.closers") {
      const report = data as PeopleClosers;
      const total = request.memberId ? report.rows.find(r => r.teamMemberId === request.memberId) : totalCloserRow(report.rows, currency);
      put(metric, total ? closerPageFigures(total, currency)[metric as keyof ReturnType<typeof closerPageFigures>] : null, null, "total", MONEY.has(metric) ? currency : undefined, metric === "dealsWon" ? "first_payment_closer" : undefined);
    } else if (panel.startsWith("people.")) {
      const report = data as PeopleRoleReport;
      const r = report.rows.find(r => r.teamMemberId === request.memberId);
      if (!r && !report.isTruncated) throw new ReportRequestError(`The member has no row in the ${report.role} role panel.`);
      put(metric, r ? rolePageFigures(report.role, r, currency)[metric as "creditedCash" | "perScheduledHour" | "bookRate"] ?? null : null, null, "total", MONEY.has(metric) ? currency : undefined);
    } else if (panel === "attribution.lanes") {
      const view = laneViews(data as AttributionLanes, currency).find(v => v.role === creditRole(request.role));
      put(metric, view ? metric === "creditedCash" ? view.laneMinor : metric === "shared" ? view.sharedMinor : view.coverage : null, null, "total", MONEY.has(metric) ? currency : undefined, metric === "creditedCash" ? "role_lane" : undefined);
    } else if (panel === "qualifications.dashboard") put(metric, (data as ReaderOutput<typeof getQualificationsDashboard>).totalQualified);
    else if (panel === "lead_gen.respark_performance") put(metric, (data as ReaderOutput<typeof listResparkPerformance>).rows.reduce((s, r) => s + r.resparks, 0));
    else { const r = data as ReaderOutput<typeof getOverview>; put(metric, metric === "captures" ? r.submissions : r.uniqueProspects); }
  }
  return rows;
}
