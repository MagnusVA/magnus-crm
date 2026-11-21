import { v } from "convex/values";
import { internal } from "../../_generated/api";
import { internalAction, internalQuery } from "../../_generated/server";
import { rejectRequest } from "../../lib/observability/errors";
import { getTenantBusinessDay } from "../../lib/tenantBusinessDay";
import { analyticsArgsKey, canonicalJson } from "../../analytics/keys";
import { readSyncRow } from "../../analytics/results";
import { isClickHouseConfigured } from "../../analytics/clickhouse";
import { getReportDefinition } from "../../analytics/registry";
import {
  LEAD_COUNTRIES_REPORT,
  type LeadCountriesAnswer,
} from "../../analytics/definitions/leadCountries";
import { ReportRequestError, planAssistantSources, reportLimit } from "../../../lib/assistantReportPlan";
import { resolveAnalyticsRange, type AnalyticsRange, type ResolvedAnalyticsRange } from "../../../lib/analyticsRange";
import { mcpCallerValidator, requireMcpAdmin } from "../guard";
import { paths, text } from "../admin/reads/common";
import { formatLocal } from "../time";
import { ASSISTANT_COLD_WAIT_MS, rangeValidator, type ReportJob } from "./contracts";
import type { JobAnswer } from "./planning";
import { capAnswer } from "./output";
import { gatewayAnswerBytes, MAX_ASSISTANT_ANSWER_BYTES } from "../../../lib/assistantReportMerge";

export const leadCountriesArgs = {
  range: rangeValidator,
  country: v.optional(v.string()),
  limit: v.optional(v.number()),
};

type Prepared = { job: ReportJob; resolvedRange: ResolvedAnalyticsRange; limit: number; timeZone: string; configured: boolean };

/**
 * Checks the admin and the arguments, and builds the one warehouse job. The
 * whole range reads ClickHouse whatever the page switches say, so the answer
 * is as of the last sync.
 */
export const prepare = internalQuery({
  args: { caller: mcpCallerValidator, ...leadCountriesArgs },
  returns: v.string(),
  handler: async (ctx, { caller, range, country, limit }) => {
    const me = await requireMcpAdmin(ctx, caller, { permission: "reports:view" });
    try {
      const bounded = reportLimit(limit);
      const day = await getTenantBusinessDay(ctx, me.tenantId);
      const now = Date.now();
      const { resolvedRange } = planAssistantSources({ range, day, now, page: "", warehousePages: [] });
      let filters;
      try {
        filters = await getReportDefinition(LEAD_COUNTRIES_REPORT).parseFilters(ctx, { country: country ?? null }, me);
      } catch (error) {
        throw new ReportRequestError(error instanceof Error ? error.message : "Choose a valid country.");
      }
      const jobRange: AnalyticsRange = { kind: "custom", startDate: resolvedRange.startDate, endDateInclusive: resolvedRange.endDateInclusive };
      const syncWatermark = (await readSyncRow(ctx))?.watermark ?? 0;
      const job: ReportJob = {
        key: canonicalJson({ report: LEAD_COUNTRIES_REPORT, args: analyticsArgsKey({ filters, range: jobRange, day }), from: jobRange.startDate, to: jobRange.endDateInclusive, syncWatermark }),
        report: LEAD_COUNTRIES_REPORT,
        filtersJson: canonicalJson(filters),
        range: jobRange,
        window: resolveAnalyticsRange(jobRange, day, now),
        syncWatermark,
      };
      const prepared: Prepared = { job, resolvedRange, limit: bounded, timeZone: me.timeZone, configured: isClickHouseConfigured() };
      return JSON.stringify(prepared);
    } catch (error) {
      if (error instanceof ReportRequestError) throw rejectRequest("report.invalid_request", error.message);
      throw error;
    }
  },
});

const BASIS = "Distinct leads with a Slack qualification submitted in the range, each counted once under the country on their profile, else the country typed on their newest qualification in the range. Countries are free text and group ignoring case and spacing only.";

export const run = internalAction({
  args: { caller: mcpCallerValidator, ...leadCountriesArgs },
  returns: v.any(),
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    const started = Date.now();
    const prepared: Prepared = JSON.parse(await ctx.runQuery(internal.mcp.reports.leadCountries.prepare, args));
    const { job } = prepared;
    const base = {
      resolvedRange: { startDate: prepared.resolvedRange.startDate, endDateInclusive: prepared.resolvedRange.endDateInclusive },
      basis: BASIS,
      freshness: { warehouseAsOf: null as string | null },
      isPartial: false,
      reasons: [] as string[],
    };
    if (!prepared.configured)
      return capAnswer({ ...base, status: "unavailable", isPartial: true, reasons: ["warehouse_not_configured"] });
    let answer: JobAnswer;
    for (;;) {
      [answer] = JSON.parse(await ctx.runQuery(internal.mcp.reports.planning.jobStates, { caller: args.caller, jobs: [job] })) as JobAnswer[];
      if (answer.status === "failed")
        return capAnswer({ ...base, status: "failed", isPartial: true, reasons: [answer.reason ?? "warehouse_failed"] });
      if (answer.status === "ready") break;
      await ctx.runMutation(internal.mcp.reports.admission.admit, { caller: args.caller, jobs: [job] });
      const remaining = ASSISTANT_COLD_WAIT_MS - (Date.now() - started);
      if (remaining <= 0) return capAnswer({ ...base, status: "pending", retryAfterSeconds: 3 });
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, remaining)));
    }
    const json: string | null = await ctx.runQuery(internal.mcp.reports.planning.jobAnswer, { caller: args.caller, source: answer.source! });
    if (json === null) return capAnswer({ ...base, status: "pending", retryAfterSeconds: 3 });
    const data = JSON.parse(json) as LeadCountriesAnswer;
    const watermark = answer.watermark ?? null;
    if (watermark !== null) base.freshness.warehouseAsOf = formatLocal(watermark, prepared.timeZone);
    if (watermark === null || watermark < job.window.toMs) {
      base.isPartial = true;
      base.reasons.push("warehouse_as_of_watermark");
    }
    if (data.partial) {
      base.isPartial = true;
      base.reasons.push("row_limit");
    }
    const filter = JSON.parse(job.filtersJson).country as string | null;
    const shape = (rows: number) => {
      const hidden = data.countries.slice(rows);
      const listed = data.leads.slice(0, rows);
      return {
        ...base,
        status: "ready",
        totals: data.totals,
        countries: data.countries.slice(0, rows).map((row) => ({ country: text(row.country, "integration"), leads: row.leads })),
        omitted: hidden.length ? { countries: hidden.length, leads: hidden.reduce((sum, row) => sum + row.leads, 0) } : null,
        ...(filter === null ? {} : {
          leads: listed.map((lead) => ({
            personId: lead.leadId,
            name: text(lead.name?.trim() || "Unnamed person"),
            country: text(lead.country, "integration"),
            lastQualifiedAt: formatLocal(lead.lastQualifiedAt, prepared.timeZone),
            openInMagnus: paths.person(lead.leadId),
          })),
          leadsOmitted: Math.max(0, data.leadsTotal - listed.length),
        }),
      };
    };
    // Long names or countries shrink the lists until the answer fits.
    let rows = prepared.limit;
    while (rows > 1 && gatewayAnswerBytes(shape(rows)) > MAX_ASSISTANT_ANSWER_BYTES) rows -= 1;
    return capAnswer(shape(rows));
  },
});
