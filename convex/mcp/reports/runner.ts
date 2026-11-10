import { v } from "convex/values";
import { internalAction } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { fetchReportRows } from "../../analytics/run";
import { queryWatermark } from "../../analytics/clickhouse";
import { assistantDefinition } from "./catalog";
import { reportError } from "../../lib/observability/log";
import { ANSWER_TOO_LARGE } from "../../analytics/results";
import { storeAnswerParts } from "./payloads";
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
            let parts: number;
            if (definition.node) {
                // Built and stored in Node; only the part count comes back.
                parts = await ctx.runAction(internal.analytics.runNode.storeAssistantAnswer, { requestId: args.requestId, runToken: args.runToken, tenantId, reportId: job.report, filtersJson: job.filtersJson, range: job.window });
            } else {
                const rowsJson = await fetchReportRows(assistantDefinition(job.report), { tenantId, filters: JSON.parse(job.filtersJson), range: job.window });
                // Finalize through the same engine as the page.
                const rawJson = await ctx.runQuery(internal.analytics.results.previewFinalize, { tenantId, reportId: job.report, filtersJson: job.filtersJson, range: job.window, rowsJson });
                parts = await storeAnswerParts(ctx, args, rawJson);
            }
            await ctx.runMutation(internal.mcp.reports.admission.finish, { ...args, parts, watermark });
        }
        catch (error) {
            // The agent sees a code; the cause goes to the logs, as the web runner does.
            const message = error instanceof Error ? error.message : String(error);
            const waiting = message === "waiting_for_first_sync";
            // Over the rows budget or the answer cap: the agent should choose a shorter range.
            const tooLarge = message.includes(ANSWER_TOO_LARGE);
            if (!waiting && !tooLarge)
                reportError("mcp.report_failed", error, { reportId: admitted.job.report, tenantId: admitted.tenantId, fingerprint: `mcp.report_failed:${admitted.job.report}` });
            await ctx.runMutation(internal.mcp.reports.admission.finish, { ...args, error: waiting ? "waiting_for_first_sync" : tooLarge ? "range_too_large" : "warehouse_failed" });
        }
        return null;
    },
});
