import type { Id } from "../../_generated/dataModel";
import { v, type Infer } from "convex/values";
import { internal } from "../../_generated/api";
import { internalAction, internalMutation, internalQuery, type ActionCtx } from "../../_generated/server";
import { rejectRequest } from "../../lib/observability/errors";
import { leadGenBusinessDayBlocked } from "../../lib/businessDayRebuildState";
import { LEAD_GEN_ADMIN_ROLES, mcpCallerValidator, requireMcpUser } from "../guard";
import { leadGenRangeArgs, resolveLeadGenRange, type LeadGenActionCaller } from "../leadGenShared";
import { leadGenSourceValidator } from "../../leadGen/validators";
import { readLeadGenOverview, readWorkerPerformance, readTopOriginsByTeam } from "../../leadGen/reporting";
import { readProspectConversions } from "../../leadGen/conversions";
import { readResparkPerformance } from "../../leadGen/resparkReports";
import { listSharedDmTeams } from "../../leadGen/sharedTeams";
import { groupRowsByTeam } from "../../../lib/lead-gen/team-rollup";
import { dashboardRangePlan, answerCoversDays, answerDays } from "../../../lib/analyticsRange";
import { reportRequestArgs, reportDefinitionFor, resolveReportRequest, canonicalJson } from "../../analytics/keys";
import { findResult, registerRequest, resultState } from "../../analytics/results";
import { requestReport } from "../../operations/reports/jobs";
import { REPORT_DEFINITION_VERSION } from "../../operations/reports/contracts";
import { paginationOptsValidator } from "convex/server";
import {
  leadDashboardOverview, leadDashboardWorkers, leadDashboardTeams,
  leadDashboardOriginsByTeam, sortLeadDashboardOriginTeams,
} from "../../../lib/lead-gen/snapshot";
import {
  mergeLeadGenOverview, mergeLeadGenWorkers, mergeLeadGenTopOriginsByTeam,
  mergeLeadGenProspectConversions, mergeLeadGenResparkPerformance,
} from "../../analytics/merge/leadGen";
import { sha256Hex } from "../confirm";
import { formatLocal } from "../time";

type Overview = Awaited<ReturnType<typeof readLeadGenOverview>>;
type Specialists = Awaited<ReturnType<typeof readWorkerPerformance>>;
type Origins = Awaited<ReturnType<typeof readTopOriginsByTeam>>;
type Conversions = Awaited<ReturnType<typeof readProspectConversions>>;
type Resparks = Awaited<ReturnType<typeof readResparkPerformance>>;
const sectionValidator = v.union(v.literal("overview"), v.literal("specialists"), v.literal("teams"),
  v.literal("top_posts"), v.literal("conversions"), v.literal("respark"));
type Section = Infer<typeof sectionValidator>;
const dates = { startDayKey: v.string(), endDayKey: v.string() };
export const reportArgs = {
  ...leadGenRangeArgs,
  sections: v.optional(v.array(sectionValidator)),
  source: v.optional(leadGenSourceValidator),
  cursor: v.optional(v.string()),
};
const nullableNumber = v.union(v.number(), v.null());
const teamId = v.union(v.id("attributionTeams"), v.null());
const totals = { submissions: v.number(), uniqueProspects: v.number(), duplicates: v.number(),
  scheduledHours: v.number(), leadsPerHour: nullableNumber };
const specialist = { workerId: v.id("leadGenWorkers"), displayName: v.string(), teamId };
const counts = v.object({ prospect: v.number(), in_conversation: v.number(), qualified: v.number(),
  booked: v.number(), showed: v.number(), customer: v.number() });
