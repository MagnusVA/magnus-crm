import type { QueryCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import type { AnalyticsFilters } from "../../analytics/definition";
import type { ResolvedAnalyticsRange } from "../../../lib/analyticsRange";
import { readMcpGetRevenueMetrics, readMcpGetRevenueDetails } from "../../reporting/revenue";
import { readMcpGetRevenueTrend } from "../../reporting/revenueTrend";
import { readMcpGetBookedVsSoldMatrix } from "../../reporting/bookedVsSold";
import { readMcpGetTeamPerformanceMetrics, readMcpGetTeamOperationsDimensions } from "../../reporting/teamPerformance";
import { readMcpGetTeamOutcomeMix } from "../../reporting/teamOutcomes";
import { readMcpGetActionsPerCloserPerDay } from "../../reporting/teamActions";
import { readMcpGetPipelineDistribution, readMcpGetPipelineAging, readMcpGetPipelineBacklogAndLoss, readMcpGetSchedulingShowRateByOperationsDimensions } from "../../reporting/pipelineHealth";
import { readMcpGetLeadConversionMetrics } from "../../reporting/leadConversion";
import { readMcpGetFormResponseKpis, readMcpGetAnswerDistribution } from "../../reporting/formResponseAnalytics";
import { readMcpGetReminderOutcomeFunnel } from "../../reporting/remindersReporting";
import { readMcpGetQualificationReport } from "../../reporting/slackQualifications";
import { addBusinessDays } from "../../../lib/businessDay";
import { assistantDefinition } from "./catalog";
import { readLiveNumbers } from "./metrics";
import { readOperationsPanel, readGoals } from "./operations";
import { readLeadGenPanel } from "./leadGen";
/** Typed adapters use the same load path and builders as each public page reader.
 * Tenant identity has already passed requireMcpAdmin; no synthetic web session.
 */
export async function readLivePanel(ctx: QueryCtx, tenantId: Id<"tenants">, id: string, filters: AnalyticsFilters, range: ResolvedAnalyticsRange): Promise<unknown> {
    if (id === "mcp.metrics")
        return readLiveNumbers(ctx, tenantId, filters, range);
    if (id === "goals.assembly")
        return readGoals(ctx, tenantId);
    if (id.startsWith("lead_gen."))
        return readLeadGenPanel(ctx, tenantId, id, filters, range);
    if (id === "qualifications.dashboard" || id === "booked_calls.dashboard")
        return readOperationsPanel(ctx, tenantId, id, range);
    if (id === "pipeline.distribution")
        return readMcpGetPipelineDistribution(ctx, tenantId, {});
    if (id === "pipeline.aging")
        return readMcpGetPipelineAging(ctx, tenantId, {});
    const a = assistantDefinition(id).live.args({ tenantId, filters, range });
    const dates = { startDate: range.fromMs, endDate: range.toMs };
    const payment = { ...dates, ...(filters.programId ? { programId: filters.programId as Id<"tenantPrograms"> } : {}) };
    const dimensions = { startDayKey: range.startDate, endDayKeyExclusive: addBusinessDays(range.endDateInclusive, 1), ...(filters.bookingProgramId ? { bookingProgramId: filters.bookingProgramId as Id<"tenantPrograms"> } : {}), ...(filters.attributionTeamId ? { attributionTeamId: filters.attributionTeamId as Id<"attributionTeams"> } : {}) };
    switch (id) {
        case "revenue.metrics": return readMcpGetRevenueMetrics(ctx, tenantId, payment);
        case "revenue.details": return readMcpGetRevenueDetails(ctx, tenantId, payment);
        case "revenue.trend": return readMcpGetRevenueTrend(ctx, tenantId, { ...payment, granularity: (filters.granularity ?? "day") as "day" | "week" | "month" });
        case "revenue.booked_vs_sold": return readMcpGetBookedVsSoldMatrix(ctx, tenantId, { ...dates, ...(payment.programId ? { paymentProgramId: payment.programId } : {}) });
        case "team.metrics": return readMcpGetTeamPerformanceMetrics(ctx, tenantId, dates);
        case "team.operations": return readMcpGetTeamOperationsDimensions(ctx, tenantId, dimensions);
        case "team.outcomes": return readMcpGetTeamOutcomeMix(ctx, tenantId, dates);
        case "team.actions": return readMcpGetActionsPerCloserPerDay(ctx, tenantId, dates);
        case "pipeline.backlog_and_loss": return readMcpGetPipelineBacklogAndLoss(ctx, tenantId, dates);
        case "pipeline.show_rate": return readMcpGetSchedulingShowRateByOperationsDimensions(ctx, tenantId, dimensions);
        case "leads.conversion_metrics": return readMcpGetLeadConversionMetrics(ctx, tenantId, dates);
        case "leads.form_kpis": return readMcpGetFormResponseKpis(ctx, tenantId, dates);
        case "leads.answer_distribution": return readMcpGetAnswerDistribution(ctx, tenantId, { ...dates, fieldKey: String(a.fieldKey) });
        case "reminders.funnel": return readMcpGetReminderOutcomeFunnel(ctx, tenantId, payment);
        case "slack_qualifications.report": return readMcpGetQualificationReport(ctx, tenantId, { startBusinessDate: range.startDate, endBusinessDateExclusive: addBusinessDays(range.endDateInclusive, 1), granularity: "day" });
        default: throw new Error("Unsupported report panel.");
    }
}
