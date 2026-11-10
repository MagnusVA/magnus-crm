import { v } from "convex/values";
import { internalAction, type ActionCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { mcpCallerValidator, type McpCaller } from "../guard";
import { appLink } from "../admin/prepare";
import { numbersArgs, reportArgs, ASSISTANT_COLD_WAIT_MS, type ToolRequest } from "./contracts";
import type { Prepared, JobAnswer } from "./planning";
import { incomplete, withholdIncomplete, safeText, boundPanel, capAnswer, type Json } from "./output";
import { mergeMetricWindows, boundMetricRows, metricDelta, NON_ADDITIVE, type MetricRow } from "../../../lib/assistantReportMerge";
import { addBusinessDays } from "../../../lib/businessDay";
import { mergeReportPanel } from "./merge";
import { REPORT_DEFINITIONS } from "./catalog";
import { gatewayAnswerBytes, MAX_ASSISTANT_ANSWER_BYTES } from "../../../lib/assistantReportMerge";
import { METRIC_DEFINITIONS } from "./metrics";
const rowKey = (r: MetricRow) => JSON.stringify([r.id, r.group, r.period, r.currency ?? null, r.label ?? null]);
type Loaded = {
    input: Prepared["inputs"][number];
    data: unknown;
    watermark: number | null;
};
export async function runReportTool(ctx: ActionCtx, caller: McpCaller, request: ToolRequest): Promise<Record<string, unknown>> {
    const started = Date.now();
    const prepared: Prepared = JSON.parse(await ctx.runQuery(internal.mcp.reports.planning.prepare, { caller, request }));
    const sourceKey = (i: Prepared["inputs"][number]) => JSON.stringify([i.window.engine, i.window.window.startDate, i.window.window.endDateInclusive, i.window.label, i.period]);
    const uniqueInputs = [...new Map(prepared.inputs.map(i => [sourceKey(i), i])).values()];
    const base = {
        resolvedRange: prepared.resolvedRange, businessDay: prepared.businessDay,
        sources: uniqueInputs.map(i => ({ engine: i.window.engine, window: i.window.window, watermark: null as number | null, label: i.window.label, period: i.period })),
        freshness: { liveAt: prepared.inputs.some(i => i.window.engine === "convex") ? started : null, warehouseAsOf: null as number | null },
        isPartial: false, reasons: [] as string[], openInMagnus: appLink(prepared.path),
        definitions: request.kind === "numbers" ? Object.fromEntries(request.metrics.map(m => [m, METRIC_DEFINITIONS[m]])) : REPORT_DEFINITIONS[request.report],
    };
    const pending = () => capAnswer({ ...base, status: "pending", retryAfterSeconds: 3 });
    const jobs = [...new Map(prepared.inputs.flatMap(i => i.job ? [[i.job.key, i.job] as const] : [])).values()];
    let answers: JobAnswer[] = [];
    if (jobs.length && !prepared.configured)
        return capAnswer({ ...base, status: "unavailable", isPartial: true, reasons: ["warehouse_not_configured"] });
    while (jobs.length) {
        answers = JSON.parse(await ctx.runQuery(internal.mcp.reports.planning.jobStates, { caller, jobs }));
        if (answers.some(a => a.status === "failed"))
            return capAnswer({ ...base, status: "failed", isPartial: true, reasons: [...new Set(answers.flatMap(a => a.reason ? [a.reason] : []))] });
        if (answers.every(a => a.status === "ready"))
            break;
        const needed = jobs.filter((_, i) => answers[i].status !== "ready");
        const admission = await ctx.runMutation(internal.mcp.reports.admission.admit, { caller, jobs: needed });
        if (admission.status === "unavailable")
            return capAnswer({ ...base, status: "unavailable", isPartial: true, reasons: [admission.reason ?? "admission_unavailable"] });
        const remaining = ASSISTANT_COLD_WAIT_MS - (Date.now() - started);
        if (remaining <= 0)
            return pending();
        await new Promise(resolve => setTimeout(resolve, Math.min(250, remaining)));
    }
    // Recheck access, day boundaries and sync after waiting, before reading live.
    const rechecked: Prepared = JSON.parse(await ctx.runQuery(internal.mcp.reports.planning.prepare, { caller, request }));
    if (JSON.stringify(rechecked.inputs) !== JSON.stringify(prepared.inputs) || rechecked.syncWatermark !== prepared.syncWatermark || rechecked.resolvedRange.startDate !== prepared.resolvedRange.startDate || rechecked.resolvedRange.endDateInclusive !== prepared.resolvedRange.endDateInclusive)
        return pending();
    const byKey = new Map(jobs.map((j, i) => [j.key, answers[i]]));
    const loaded: Loaded[] = [];
    for (let index = 0; index < prepared.inputs.length; index++) {
        const input = prepared.inputs[index];
        const answer = input.job ? byKey.get(input.job.key)! : null;
        let data: unknown;
        try {
            data = answer ? answer.data : JSON.parse(await ctx.runQuery(internal.mcp.reports.read.panel, { caller, id: input.id, filters: input.filters, range: input.window.window }));
        }
        catch {
            return capAnswer({ ...base, status: "unavailable", isPartial: true, reasons: ["live_reader_unavailable"] });
        }
        const watermark = answer?.watermark ?? null;
        const source = base.sources[uniqueInputs.findIndex(i => sourceKey(i) === sourceKey(input))];
        source.watermark = source.watermark === null ? watermark : watermark === null ? source.watermark : Math.min(source.watermark, watermark);
        loaded.push({ input, data, watermark });
    }
    const watermarks = loaded.flatMap(l => l.watermark === null ? [] : [l.watermark]);
    base.freshness.warehouseAsOf = watermarks.length ? Math.min(...watermarks) : null;
    if (loaded.some(l => l.watermark !== null && l.watermark < l.input.window.window.toMs)) {
        base.isPartial = true;
        base.reasons.push("warehouse_as_of_watermark");
    }
    const complete = loaded.every(l => !incomplete(l.data));
    if (!complete) {
        base.isPartial = true;
        base.reasons.push("incomplete_input");
    }
    if (request.kind === "numbers") {
        const periodRows = (period: string) => {
            const result: MetricRow[] = [];
            const selected = loaded.filter(l => l.input.period === period);
            for (const filters of new Set(selected.map(l => JSON.stringify(l.input.filters)))) {
                const inputs = selected.filter(l => JSON.stringify(l.input.filters) === filters);
                const rows = (i: Loaded) => {
                    const actual = (i.data as {
                        rows: MetricRow[];
                    }).rows;
                    if (request.groupBy && request.groupBy !== "day")
                        return actual;
                    for (const id of String(i.input.filters.metrics).split(","))
                        if (!actual.some(r => r.id === id)) {
                            const ratio = ["show_rate", "close_rate"].includes(id);
                            const money = ["final_cash", "cash_collected", "deposits", "average_deal_size"].includes(id);
                            actual.push({ id, value: ratio || money ? null : 0, unit: ratio ? "ratio" : money ? "minor" : "count", group: null, period: request.groupBy === "day" ? i.input.window.window.startDate : "total", ...(ratio || money ? { nullReason: ratio ? "no_denominator" : "no_payments" } : {}) });
                        }
                    return actual;
                };
                if (inputs.length === 2)
                    result.push(...mergeMetricWindows(rows(inputs[0]), rows(inputs[1]), complete));
                else
                    result.push(...rows(inputs[0]));
            }
            return result;
        };
        const rows = periodRows("current");
        const comparison = request.compareTo ? periodRows("comparison") : [];
        if (rows.some(r => r.label)) {
            base.isPartial = true;
            base.reasons.push("non_additive_split");
        }
        const bounded = boundMetricRows(rows, prepared.limit, complete);
        const comparisonStart = loaded.find(l => l.input.period === "comparison")?.input.window.window.startDate;
        const baselines = new Map(comparison.map(r => {
            const dayOffset = comparisonStart && r.period !== "total" ? Math.round((Date.parse(`${r.period}T00:00:00Z`) - Date.parse(`${comparisonStart}T00:00:00Z`)) / 86400000) : null;
            const aligned = dayOffset === null ? r : { ...r, period: addBusinessDays(prepared.resolvedRange.startDate, dayOffset) };
            return [rowKey(aligned), r];
        }));
        const withDeltas = bounded.rows.map(r => ({ ...r, ...(request.compareTo ? metricDelta(r, baselines.get(rowKey(r)) ?? (complete && !NON_ADDITIVE.has(r.id) ? { ...r, value: 0 } : undefined), complete) : {}) }));
        const groupRows = (items: Array<MetricRow & Record<string, unknown>>) => {
            const result = new Map<string, {
                group: string | null;
                periods: Array<{
                    period: string;
                    metrics: Array<MetricRow & Record<string, unknown>>;
                }>;
            }>();
            for (const item of items) {
                const group = result.get(item.group ?? "") ?? { group: item.group, periods: [] };
                let period = group.periods.find(p => p.period === item.period);
                if (!period) {
                    period = { period: item.period, metrics: [] };
                    group.periods.push(period);
                }
                period.metrics.push(item);
                result.set(item.group ?? "", group);
            }
            return [...result.values()];
        };
        const displayedGroups = new Set(bounded.rows.map(r => r.group));
        if (bounded.omitted.groups > 0) {
            base.isPartial = true;
            base.reasons.push("row_limit");
        }
        const baselineRemainder = request.compareTo ? boundMetricRows(comparison.filter(r => !displayedGroups.has(r.group)), 0, complete).omitted : null;
        if (baselineRemainder && baselineRemainder.groups > 0) {
            base.isPartial = true;
            if (!base.reasons.includes("row_limit")) base.reasons.push("row_limit");
        }
        return capAnswer({ ...base, status: "ready", rows: groupRows(withDeltas), ...(request.compareTo ? { comparison: groupRows(comparison.filter(r => displayedGroups.has(r.group))), comparisonOmitted: baselineRemainder } : {}), omitted: bounded.omitted });
    }
    let panels: Json[] = [];
    let omitted: Json[] = [];
    const rawPanels: Json[] = [];
    for (const id of new Set(loaded.map(l => l.input.id))) {
        const parts = loaded.filter(l => l.input.id === id);
        const full = parts.every(p => !incomplete(p.data));
        if (!full) {
            base.isPartial = true;
            base.reasons.push("incomplete_input");
            // One source: keep its complete parts as the page shows them.
            // Two windows are merged only when both are complete.
            if (parts.length === 1)
                rawPanels.push({ id, ...(id === "pipeline.now" ? { scope: "current_state_ignores_range" } : {}), data: withholdIncomplete(parts[0].data) as Json });
            else
                rawPanels.push({ id, value: null, nullReason: "incomplete_input" });
            continue;
        }
        if (parts.length === 2) {
            const joined = mergeReportPanel(id, parts[0].data, parts[1].data);
            if (incomplete(joined)) {
                base.isPartial = true;
                base.reasons.push("incomplete_input");
                rawPanels.push({ id, value: null, nullReason: "incomplete_input" });
            } else rawPanels.push({ id, data: joined as Json });
        }
        else
            rawPanels.push({ id, ...(id === "pipeline.now" ? { scope: "current_state_ignores_range" } : {}), data: parts[0].data as Json });
    }
    const clean = rawPanels.map(panel => safeText(panel));
    for (let displayLimit = prepared.limit; displayLimit >= 1; displayLimit--) {
        omitted = [];
        panels = clean.map(panel => boundPanel(panel, displayLimit, complete, omitted));
        if (gatewayAnswerBytes({ ...base, status: "ready", panels, omitted }) <= MAX_ASSISTANT_ANSWER_BYTES)
            break;
    }
    if (JSON.stringify(panels).includes('"mixed_currencies"')) {
        base.isPartial = true;
        base.reasons.push("mixed_currencies");
    }
    if (omitted.some(item => item && typeof item === "object" && !Array.isArray(item) && item.nullReason === "incomplete_input")) base.reasons.push("incomplete_input");
    if (omitted.length) {
        base.isPartial = true;
        base.reasons.push("row_limit");
    }
    base.reasons = [...new Set(base.reasons)];
    return capAnswer({ ...base, status: "ready", panels, omitted });
}
export const numbers = internalAction({ args: { caller: mcpCallerValidator, ...numbersArgs }, returns: v.any(), handler: async (ctx, { caller, ...args }): Promise<Record<string, unknown>> => runReportTool(ctx, caller, { kind: "numbers", ...args }) });
export const report = internalAction({ args: { caller: mcpCallerValidator, ...reportArgs }, returns: v.any(), handler: async (ctx, { caller, ...args }): Promise<Record<string, unknown>> => runReportTool(ctx, caller, { kind: "report", ...args }) });