// Flat post rows keep the response cap meaningful even for teams with many posts.
const rowValidator = v.union(
  v.object(totals),
  v.object({ ...specialist, ...totals, isActive: v.boolean() }),
  v.object({ teamId, teamName: v.string(), submissions: v.number(), scheduledHours: v.number(),
    leadsPerHour: nullableNumber, specialistCount: v.number() }),
  v.object({ teamId, teamName: v.string(), totalSubmissions: v.number(), originKey: v.string(),
    source: leadGenSourceValidator, originKind: v.union(v.literal("post"), v.literal("reel")),
    originValue: v.string(), submissions: v.number(), uniqueProspects: v.number() }),
  v.object({ ...specialist, counts, deals: v.number() }),
  v.object({ ...specialist, rawLeads: nullableNumber, resparks: v.number(), entries: nullableNumber,
    notAFit: v.number(), notAFitShare: nullableNumber, resparkedThenBooked: v.number() }),
);
type Row = Infer<typeof rowValidator>;
const sectionResultValidator = v.object({
  section: sectionValidator,
  rows: v.array(rowValidator),
  effectiveFilters: v.object({ ...dates, source: v.optional(leadGenSourceValidator),
    sourceAppliesTo: v.optional(v.literal("rawLeads")) }),
  definitions: v.array(v.string()),
  source: v.union(v.literal("live"), v.literal("warehouse"), v.literal("snapshot")),
  asOf: v.union(v.string(), v.null()),
  capped: v.boolean(),
  cappedFlags: v.record(v.string(), v.boolean()),
  rankingPartial: v.boolean(),
  textTruncated: v.boolean(),
  state: v.union(v.literal("ready"), v.literal("pending"), v.literal("failed"), v.literal("rebuilding")),
  cursor: v.union(v.string(), v.null()),
});
type SectionResult = Omit<Infer<typeof sectionResultValidator>, "asOf"> & { asOf: number | null };
export const reportResultValidator = v.object({ sections: v.array(sectionResultValidator) });

/** The same live query cores the page uses, with the gateway's verified caller. */
export const readLive = internalQuery({
  args: { caller: mcpCallerValidator, ...dates, source: v.optional(leadGenSourceValidator), sections: v.array(sectionValidator), metadataOnly: v.optional(v.boolean()), warehouseSplit: v.optional(v.boolean()) },
  returns: v.string(),
  handler: async (ctx, args) => {
    const me = await requireMcpUser(ctx, args.caller, [...LEAD_GEN_ADMIN_ROLES]);
    const blocked = await leadGenBusinessDayBlocked(ctx, me.tenantId);
    const needed = new Set(args.metadataOnly ? [] : args.sections);
    const overview = !blocked && ["overview", "specialists", "teams", "top_posts"].some(s => needed.has(s as Section))
      ? await readLeadGenOverview(ctx, me.tenantId, args) : null;
    const failedSections: Section[] = [];
    // A switched page reads its tables independently of a capped overview.
    // Keep a failed live half from discarding other warehouse sections.
    async function readSection<T>(sections: Section[], read: () => Promise<T>): Promise<T | null> {
      try { return await read(); }
      catch { failedSections.push(...sections); return null; }
    }
    const tablesReadable = !overview?.capped || args.warehouseSplit;
    const workers = !blocked && (needed.has("specialists") || needed.has("teams")) && tablesReadable
      ? await readSection(["specialists", "teams"], () => readWorkerPerformance(ctx, me.tenantId, args)) : null;
    const origins = !blocked && needed.has("top_posts") && tablesReadable
      ? await readSection(["top_posts"], () => readTopOriginsByTeam(ctx, me.tenantId, { ...args, limitPerTeam: 10, sortBy: "submissions" })) : null;
    // Conversions intentionally have no source filter and no rebuild guard on the page.
    const conversions = needed.has("conversions") ? await readProspectConversions(ctx, me.tenantId, args) : null;
    const resparks = !blocked && needed.has("respark") ? await readResparkPerformance(ctx, me.tenantId, args) : null;
    const teams = args.sections.includes("teams") ? await listSharedDmTeams(ctx, { tenantId: me.tenantId, includeInactive: true }) : [];
    const resparkWorkers = resparks ? await Promise.all(resparks.rows.map(row => ctx.db.get("leadGenWorkers", row.workerId))) : args.sections.includes("respark") ? await ctx.db.query("leadGenWorkers").withIndex("by_tenantId_and_isActive", q => q.eq("tenantId", me.tenantId)).take(500) : [];
    return JSON.stringify({ blocked, failedSections, overview, workers, origins, conversions, resparks, teams,
      resparkTeams: resparkWorkers.map(w => ({ workerId: w?._id, teamId: w?.teamId ?? null })),
      businessDayVersion: me.tenant.businessDayVersion ?? 0,
      warehouse: me.tenant.analyticsReports?.includes("lead_gen") ?? false });
  },
});
type Live = {
  blocked: boolean; failedSections: Section[]; overview: Overview | null; workers: Specialists | null; origins: Origins | null;
  conversions: Conversions | null; resparks: Resparks | null;
  teams: Array<{ _id: Infer<typeof teamId> & string; name: string }>;
  resparkTeams: Array<{ workerId: string; teamId: Infer<typeof teamId> }>;
  businessDayVersion: number; warehouse: boolean;
};

