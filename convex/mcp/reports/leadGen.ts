import type { QueryCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import type { AnalyticsFilters } from "../../analytics/definition";
import type { ResolvedAnalyticsRange } from "../../../lib/analyticsRange";
import { readGetOverview, readListWorkerPerformance, readListTeamPerformance, readListSourcePerformance, readListTopOriginsByTeam } from "./leadGenReader";
import { readListProspectConversions } from "./conversionReader";
import { readListResparkPerformance } from "./resparkReader";
export async function readLeadGenPanel(ctx: QueryCtx, tenantId: Id<"tenants">, id: string, filters: AnalyticsFilters, range: ResolvedAnalyticsRange): Promise<unknown> {
    const args = { startDayKey: range.startDate, endDayKey: range.endDateInclusive, ...(filters.teamId ? { teamId: filters.teamId as Id<"attributionTeams"> } : {}) };
    switch (id) {
        case "lead_gen.overview": return readGetOverview(ctx, tenantId, args);
        case "lead_gen.workers": return readListWorkerPerformance(ctx, tenantId, args);
        case "lead_gen.teams": return readListTeamPerformance(ctx, tenantId, args);
        case "lead_gen.sources": return readListSourcePerformance(ctx, tenantId, args);
        case "lead_gen.top_origins_by_team": return readListTopOriginsByTeam(ctx, tenantId, { ...args, limitPerTeam: 10 });
        case "lead_gen.prospect_conversions": return readListProspectConversions(ctx, tenantId, args);
        case "lead_gen.respark_performance": return readListResparkPerformance(ctx, tenantId, args);
        default: throw new Error("Unsupported lead gen panel.");
    }
}
