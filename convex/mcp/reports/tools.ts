import { v } from "convex/values";
import { internalAction, type ActionCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { mcpCallerValidator, type McpCaller } from "../guard";
import { appLink } from "../admin/prepare";
import { numbersArgs, reportArgs, ASSISTANT_COLD_WAIT_MS, type ToolRequest } from "./contracts";
import type { Prepared, JobAnswer } from "./planning";
import { incomplete, withholdIncomplete, safeText, boundPanel, capAnswer, type Json } from "./output";
import { boundMetricRows, metricDelta, NON_ADDITIVE, type MetricRow } from "../../../lib/assistantReportMerge";
import { addBusinessDays } from "../../../lib/businessDay";
import { mergeReportPanel } from "./merge";
import { REPORT_DEFINITIONS } from "./catalog";
import { gatewayAnswerBytes, MAX_ASSISTANT_ANSWER_BYTES } from "../../../lib/assistantReportMerge";
import { METRIC_DEFINITIONS, projectNumbers, metricPanels } from "./metrics";
import { shapePanel } from "../../../lib/reporting/pageFigures/panels";
const rowKey = (r: MetricRow) => JSON.stringify([r.id, r.group, r.period, r.currency ?? null, r.label ?? null]);
export type Loaded = {
    input: Prepared["inputs"][number];
    data: unknown;
    watermark: number | null;
};
/**
 * Apply the page's own window merge before any projection. The page merges
 * whatever its partial flags say and shows the result with those flags, so
 * the merged answer keeps them; figures that depend on a flagged part come
 * back as lower bounds, and comparisons still need complete inputs.
 */
export function mergedPageAnswers(loaded: Loaded[], period: string): Map<string, unknown> {
    const result = new Map<string, unknown>();
    const panelKey = (l: Loaded) => `${l.input.id}${l.input.team ? ".team" : ""}`;
    const selected = loaded.filter(l => l.input.period === period);
    for (const key of new Set(selected.map(panelKey))) {
        const parts = selected.filter(l => panelKey(l) === key);
        if (parts.length === 1) result.set(key, parts[0].data);
        else if (parts.length === 2) result.set(key, mergeReportPanel(parts[0].input.id, parts[0].data, parts[1].data));
    }
    return result;
}
/**
 * A report still too big at one row per list sheds detail before it is
 * refused: first the omissions' remainders, then each panel's raw page answer,
 * keeping the figures the page shows.
 */
export function shedDetail(base: { isPartial: boolean; reasons: string[] }, panels: Json[], omitted: Json[]) {
    const fits = () => gatewayAnswerBytes({ ...base, status: "ready", panels, omitted }) <= MAX_ASSISTANT_ANSWER_BYTES;
    if (fits()) return { panels, omitted };
    base.isPartial = true;
    base.reasons.push("answer_trimmed");
    // Keep each omission's nullReason: it says the source list was incomplete.
    omitted = omitted.map(item => item && typeof item === "object" && !Array.isArray(item)
        ? { scope: item.scope ?? null, rows: item.rows ?? null, ...(item.nullReason ? { nullReason: item.nullReason } : {}) }
        : item);
    if (fits()) return { panels, omitted };
    panels = panels.map(panel => panel && typeof panel === "object" && !Array.isArray(panel) && "data" in panel && "figures" in panel
        ? Object.fromEntries([...Object.entries(panel).filter(([key]) => key !== "data"), ["dataOmitted", true]]) as Json
        : panel);
    return { panels, omitted };
}
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
        // The per-minute allowance clears within a minute: the same request
        // can be retried. The daily one can't, so it stays unavailable.
        if (admission.status === "unavailable" && admission.reason === "assistant_minute_allowance_spent")
            return capAnswer({ ...base, status: "pending", isPartial: true, reasons: [admission.reason], retryAfterSeconds: 60 });
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
        const currentAnswers = mergedPageAnswers(loaded, "current");
        const periodRows = (period: string) => {
            const merged = period === "current" ? currentAnswers : mergedPageAnswers(loaded, period);
            return projectNumbers(merged, request, currentAnswers).map(row => {
                const deps = metricPanels(row.id as typeof request.metrics[number], request);
                const lowerBound = loaded.some(l => l.input.period === period && deps.includes(l.input.id) && incomplete(l.data));
                return lowerBound && row.value !== null ? { ...row, lowerBound: true } : row;
            });
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
        const withDeltas = bounded.rows.map(r => ({ ...r, ...(request.compareTo ? metricDelta(r, baselines.get(rowKey(r)) ?? (complete && !NON_ADDITIVE.has(r.id) ? { ...r, value: 0 } : undefined), complete && !r.lowerBound && !baselines.get(rowKey(r))?.lowerBound) : {}) }));
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
    const pageAnswers = mergedPageAnswers(loaded, "current");
    for (const id of new Set(loaded.filter(l => !l.input.team).map(l => l.input.id))) {
        if (request.panel && request.panel !== id && request.panel !== id.split(".")[1]) continue;
        if (request.report === "people" && request.role && request.role !== "everyone" && id !== `people.${request.role}` && id !== "people.profile") continue;
        if (!pageAnswers.has(id)) {
            rawPanels.push({ id, value: null, nullReason: "incomplete_input" });
            base.isPartial = true;
            base.reasons.push("incomplete_input");
            continue;
        }
        const shaped = shapePanel(id, pageAnswers.get(id), pageAnswers, request);
        const lowerBound = incomplete(pageAnswers.get(id)) || incomplete(pageAnswers.get(`${id}.team`)) || id === "people.members" && loaded.some(l => l.input.id.startsWith("people.") && incomplete(l.data));
        rawPanels.push({ ...shaped, ...(lowerBound ? { lowerBound: true } : {}),
            data: withholdIncomplete(shaped.data),
            ...(id === "pipeline.now" ? { scope: "current_state_ignores_range" } : {}),
        } as Json);
    }
    const clean = rawPanels.map(panel => safeText(panel));
    for (let displayLimit = prepared.limit; displayLimit >= 1; displayLimit--) {
        omitted = [];
        panels = clean.map(panel => boundPanel(panel, displayLimit, complete, omitted));
        if (gatewayAnswerBytes({ ...base, status: "ready", panels, omitted }) <= MAX_ASSISTANT_ANSWER_BYTES)
            break;
    }
    ({ panels, omitted } = shedDetail(base, panels, omitted));
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