export const requestWarehouse = internalMutation({
  args: { caller: mcpCallerValidator, ...reportRequestArgs },
  returns: v.null(),
  handler: async (ctx, args) => {
    const me = await requireMcpUser(ctx, args.caller, [...LEAD_GEN_ADMIN_ROLES]);
    const request = await resolveReportRequest(ctx, args, reportDefinitionFor(args.reportId), me);
    await registerRequest(ctx, { tenantId: me.tenantId, reportId: request.definition.id,
      argsKey: request.argsKey, filtersJson: request.filtersJson, range: args.range, day: request.day });
    return null;
  },
});
export const readWarehouse = internalQuery({
  args: { caller: mcpCallerValidator, ...reportRequestArgs },
  returns: v.string(),
  handler: async (ctx, args) => {
    const me = await requireMcpUser(ctx, args.caller, [...LEAD_GEN_ADMIN_ROLES]);
    const request = await resolveReportRequest(ctx, args, reportDefinitionFor(args.reportId), me);
    return JSON.stringify(await resultState(ctx, await findResult(ctx, me.tenantId, request.definition.id, request.argsKey)));
  },
});

export const requestSnapshot = internalMutation({
  args: { caller: mcpCallerValidator, ...dates, source: v.optional(leadGenSourceValidator), requestToken: v.string() },
  returns: v.id("operationsReportJobs"),
  handler: async (ctx, args) => {
    const me = await requireMcpUser(ctx, args.caller, [...LEAD_GEN_ADMIN_ROLES]);
    return (await requestReport(ctx, me, { purpose: "dashboard", reportKind: "lead-gen",
      range: { kind: "custom", startBusinessDate: args.startDayKey, endBusinessDateInclusive: args.endDayKey },
      sourceFilter: args.source ?? "all", requestToken: args.requestToken })).jobId;
  },
});
export const readSnapshot = internalQuery({
  args: { caller: mcpCallerValidator, jobId: v.id("operationsReportJobs"), ...dates,
    source: v.optional(leadGenSourceValidator), section: v.optional(v.union(v.literal("lead_gen_worker"), v.literal("lead_gen_team_origin"))),
    paginationOpts: paginationOptsValidator },
  returns: v.string(),
  handler: async (ctx, args) => {
    const me = await requireMcpUser(ctx, args.caller, [...LEAD_GEN_ADMIN_ROLES]);
    const job = await ctx.db.get("operationsReportJobs", args.jobId);
    if (!job || job.tenantId !== me.tenantId || job.requestedByUserId !== me.userId || job.purpose !== "dashboard" || job.reportKind !== "lead-gen"
      || job.range.startDayKey !== args.startDayKey || job.range.endBusinessDateInclusive !== args.endDayKey || job.sourceFilter !== (args.source ?? "all")) {
      throw rejectRequest("report.cursor_invalid", "This snapshot doesn't belong to this report.");
    }
    if (await leadGenBusinessDayBlocked(ctx, me.tenantId)) return JSON.stringify({ state: "rebuilding" });
    if (job.definitionVersion !== REPORT_DEFINITION_VERSION || job.range.businessDayVersion !== (me.tenant.businessDayVersion ?? 0)
      || (job.expiresAt !== undefined && job.expiresAt <= Date.now())) return JSON.stringify({ state: "failed" });
    if (job.status !== "ready") return JSON.stringify({ state: ["failed", "canceled"].includes(job.status) ? "failed" : "pending" });
    if (args.section) {
      const page = await ctx.db.query("operationsReportRows")
        .withIndex("by_jobId_and_section_and_rowType_and_sortValue", q => q.eq("jobId", job._id).eq("section", args.section!).eq("rowType", "result"))
        .order("desc").paginate(args.paginationOpts);
      return JSON.stringify({ state: "ready", page: page.page.map(r => ({ rowKey: r.rowKey, payload: r.payload })),
        isDone: page.isDone, continueCursor: page.continueCursor, asOf: job.completedAt });
    }
    const summary = await ctx.db.query("operationsReportRows")
      .withIndex("by_jobId_and_section_and_rowType_and_rowKey", q => q.eq("jobId", job._id).eq("section", "lead_gen_summary").eq("rowType", "result").eq("rowKey", "main")).unique();
    return JSON.stringify({ state: summary ? "ready" : "failed", payload: summary?.payload, asOf: job.completedAt });
  },
});

