import type { QueryCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import { API_METRICS, assistantLiveFacts, assistantSqlFacts, assembleMetrics, parseApiMetricsFilters, metricsSql } from "../../analytics/api/metrics";
import type { AnalyticsFilters, AnyReportDefinition } from "../../analytics/definition";
import type { ApiMetricsAnswer } from "../../analytics/api/metrics";
import type { SqlRow } from "../../analytics/clickhouse";
import type { ResolvedAnalyticsRange } from "../../../lib/analyticsRange";
import type { MetricRow } from "../../../lib/assistantReportMerge";
export const ASSISTANT_METRICS = [...API_METRICS, "final_cash"] as const;
export type AssistantMetric = typeof ASSISTANT_METRICS[number];
export const metricPage = (metric: string) => ["leads_captured", "unique_prospects", "resparks"].includes(metric) ? "lead_gen" : ["qualifications", "new_qualified_people"].includes(metric) ? "qualifications" : ["calls_booked", "calls_scheduled", "calls_held", "no_shows", "cancellations", "show_rate", "close_rate", "deals_won"].includes(metric) ? "team" : "revenue";
export const METRIC_DEFINITIONS: Record<AssistantMetric, string> = {
    leads_captured: "Non-voided lead capture submissions by submission time.", unique_prospects: "Distinct prospect IDs captured in the window; distinct across the whole window.",
    resparks: "Respark batch items worked with result resparked.", qualifications: "Slack qualification events by submission time.", new_qualified_people: "Qualification events that created an opportunity.",
    calls_booked: "Meetings by creation time.", calls_scheduled: "Non-canceled meetings by scheduled time.", calls_held: "Held meetings by scheduled time.", no_shows: "No-show meetings by scheduled time.", cancellations: "Canceled meetings by scheduled time.",
    show_rate: "Held ÷ (held + no-show), a fraction. Differences use percentage points.", deals_won: "Won deals by their first payment received time.", close_rate: "First-held-call cohort: deals first held in the window, won as of the source watermark ÷ cohort deals. Attributed to that first call's closer and program.",
    cash_collected: "All non-disputed payment rows, including deposits, in minor units per currency.", final_cash: "Non-disputed non-deposit payment rows, in minor units per currency.", deposits: "Non-disputed deposit payment rows, in minor units per currency, separate from final_cash.",
    average_deal_size: "Final cash ÷ non-deposit payment row count, per currency. Counts payment rows, not distinct deals.",
};
export function apiFilters(raw: AnalyticsFilters) {
    return parseApiMetricsFilters({ ...raw, metrics: String(raw.metrics).split(",").flatMap(m => m === "final_cash" ? ["cash_collected", "deposits"] : [m]).join(",") });
}
function fromFacts(facts: ReturnType<typeof assistantSqlFacts>, requested: string): MetricRow[] {
    const metrics = requested.split(",") as AssistantMetric[];
    const normal = assembleMetrics(facts, metrics.filter((m): m is typeof API_METRICS[number] => m !== "final_cash"));
    const rows: MetricRow[] = normal.map(r => ({ id: r.metric, value: r.value, unit: ["show_rate", "close_rate"].includes(r.metric) ? "ratio" : ["cash_collected", "deposits", "average_deal_size"].includes(r.metric) ? "minor" : "count", period: r.period, group: r.group_id, ...(r.currency ? { currency: r.currency } : {}) }));
    if (metrics.includes("final_cash"))
        for (const fact of facts.filter(f => f.metric === "final_cash"))
            rows.push({ id: "final_cash", value: fact.value, unit: "minor", currency: fact.currency ?? "unknown", period: fact.period, group: fact.groupId });
    return rows;
}
export async function readLiveNumbers(ctx: QueryCtx, tenantId: Id<"tenants">, filters: AnalyticsFilters, range: ResolvedAnalyticsRange) {
    const result = await assistantLiveFacts(ctx, tenantId, apiFilters(filters), { fromMs: range.fromMs, toMs: range.toMs, day: { timeZone: range.timeZone, dayStartHour: range.dayStartHour } });
    return { rows: fromFacts(result.facts, String(filters.metrics)), partial: result.partial };
}
/** Uses the API's exact SQL and facts, with final_cash exposed separately. */
export const numbersDefinition: AnyReportDefinition = {
    id: "mcp.metrics", page: null, roles: ["tenant_admin", "tenant_master"], day: "business",
    parseFilters: async (_ctx, raw) => { apiFilters(raw); return raw; },
    sql: input => metricsSql(apiFilters(input.filters), input.range),
    finalize: async (_ctx, input) => ({ rows: fromFacts(assistantSqlFacts(input.rows as Record<string, SqlRow[]>), String(input.filters.metrics)), partial: false }),
    live: { name: "", args: () => ({}) },
};
/** Convert the API finalizer's currency-preserving output; subtraction is
 * legitimate because both sums came from the same complete payment source. */
export function assistantApiAnswer(answer: ApiMetricsAnswer, requested: string) {
    const wanted = requested.split(",");
    const rows: MetricRow[] = answer.rows.filter(r => wanted.includes(r.metric)).map(r => ({ id: r.metric, value: r.value, unit: ["show_rate", "close_rate"].includes(r.metric) ? "ratio" : ["cash_collected", "deposits", "average_deal_size"].includes(r.metric) ? "minor" : "count", period: r.period, group: r.group_id, ...(r.currency ? { currency: r.currency } : {}) }));
    if (wanted.includes("final_cash"))
        for (const cash of answer.rows.filter(r => r.metric === "cash_collected")) {
            const deposit = answer.rows.find(r => r.metric === "deposits" && r.currency === cash.currency && r.period === cash.period && r.group_id === cash.group_id);
            rows.push({ id: "final_cash", value: answer.partial || cash.value === null || deposit?.value === null || deposit === undefined ? null : cash.value - deposit.value, unit: "minor", currency: cash.currency, period: cash.period, group: cash.group_id, ...(answer.partial ? { nullReason: "incomplete_input" } : {}) });
        }
    return { rows, partial: answer.partial };
}
