import { v } from "convex/values";
import { internalAction } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { fetchReportRows } from "../../analytics/run";
import { queryWatermark } from "../../analytics/clickhouse";
import { assistantDefinition } from "./catalog";
export const run = internalAction({
    args: { requestId: v.id("mcpReportRequests"), runToken: v.string() }, returns: v.null(),
    handler: async (ctx, args) => {
        const admitted = await ctx.runMutation(internal.mcp.reports.admission.begin, args);
        if (!admitted)
            return null;
        try {
            const { job, tenantId } = admitted;
            const watermark = await queryWatermark();
            if (watermark === null)
                throw new Error("waiting_for_first_sync");
            const definition = assistantDefinition(job.report);
            let rawJson: string;
            if (definition.node) {
                rawJson = await ctx.runAction(internal.analytics.runNode.previewInNode, { tenantId, reportId: job.report, filtersJson: job.filtersJson, range: job.window });
            } else {
                const rowsJson = await fetchReportRows(assistantDefinition(job.report), { tenantId, filters: JSON.parse(job.filtersJson), range: job.window });
                // Finalize through the same engine as the page.
                rawJson = await ctx.runQuery(internal.analytics.results.previewFinalize, { tenantId, reportId: job.report, filtersJson: job.filtersJson, range: job.window, rowsJson });
            }
            const resultJson = rawJson;
            await ctx.runMutation(internal.mcp.reports.admission.finish, { ...args, resultJson, watermark });
        }
        catch {
            await ctx.runMutation(internal.mcp.reports.admission.finish, { ...args, error: "warehouse_failed" });
        }
        return null;
    },
});