type Cursor = { version: 1; section: Section; binding: string; generation: string; offset: number; snapshotJobId?: Id<"operationsReportJobs"> };
function decodeCursor(value: string): Cursor {
  try {
    const c = JSON.parse(value) as Cursor;
    if (c.version !== 1 || !Number.isSafeInteger(c.offset) || c.offset < 0 || typeof c.binding !== "string" || typeof c.generation !== "string") throw new Error();
    return c;
  } catch { throw rejectRequest("report.cursor_invalid", "Invalid report cursor. Start the section again."); }
}
const SNAPSHOT_SECTIONS: Section[] = ["overview", "specialists", "teams", "top_posts"];
const REPORT_IDS = { overview: "lead_gen.overview", specialists: "lead_gen.workers", teams: "lead_gen.workers",
  top_posts: "lead_gen.top_origins_by_team", conversions: "lead_gen.prospect_conversions", respark: "lead_gen.respark_performance" };
const definitions: Record<Section, string[]> = {
  overview: ["Unique prospects are prospect-days, summed across business days.", "Leads per hour is submissions divided by scheduled hours."],
  specialists: ["Unique prospects are prospect-days.", "Specialists carry their current team."],
  teams: ["Teams roll up specialists by each specialist's current team.", "Per-hour rates divide team submissions by team scheduled hours."],
  top_posts: ["Posts and reels are grouped by team at capture time.", "Unique prospects are prospect-days; each team shows up to ten posts ranked by submissions."],
  conversions: ["Stages count first-captured prospects reaching each stage since capture, across every source.", "Deals credit the worker whose capture was the person's first touch."],
  respark: ["Source filters raw captures only; resparks, not-a-fit and booked credit count every source.", "Entries are raw captures plus resparks; not-a-fit share divides not-a-fit by resparks plus not-a-fit."],
};
function merge(section: Section, history: unknown, live: Live): unknown {
  switch (section) {
    case "overview": return mergeLeadGenOverview(history as Overview, live.overview!);
    case "specialists": case "teams": return mergeLeadGenWorkers(history as Specialists, live.workers!);
    case "top_posts": return mergeLeadGenTopOriginsByTeam(history as Origins, live.origins!);
    case "conversions": return mergeLeadGenProspectConversions(history as Conversions, live.conversions!);
    case "respark": return mergeLeadGenResparkPerformance(history as Resparks, live.resparks!);
  }
}
function liveValue(section: Section, live: Live): unknown {
  switch (section) {
    case "overview": return live.overview;
    case "specialists": case "teams": return live.workers;
    case "top_posts": return live.origins;
    case "conversions": return live.conversions;
    case "respark": return live.resparks;
  }
}
function project(section: Section, data: unknown, live: Live): Row[] {
  switch (section) {
    case "overview": { const { capped: _, ...row } = data as Overview; void _; return [row]; }
    case "specialists": return (data as Specialists).map(({ workerId, displayName, teamId, isActive, submissions, uniqueProspects, duplicates, scheduledHours, leadsPerHour }) =>
      ({ workerId, displayName, teamId, isActive, submissions, uniqueProspects, duplicates, scheduledHours, leadsPerHour }));
    case "teams": return groupRowsByTeam(data as Specialists, live.teams).map(g => ({ teamId: g.teamId, teamName: g.teamName,
      submissions: g.submissions, scheduledHours: g.scheduledHours, leadsPerHour: g.scheduledHours > 0 ? g.submissions / g.scheduledHours : null, specialistCount: g.rows.length }));
    case "top_posts": return sortLeadDashboardOriginTeams(data as Origins).flatMap(g => g.origins.map(o => ({ teamId: g.teamId as Infer<typeof teamId>, teamName: g.teamName,
      totalSubmissions: g.totalSubmissions, originKey: o.originKey, source: o.source as "instagram" | "meta_business", originKind: o.originKind as "post" | "reel",
      originValue: o.originValue, submissions: o.submissions, uniqueProspects: o.uniqueProspects })));
    case "conversions": return (data as Conversions).rows.map(({ worker: _, ...r }) => { void _; return r; });
    case "respark": return (data as Resparks).rows.map(({ worker, ...r }) => ({ ...r, displayName: worker.name ?? "Unknown worker",
      teamId: live.resparkTeams.find(w => w.workerId === r.workerId)?.teamId ?? null }));
  }
}
function flags(data: unknown): Record<string, boolean> {
  if (!data || Array.isArray(data)) return {};
  return Object.fromEntries(Object.entries(data).filter(([k, val]) => /capped$/i.test(k) && typeof val === "boolean")) as Record<string, boolean>;
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** One deadline covers every section, including snapshot page accumulation. */
export const report = internalAction({
  args: { caller: mcpCallerValidator, ...reportArgs },
  returns: reportResultValidator,
  handler: async (ctx, args): Promise<Infer<typeof reportResultValidator>> => {
    const deadline = Date.now() + 25_000;
    const authorize = (): Promise<LeadGenActionCaller> => ctx.runQuery(internal.mcp.leadGenShared.authorizeCaller,
      { caller: args.caller, roles: [...LEAD_GEN_ADMIN_ROLES] });
    const me = await authorize();
    const range = resolveLeadGenRange(args, me.todayDayKey, { maxDays: 120 });
    const continuation = args.cursor ? decodeCursor(args.cursor) : null;
    const sections = [...new Set(args.sections ?? (continuation ? [continuation.section] : ["overview", "specialists"] as Section[]))];
    if (!sections.length || sections.length > 6 || (continuation && (sections.length !== 1 || sections[0] !== continuation.section))) {
      throw rejectRequest("report.sections_invalid", "Choose report sections; a cursor continues exactly its own section.");
    }
    const binding = await sha256Hex(canonicalJson({ tenantId: me.tenantId, userId: me.userId,
      startDayKey: range.startDayKey, endDayKey: range.endDayKey, source: args.source ?? null, businessDay: me.businessDay }));
    if (continuation && continuation.binding !== binding) throw rejectRequest("report.cursor_invalid", "This cursor belongs to another range or source.");
    const filters = { startDayKey: range.startDayKey, endDayKey: range.endDayKey, ...(args.source ? { source: args.source } : {}) };
    const context: Live = JSON.parse(await ctx.runQuery(internal.mcp.tools.leadGenReport.readLive,
      { caller: args.caller, ...filters, sections, metadataOnly: true }));
    const plan = dashboardRangePlan(range.preset === "custom"
      ? { kind: "custom", startBusinessDate: range.startDayKey, endBusinessDateInclusive: range.endDayKey }
      : { kind: "preset", preset: range.preset }, me.todayDayKey);
    const warehouse = context.warehouse && plan.kind !== "live";
    const liveSections = warehouse && plan.kind === "warehouse" ? [] : !warehouse && range.days > 7
      ? sections.filter(s => !SNAPSHOT_SECTIONS.includes(s)) : sections;
    const live: Live = liveSections.length ? JSON.parse(await ctx.runQuery(internal.mcp.tools.leadGenReport.readLive,
      { caller: args.caller, ...filters, ...(warehouse ? { startDayKey: me.todayDayKey, endDayKey: me.todayDayKey } : {}), sections: liveSections, warehouseSplit: warehouse })) : context;
    const snapshot = !warehouse && (range.days > 7 || live.overview?.capped === true);
    let snapshotJobId = continuation?.snapshotJobId;
    const results = new Map<Section, SectionResult>();
    for (const section of sections) results.set(section, {
      section, rows: [], effectiveFilters: section === "conversions" ? { startDayKey: range.startDayKey, endDayKey: range.endDayKey }
        : { ...filters, ...(section === "respark" && args.source ? { sourceAppliesTo: "rawLeads" as const } : {}) },
      definitions: definitions[section], source: warehouse ? "warehouse" : snapshot && SNAPSHOT_SECTIONS.includes(section) ? "snapshot" : "live",
      asOf: null, capped: false, cappedFlags: {}, rankingPartial: warehouse && plan.kind === "split" && section === "top_posts",
      textTruncated: false, state: "pending", cursor: null,
    });
    // Keep source generations separate from wall-clock read time: unchanged live rows
    // can continue, while a refresh, snapshot replacement or business-day rebuild cannot.
    const generations = new Map<Section, unknown>();
    function ready(section: Section, data: unknown, asOf: number, generation: unknown, from: Live = live) {
      const result = results.get(section)!;
      result.state = "ready";
      result.rows = project(section, data, from);
      result.asOf = asOf;
      result.cappedFlags = flags(data);
      result.capped = Object.values(result.cappedFlags).some(Boolean);
      generations.set(section, generation);
    }
    const warehouseArgs = (section: Section) => ({ caller: args.caller, reportId: REPORT_IDS[section],
      range: plan.kind === "split" ? plan.history : plan.kind === "warehouse" ? plan.range : { kind: "custom" as const, startDate: range.startDayKey, endDateInclusive: range.endDayKey },
      filters: section === "conversions" ? {} : { source: args.source ?? null,
        ...(section === "top_posts" ? { limitPerTeam: 10, sortBy: "submissions" } : {}) }, timeZone: me.timeZone });
    const waiting = new Set<Section>();
    for (const section of sections) {
      const result = results.get(section)!;
      // Conversions has no business-day bucket dependency; historical warehouse
      // sections also remain readable while only today's buckets rebuild.
      if (context.blocked && section !== "conversions" && (!warehouse || plan.kind === "split")) { result.state = "rebuilding"; continue; }
      if (live.failedSections.includes(section)) { result.state = "failed"; continue; }
      if (warehouse) {
        await ctx.runMutation(internal.mcp.tools.leadGenReport.requestWarehouse, warehouseArgs(section));
        waiting.add(section);
      } else if (snapshot && SNAPSHOT_SECTIONS.includes(section)) {
        waiting.add(section);
      } else ready(section, liveValue(section, live), Date.now(), { live: true, version: live.businessDayVersion });
    }
    if ([...waiting].some(s => results.get(s)!.source === "snapshot") && !snapshotJobId) {
      snapshotJobId = await ctx.runMutation(internal.mcp.tools.leadGenReport.requestSnapshot,
        { caller: args.caller, ...filters, requestToken: `mcp-report-${crypto.randomUUID()}` });
    }
    while (waiting.size && Date.now() < deadline) {
      for (const section of [...waiting]) {
        const result = results.get(section)!;
        if (result.source !== "warehouse") continue;
        const state: Awaited<ReturnType<typeof resultState>> = JSON.parse(await ctx.runQuery(internal.mcp.tools.leadGenReport.readWarehouse, warehouseArgs(section)));
        // A failed run never exposes a stale payload as a successful MCP answer.
        if (state.state === "failed") { result.state = "failed"; waiting.delete(section); continue; }
        if (state.state === "queued") { waiting.delete(section); continue; }
        if (state.state !== "ready" || !state.payloadJson || !state.answer || !answerCoversDays(state.answer, answerDays(plan, true))) continue;
        const history: unknown = JSON.parse(state.payloadJson);
        ready(section, plan.kind === "split" ? merge(section, history, live) : history,
          state.answer.watermark, { answer: state.answer, liveVersion: live.businessDayVersion }, plan.kind === "warehouse" ? context : live);
        waiting.delete(section);
      }
      const snapshotSections = [...waiting].filter(s => results.get(s)!.source === "snapshot");
      if (snapshotSections.length && snapshotJobId) {
        const base = { caller: args.caller, jobId: snapshotJobId, ...filters };
        const state: SnapshotRead = JSON.parse(await ctx.runQuery(internal.mcp.tools.leadGenReport.readSnapshot,
          { ...base, paginationOpts: { cursor: null, numItems: 100 } }));
        if (state.state !== "pending") {
          if (state.state === "ready") {
            const workers = snapshotSections.some(s => s === "specialists" || s === "teams") ? await snapshotRows(ctx, base, "lead_gen_worker", deadline) : [];
            const origins = snapshotSections.includes("top_posts") ? await snapshotRows(ctx, base, "lead_gen_team_origin", deadline) : [];
            if (workers !== null && origins !== null) {
              const snapshotLive = { ...context, teams: leadDashboardTeams(workers) };
              for (const section of snapshotSections) ready(section,
                section === "overview" ? leadDashboardOverview(state.payload!) : section === "top_posts" ? leadDashboardOriginsByTeam(origins) : leadDashboardWorkers(workers),
                state.asOf!, { jobId: snapshotJobId, asOf: state.asOf }, snapshotLive);
            }
          } else for (const section of snapshotSections) results.get(section)!.state = state.state;
          for (const section of snapshotSections) waiting.delete(section);
        }
      }
      if (waiting.size && Date.now() < deadline) await pause(Math.min(250, deadline - Date.now()));
    }
    let bytes = 0;
    let returnedRows = 0;
    for (const section of sections) {
      const result = results.get(section)!;
      if (result.state !== "ready") {
        if (continuation) throw rejectRequest("report.cursor_stale", "This result generation is no longer ready. Start the section again.");
        continue;
      }
      const generation = await sha256Hex(canonicalJson({ version: 1, section, source: result.source, data: result.rows,
        flags: result.cappedFlags, generation: generations.get(section) }));
      if (continuation && continuation.generation !== generation) throw rejectRequest("report.cursor_stale", "This report changed. Start the section again.");
      const offset = continuation?.offset ?? 0;
      if (offset > result.rows.length) throw rejectRequest("report.cursor_invalid", "Invalid report cursor offset.");
      const allRows = result.rows;
      result.rows = [];
      // A call returns at most 50 rows across all sections, and at most 25 per
      // section. Nested posts were flattened above; text is bounded separately.
      for (const row of allRows.slice(offset, offset + 25)) {
        let truncated = false;
        const clean = JSON.parse(JSON.stringify(row, (_key, value) => {
          if (typeof value === "string" && value.length > 500) { truncated = true; return value.slice(0, 500); }
          return value;
        })) as Row;
        const rowBytes = new TextEncoder().encode(JSON.stringify(clean)).length;
        if (bytes + rowBytes > 48 * 1024 || returnedRows >= 50) break;
        bytes += rowBytes;
        result.textTruncated ||= truncated;
        result.rows.push(clean);
        returnedRows++;
      }
      const nextOffset = offset + result.rows.length;
      if (nextOffset < allRows.length) {
        result.capped = true;
        result.cappedFlags.rows = true;
        result.cursor = JSON.stringify({ version: 1, section, binding, generation, offset: nextOffset,
          ...(result.source === "snapshot" ? { snapshotJobId } : {}) } satisfies Cursor);
      }
    }
    await authorize();
    return { sections: sections.map(s => {
      const result = results.get(s)!;
      return { ...result, asOf: result.asOf === null ? null : formatLocal(result.asOf, me.timeZone) };
    }) };
  },
});

type SnapshotRead = {
  state: "ready" | "pending" | "failed" | "rebuilding";
  payload?: Parameters<typeof leadDashboardOverview>[0]; asOf?: number;
  page?: Parameters<typeof leadDashboardWorkers>[0]; isDone?: boolean; continueCursor?: string;
};
async function snapshotRows(ctx: ActionCtx,
  base: { caller: Infer<typeof mcpCallerValidator>; jobId: Id<"operationsReportJobs">; startDayKey: string; endDayKey: string; source?: "instagram" | "meta_business" },
  section: "lead_gen_worker" | "lead_gen_team_origin", deadline: number,
): Promise<Parameters<typeof leadDashboardWorkers>[0] | null> {
  const rows: Parameters<typeof leadDashboardWorkers>[0] = [];
  let cursor: string | null = null;
  do {
    if (Date.now() >= deadline) return null;
    const page: SnapshotRead = JSON.parse(await ctx.runQuery(internal.mcp.tools.leadGenReport.readSnapshot,
      { ...base, section, paginationOpts: { cursor, numItems: 100 } }));
    if (page.state !== "ready" || !page.page) return null;
    rows.push(...page.page);
    // Do not rank or sum an incomplete snapshot. The next invocation can wait
    // for a smaller report; no fabricated team totals leave this call.
    if (rows.length > 8192) return null;
    if (page.isDone) return rows;
    cursor = page.continueCursor!;
  } while (cursor);
  return null;
}
