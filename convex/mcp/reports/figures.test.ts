import aggregate from "@convex-dev/aggregate/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../../_generated/api";
import { scorecardFixture, whole, today, identity, HOUR } from "../../../tests/scorecardFixtures";
import { adminCaller } from "../../../tests/mcpAdminFixtures";
import { attendanceRates, callsFigures, callsLedger, recordTiming, showRateWays } from "../../../app/workspace/reports/calls/_components/calls-data";
import { cashPerWonDeal, groupByWeek, orderOrigins, orderPrograms } from "../../../app/workspace/reports/scorecard/_components/scorecard-shape";
import { buildEveryone, closerMemberFigures, closerMetrics, rosterCounts, roleMemberFigures, setterMetrics, dmMetrics, leadGenMetrics } from "../../../app/workspace/reports/people/_components/people-data";
import { laneViews, responsibleRows, pathRows } from "../../../app/workspace/reports/attribution/_components/attribution-shape";
import { readLivePanel } from "./live";
import { REPORT_PANELS } from "./catalog";
import { safeText, boundPanel, type Json } from "./output";
import { gatewayAnswerBytes, MAX_ASSISTANT_ANSWER_BYTES, type MetricRow } from "../../../lib/assistantReportMerge";
import type { Prepared } from "./planning";
import type { ToolRequest } from "./contracts";
import { ASSISTANT_METRICS, projectNumbers } from "./metrics";
import { isExpectedError } from "../../lib/observability/errors";

const range = { kind: "custom" as const, startDate: whole.startDate, endDateInclusive: whole.endDateInclusive };
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
async function fixture(split = false) {
  vi.useFakeTimers(); vi.setSystemTime(today.fromMs + 10 * HOUR);
  const f = await scorecardFixture();
  aggregate.register(f.t, "resparkResultsByWorker");
  const extra = await f.t.run(async ctx => {
    await ctx.db.patch("tenants", f.tenantId, { mcpAccess: { roles: ["tenant_admin"], changedAt: 0, changedByUserId: f.adminId }, ...(split ? { analyticsReports: ["scorecard", "calls", "people", "attribution", "lead_gen", "qualifications"] } : {}) });
    if (split) await ctx.db.insert("analyticsSync", { beatAt: Date.now(), watermark: Date.now() });
    const at = whole.fromMs + HOUR;
    const memberId = f.memberId;
    const installationId = await ctx.db.insert("slackInstallations", { tenantId: f.tenantId, teamId: "T", teamName: "Test", isEnterpriseInstall: false, appId: "A", botUserId: "B", botAccessToken: "test", scopes: [], installedByWorkosUserId: identity.subject, installedAt: at, tokenExpiresAt: 0, refreshToken: "test", status: "active" });
    const slackId = await ctx.db.insert("slackUsers", { tenantId: f.tenantId, installationId, slackUserId: "parity-setter", slackTeamId: "T", displayName: "Setter", teamMemberId: memberId, isBot: false, isDeleted: false, firstSeenAt: at, lastSeenAt: at, lastSyncedAt: at });
    for (const submittedAt of [at, today.fromMs + HOUR]) await ctx.db.insert("slackQualificationEvents", { tenantId: f.tenantId, installationId, leadId: f.leadA, opportunityId: f.dealA, resultKind: "created_opportunity", qualifiedBy: { slackUserId: "parity-setter", slackTeamId: "T", submittedAt }, slackUserId: "parity-setter", slackTeamId: "T", fullNameSnapshot: "Person", platform: "instagram", handleSnapshot: "test", submittedAt, createdAt: submittedAt });
    for (const weekday of ["friday", "saturday"] as const) await ctx.db.insert("slackQualifierSchedules", { tenantId: f.tenantId, slackUserId: "parity-setter", weekday, scheduledHours: 4, updatedByUserId: f.adminId, updatedAt: at });
    await ctx.db.insert("dealAttributions", { tenantId: f.tenantId, opportunityId: f.dealA, role: "setter", teamMemberId: memberId, attributedAt: at - 1, createdAt: at - 1, source: { kind: "slack_qualification", slackUserId: "parity-setter" } });
    return { slackId, at };
  });
  if (split) { vi.stubEnv("CLICKHOUSE_URL", "https://stub.invalid"); vi.stubEnv("CLICKHOUSE_USER", "stub"); vi.stubEnv("CLICKHOUSE_PASSWORD", "stub"); }
  return { ...f, ...extra, caller: adminCaller(identity.org_id, "test", identity.subject) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function warehouse(f: Fixture, request: ToolRequest) {
  const plan: Prepared = JSON.parse(await f.t.query(internal.mcp.reports.planning.prepare, { caller: f.caller, request }));
  await f.t.run(async ctx => {
    for (const input of plan.inputs) if (input.job) {
      const job = input.job;
      const exists = await ctx.db.query("mcpReportRequests").withIndex("by_tenantId_and_key", q => q.eq("tenantId", f.tenantId).eq("key", job.key)).unique();
      if (!exists) await ctx.db.insert("mcpReportRequests", { tenantId: f.tenantId, userId: f.adminId, key: job.key, report: job.report, kind: "job", paramsJson: JSON.stringify(job), status: "ready", resultJson: JSON.stringify(await readLivePanel(ctx, f.tenantId, input.id, input.filters, job.window)), watermark: Date.now(), createdAt: Date.now(), expiresAt: Date.now() + HOUR });
    }
  });
  return plan;
}
const panel = (result: Record<string, unknown>, id: string) => (result.panels as Array<{ id: string; data: Record<string, unknown>; figures: Record<string, unknown>; lowerBound?: boolean }>).find(p => p.id === id)!;
const scalars = (result: Record<string, unknown>) => (result.rows as { periods: { metrics: MetricRow[] }[] }[]).flatMap(g => g.periods.flatMap(p => p.metrics));

for (const split of [false, true]) describe(`page figures, ${split ? "warehouse + live" : "live"}`, () => {
  it("derives Calls from every recording sample before the output bound", async () => {
    const f = await fixture(split);
    await f.t.run(async ctx => {
      for (let i = 0; i < 40; i++) {
        const { _id: _id, _creationTime: _time, ...base } = f.meetings[0];
        const scheduledAt = i < 20 ? whole.fromMs + HOUR : today.fromMs + HOUR;
        await ctx.db.insert("meetings", { ...base, scheduledAt, status: "held", heldMarkedAt: scheduledAt + (30 + i * 100) * 60_000 });
      }
    });
    const request = { kind: "report" as const, report: "calls" as const, range, limit: 25 };
    await warehouse(f, request);
    const page = await f.t.withIdentity(identity).query(api.reports.calls.getCallsSummary, { startDate: whole.fromMs, endDate: whole.toMs });
    expect(page.recordMinutes).toHaveLength(40);
    const result = await f.t.action(internal.mcp.reports.tools.report, { caller: f.caller, report: "calls", range, limit: 25 });
    expect(result.status).toBe("ready");
    const p = panel(result, "calls.summary");
    const omitted: Json[] = [];
    expect(p.figures).toEqual(boundPanel(safeText(callsFigures(page) as Json), 25, true, omitted));
    expect(p.figures).toMatchObject({ timeToRecord: recordTiming(page.recordMinutes).median, recordingSamples: 40, resultsAtLeastOneDayLate: recordTiming(page.recordMinutes).late, ledger: safeText(callsLedger(page.counts)), showRate: attendanceRates(page.counts).showRate });
    expect((p.data.recordMinutes as number[]).length).toBeLessThan(40);
    expect(p.figures.firstCallShowRate).toEqual(showRateWays(page).find(r => r.key === "first")!.rate);
    expect(gatewayAnswerBytes(result)).toBeLessThanOrEqual(MAX_ASSISTANT_ANSWER_BYTES);
  });
  it("matches Scorecard, People and Attribution page shaping on the same readers", async () => {
    const f = await fixture(split);
    const web = f.t.withIdentity(identity);
    const funnel = await web.query(api.reports.scorecard.funnel, { range: whole });
    const cash = await web.query(api.reports.scorecard.cash, { range: whole });
    const tasks = await web.query(api.reports.scorecard.followThrough, { range: whole });
    const origins = await web.query(api.reports.scorecard.origins, { range: whole });
    const answers = await web.query(api.reports.scorecard.answers, { range: whole, fieldKey: "budget" });
    const closers = await web.query(api.reports.people.getPeopleClosers, { startDate: whole.fromMs, endDate: whole.toMs });
    const setters = await web.query(api.reports.peopleRoles.getSetters, { startDate: whole.fromMs, endDate: whole.toMs });
    const dmClosers = await web.query(api.reports.peopleRoles.getDmClosers, { startDate: whole.fromMs, endDate: whole.toMs });
    const leadGen = await web.query(api.reports.peopleRoles.getLeadGen, { startDate: whole.fromMs, endDate: whole.toMs });
    const members = await web.query(api.reports.member.listReportMembers, {});
    const lanes = await web.query(api.reports.attribution.getLanes, { startDate: whole.fromMs, endDate: whole.toMs });
    const paths = await web.query(api.reports.attribution.getPaths, { startDate: whole.fromMs, endDate: whole.toMs });
    for (const report of ["scorecard", "people", "attribution"] as const) {
      await warehouse(f, { kind: "report", report, range, currency: "USD" });
      for (const id of REPORT_PANELS[report]) {
        const result = await f.t.action(internal.mcp.reports.tools.report, { caller: f.caller, report, ...(id === "people.members" ? {} : { panel: id }), range, currency: "USD", limit: 25 });
        expect(result.status, JSON.stringify(result)).toBe("ready");
        const p = panel(result, id);
        if (id === "scorecard.funnel") expect(p.figures).toMatchObject({ weeks: groupByWeek(funnel.byDay).map(w => ({...w,cash:w.cash.filter(c=>c.currency==="USD")})), cohortShares: Object.fromEntries(Object.entries(funnel.cohort).map(([k,v]) => [k, funnel.cohort.entered ? v / funnel.cohort.entered : null])) });
        if (id === "scorecard.cash") expect(p.figures).toMatchObject({ cashPerWonDeal: cashPerWonDeal(cash.currencies.find(c => c.currency === "USD")!) });
        if (id === "scorecard.follow_through") expect(p.figures.tasksOnTime).toBe(tasks.onTime / tasks.due);
        if (id === "scorecard.answers") expect(p.figures.answers).toEqual(safeText(answers.answers.map(r => ({ answer: r.answer, heldShare: r.people ? r.held / r.people : null, wonShare: r.people ? r.won / r.people : null }))));
        if (id === "scorecard.origins") expect(p.data.origins).toEqual(safeText(orderOrigins(origins.origins, "USD").map(r => ({...r,cash:r.cash.filter(c=>c.currency==="USD")}))));
        if (id === "scorecard.cash") expect((p.data.currencies as {byProgram: unknown}[])[0].byProgram).toEqual(safeText(orderPrograms(cash.currencies.find(c => c.currency === "USD")!.byProgram)));
        if (id === "people.members") {
          expect(p.figures.roleTabCounts).toEqual(rosterCounts(members.members, { closers, setters, dmClosers, leadGen }));
          expect((p.figures.everyone as {teamMemberId:string}[]).map(r => r.teamMemberId)).toEqual(buildEveryone(members.members, { closers, setters, dmClosers, leadGen }).everyone.map(r => r.teamMemberId));
        }
        if (id === "people.closers") expect(p.figures.rows).toEqual(closers.rows.map(r => ({ userId: r.userId, teamMemberId: r.teamMemberId, callsDue: r.due, held: r.held, noShow: r.noShow, resultsRecorded: r.held+r.noShow, cohortWon:r.cohortWon,cohortDeals:r.cohortDeals,payments:r.payments, notRecorded: r.notRecorded, showRate: closerMetrics(r,"USD").showRate, recorded: closerMetrics(r,"USD").recordedRate, closeRate: closerMetrics(r,"USD").closeRate, dealsWon: r.dealsWon, cash: closerMetrics(r,"USD").cashMinor, finalCash: closerMetrics(r,"USD").finalMinor, creditedCash: closerMetrics(r,"USD").cashMinor, timeToRecord: closerMetrics(r,"USD").toRecord })));
        if (id === "attribution.lanes") {
          expect((p.figures.people as {key:string}[]).map(r => r.key)).toEqual(responsibleRows(lanes,"USD").map(r => r.key));
          expect((p.figures.lanes as {topFive: {key:string}[]}[]).map(r => r.topFive.map(r=>r.key))).toEqual(laneViews(lanes,"USD").map(r=>r.people.slice(0,5).map(r=>r.key)));
        }
        if (id === "attribution.paths") expect((p.figures.paths as {dealCount:number}[]).map(r=>r.dealCount)).toEqual(pathRows(paths,"USD").map(r=>r.dealIds.length));
      }
    }
  });
  it("returns the member page's team median for every figure", async () => {
    const f = await fixture(split);
    const request = { kind: "report" as const, report: "people" as const, memberId: f.memberId, range, currency: "USD" };
    const plan = await warehouse(f, request);
    expect(plan.inputs.some(i => i.team && !i.filters.memberId)).toBe(true);
    const result = await f.t.action(internal.mcp.reports.tools.report, { caller: f.caller, report: "people", memberId: f.memberId, range, currency: "USD" });
    expect(result.status, JSON.stringify(result)).toBe("ready");
    const web = f.t.withIdentity(identity);
    const team = await web.query(api.reports.people.getPeopleClosers, { startDate: whole.fromMs, endDate: whole.toMs });
    for (const figure of closerMemberFigures(team.rows.find(r=>r.teamMemberId===f.memberId)!, team.rows, "USD")) expect(panel(result,"people.closers").figures[figure.term ?? figure.key]).toEqual({ value: figure.value, teamMedian: figure.teamMedian });
    const setters = await web.query(api.reports.peopleRoles.getSetters, { startDate: whole.fromMs, endDate: whole.toMs });
    for (const figure of roleMemberFigures("setter",setters.rows.find(r=>r.teamMemberId===f.memberId)!,setters.rows,"USD")) expect(panel(result,"people.setters").figures[figure.term ?? figure.key]).toEqual({value:figure.value,teamMedian:figure.teamMedian});
  });
  it("projects every dictionary term from the page, with no API metric job", async () => {
    const f = await fixture(split);
    const web = f.t.withIdentity(identity);
    const calls = await web.query(api.reports.calls.getCallsSummary, { startDate: whole.fromMs, endDate: whole.toMs });
    const cash = await web.query(api.reports.scorecard.cash, { range: whole });
    const funnel = await web.query(api.reports.scorecard.funnel, { range: whole });
    const tasks = await web.query(api.reports.scorecard.followThrough, { range: whole });
    const closer = await web.query(api.reports.people.getPeopleClosers, { startDate: whole.fromMs, endDate: whole.toMs, memberId:f.memberId });
    const setter = await web.query(api.reports.peopleRoles.getSetters, { startDate: whole.fromMs, endDate: whole.toMs, memberId:f.memberId });
    const lanes = await web.query(api.reports.attribution.getLanes, { startDate: whole.fromMs, endDate: whole.toMs });
    const overview = await web.query(api.leadGen.reporting.getOverview, { startDayKey:whole.startDate,endDayKey:whole.endDateInclusive });
    const qualifications = await web.query(api.operations.qualificationsDashboard.getQualificationsDashboard,{range:{kind:"custom",startBusinessDate:whole.startDate,endBusinessDateInclusive:whole.endDateInclusive}});
    const resparks = await web.query(api.leadGen.resparkReports.listResparkPerformance,{startDayKey:whole.startDate,endDayKey:whole.endDateInclusive});
    const expected: Record<string,number|null> = { ...Object.fromEntries(Object.entries(callsFigures(calls)).filter(([,v])=>v===null||typeof v==="number")), bookingsMade:funnel.activity.bookingsMade, dealsWon:funnel.activity.dealsWon,
      cash:cash.currencies.find(c=>c.currency==="USD")!.cashMinor,finalCash:cash.currencies.find(c=>c.currency==="USD")!.finalMinor,cashPerWonDeal:cashPerWonDeal(cash.currencies.find(c=>c.currency==="USD")!),
      closeRate:closerMetrics(closer.rows[0],"USD").closeRate,creditedCash:closerMetrics(closer.rows[0],"USD").cashMinor,
      shared:laneViews(lanes,"USD").find(l=>l.role==="closer")!.sharedMinor, attributionCoverage:laneViews(lanes,"USD").find(l=>l.role==="closer")!.coverage,
      perScheduledHour:setterMetrics(setter.rows[0],"USD").perHour,bookRate:setterMetrics(setter.rows[0],"USD").bookRate,tasksOnTime:tasks.onTime/tasks.due,
      captures:overview.submissions,prospectDays:overview.uniqueProspects,qualificationEvents:qualifications.totalQualified,resparks:resparks.rows.reduce((s,r)=>s+r.resparks,0) };
    for (const metric of ASSISTANT_METRICS) {
      const args = { metrics:[metric], range, currency:"USD", ...(["shared","attributionCoverage"].includes(metric)?{role:"closers" as const}:{}), ...(metric==="creditedCash"?{role:"closers" as const,memberId:f.memberId}:{}), ...(["perScheduledHour","bookRate"].includes(metric)?{role:"setters" as const,memberId:f.memberId}:{}) };
      const plan = await warehouse(f,{kind:"numbers",...args});
      expect(plan.inputs.every(i=>i.id!=="mcp.metrics")).toBe(true);
      const result=await f.t.action(internal.mcp.reports.tools.numbers,{caller:f.caller,...args});
      expect(result.status,`${metric}: ${JSON.stringify(result)}`).toBe("ready");
      expect(scalars(result)[0].value,metric).toEqual(expected[metric]);
      if(metric==="timeToRecord") expect(scalars(result)[0].unit).toBe("minutes");
    }
  });
});

describe("page projection constraints", () => {
  it("keeps the full People page and selected role tab counts within the gateway cap", async () => {
    const f = await fixture();
    for (const role of [undefined, "closers", "setters", "dm_closers", "lead_gen"] as const) {
      const result = await f.t.action(internal.mcp.reports.tools.report, { caller: f.caller, report: "people", range, role });
      expect(result.status, JSON.stringify(result)).toBe("ready");
      expect(gatewayAnswerBytes(result)).toBeLessThanOrEqual(MAX_ASSISTANT_ANSWER_BYTES);
      if (role) expect(panel(result, `people.${role}`).figures).toHaveProperty("roleTabCounts");
    }
  });
  it("merges a split like the page and marks figures from a partial window as lower bounds", async () => {
    const f = await fixture(true);
    const request = { kind:"numbers" as const, metrics:["callsDue" as const,"showRate" as const],range };
    const plan = await warehouse(f,request);
    await f.t.run(async ctx => {
      const job=plan.inputs.find(i=>i.job)!.job!;
      const row=await ctx.db.query("mcpReportRequests").withIndex("by_tenantId_and_key",q=>q.eq("tenantId",f.tenantId).eq("key",job.key)).unique();
      await ctx.db.patch("mcpReportRequests",row!._id,{resultJson:JSON.stringify({...JSON.parse(row!.resultJson!),partial:true})});
    });
    const result=await f.t.action(internal.mcp.reports.tools.numbers,{caller:f.caller,metrics:request.metrics,range});
    expect(scalars(result).every(r=>r.value!==null&&r.lowerBound===true)).toBe(true);
    const report=await f.t.action(internal.mcp.reports.tools.report,{caller:f.caller,report:"calls",range});
    expect(panel(report,"calls.summary")).toMatchObject({lowerBound:true});
    expect(panel(report,"calls.summary").data).toBeTruthy();
  });
  it("reads a comparison period in the current period's currency", async () => {
    const f = await fixture();
    await f.t.run(async ctx => {
      const at = whole.fromMs - 30 * HOUR;
      const pay = (currency: string, amountMinor: number) => ctx.db.insert("paymentRecords", { tenantId: f.tenantId, opportunityId: f.dealA, attributedCloserId: f.closerId, amountMinor, currency, recordedByUserId: f.adminId, programId: f.programId, programName: "Program", paymentType: "pif", status: "verified", recordedAt: at, origin: "closer_meeting" });
      await pay("USD", 50000);
      for (let i = 0; i < 3; i++) await pay("EUR", 400000);
    });
    const result = await f.t.action(internal.mcp.reports.tools.numbers, { caller: f.caller, metrics: ["cash"], range, compareTo: "previous_period" });
    const cash = scalars(result).find(r => r.id === "cash")! as MetricRow & { delta?: number };
    expect(cash.currency).toBe("USD");
    expect(cash.delta).toBe((cash.value ?? 0) - 50000);
  });
  it("loads every panel the Scorecard weighs to choose its currency", async () => {
    const f = await fixture();
    const plan: Prepared = JSON.parse(await f.t.query(internal.mcp.reports.planning.prepare, { caller: f.caller, request: { kind: "numbers", metrics: ["cash"], range, groupBy: "day" } }));
    expect(new Set(plan.inputs.map(i => i.id))).toEqual(new Set(["scorecard.funnel", "scorecard.cash", "scorecard.origins"]));
  });
  it("compares the same page dependencies and deduplicates each panel per period", async () => {
    const f=await fixture(true);
    const request={kind:"numbers" as const,metrics:["callsDue" as const,"showRate" as const,"recorded" as const],range,compareTo:"previous_period" as const};
    const plan=await warehouse(f,request);
    expect(plan.inputs.every(i=>i.id==="calls.summary")).toBe(true);
    expect(new Set(plan.inputs.map(i=>JSON.stringify([i.id,i.period,i.filters,i.window.window.startDate,i.window.window.endDateInclusive]))).size).toBe(plan.inputs.length);
    const result=await f.t.action(internal.mcp.reports.tools.numbers,{caller:f.caller,metrics:request.metrics,range,compareTo:request.compareTo});
    expect(result.status).toBe("ready");
    expect(scalars(result).find(r=>r.id==="callsDue")).toMatchObject({value:3,delta:3,deltaUnit:"count"});
  });
  it("supports only builder-backed closer, program and day groupings and names won-deal scope", async () => {
    const f=await fixture();
    for(const groupBy of ["closer","program","day"] as const){
      const result=await f.t.action(internal.mcp.reports.tools.numbers,{caller:f.caller,metrics:["dealsWon"],range,groupBy,currency:"USD"});
      expect(result.status).toBe("ready");
      expect(scalars(result).every(r=>r.scope===(groupBy==="closer"?"first_payment_closer":groupBy==="program"?"sold_program":"booked_program_activity"))).toBe(true);
    }
    for (const [metric,groupBy] of [["closeRate","day"],["callsScheduled","program"],["cash","team"]] as const) await expect(f.t.action(internal.mcp.reports.tools.numbers,{caller:f.caller,metrics:[metric],range,groupBy})).rejects.toThrow(/page|supported/);
    await expect(f.t.action(internal.mcp.reports.tools.numbers,{caller:f.caller,metrics:["creditedCash"],range})).rejects.toThrow("role");
    const laneResult=await f.t.action(internal.mcp.reports.tools.numbers,{caller:f.caller,metrics:["creditedCash"],role:"closers",currency:"USD",range});
    const lanes=await f.t.withIdentity(identity).query(api.reports.attribution.getLanes,{startDate:whole.fromMs,endDate:whole.toMs});
    expect(scalars(laneResult)[0]).toMatchObject({value:laneViews(lanes,"USD").find(r=>r.role==="closer")!.laneMinor,scope:"role_lane"});
    await expect(f.t.action(internal.mcp.reports.tools.numbers,{caller:f.caller,metrics:["perScheduledHour"],role:"setters",range})).rejects.toThrow("memberId");
  });
});

it("returns each role's page metrics on a seeded member who works all four roles", async () => {
  const f = await fixture();
  await f.t.run(async ctx => {
    const at = whole.fromMs + HOUR;
    const teamId = await ctx.db.insert("attributionTeams", {tenantId:f.tenantId,slug:"parity",displayName:"Parity",utmSource:"parity",normalizedUtmSource:"parity",isActive:true,createdAt:at,updatedAt:at});
    const dmCloserId = await ctx.db.insert("dmClosers", {tenantId:f.tenantId,teamId,slug:"parity",displayName:"Parity",utmMedium:"parity",normalizedUtmMedium:"parity",isActive:true,createdAt:at,updatedAt:at,teamMemberId:f.memberId});
    const workerId = await ctx.db.insert("leadGenWorkers", {tenantId:f.tenantId,userId:f.closerId,workosUserId:"score_closer",email:"test@example.invalid",isActive:true,createdAt:at,updatedAt:at,teamMemberId:f.memberId});
    const prospectId = await ctx.db.insert("leadGenProspects", {tenantId:f.tenantId,firstSource:"instagram",latestSource:"instagram",dedupeKey:"parity",normalizedHandle:"parity",rawHandle:"parity",profileUrl:"https://example.invalid/parity",firstCapturedByWorkerId:workerId,firstCapturedAt:at,lastSubmittedByWorkerId:workerId,lastSubmittedAt:at,latestOriginKind:"source_only",contactAttemptCount:0,distinctWorkerCount:1,leadId:f.leadA,createdAt:at,updatedAt:at});
    for(const submittedAt of [at,today.fromMs+HOUR]) await ctx.db.insert("leadGenSubmissions",{tenantId:f.tenantId,prospectId,workerId,userId:f.closerId,source:"instagram",originKind:"source_only",originRankable:false,submittedAt,createdAt:submittedAt});
    const eventId = await ctx.db.insert("domainEvents", {tenantId:f.tenantId,entityType:"lead",entityId:f.leadA,leadId:f.leadA,eventType:"lead.captured",source:"system",occurredAt:at});
    await ctx.db.insert("dealAttributions",{tenantId:f.tenantId,opportunityId:f.dealA,role:"lead_gen",teamMemberId:f.memberId,attributedAt:at-1,createdAt:at-1,source:{kind:"capture",workerId,prospectId,eventId}});
    await ctx.db.insert("dealAttributions",{tenantId:f.tenantId,opportunityId:f.dealA,meetingId:f.meetingA,role:"dm_closer",teamMemberId:f.memberId,attributedAt:at-1,createdAt:at-1,source:{kind:"booking_utm",dmCloserId}});
    for(const weekday of ["friday","saturday"] as const){
      await ctx.db.insert("dmCloserSchedules",{tenantId:f.tenantId,dmCloserId,weekday,scheduledHours:2,updatedByUserId:f.adminId,updatedAt:at});
      await ctx.db.insert("leadGenWorkerSchedules",{tenantId:f.tenantId,workerId,userId:f.closerId,weekday,scheduledHours:2,updatedByUserId:f.adminId,updatedAt:at});
    }
  });
  for (const [role,ref,id,metrics] of [
    ["setter",api.reports.peopleRoles.getSetters,"people.setters",setterMetrics],
    ["dm_closer",api.reports.peopleRoles.getDmClosers,"people.dm_closers",dmMetrics],
    ["lead_gen",api.reports.peopleRoles.getLeadGen,"people.lead_gen",leadGenMetrics],
  ] as const) {
    const page = await f.t.withIdentity(identity).query(ref,{startDate:whole.fromMs,endDate:whole.toMs});
    const row=page.rows.find(r=>r.teamMemberId===f.memberId)!;
    expect(metrics(row,"USD").perHour).not.toBeNull();
    const result=await f.t.action(internal.mcp.reports.tools.report,{caller:f.caller,report:"people",panel:id,memberId:f.memberId,range,currency:"USD"});
    expect(result.status,JSON.stringify(result)).toBe("ready");
    for(const figure of roleMemberFigures(role,row,page.rows,"USD")) expect(panel(result,id).figures[figure.term??figure.key]).toEqual({value:figure.value,teamMedian:figure.teamMedian});
  }
  const result=await f.t.action(internal.mcp.reports.tools.report,{caller:f.caller,report:"people",memberId:f.memberId,range,currency:"USD"});
  expect(result.status,JSON.stringify(result)).toBe("ready");
});

describe("refusals the agent can read", () => {
  it("refuses an unsupported request with a readable code and message", async () => {
    const f = await fixture();
    const error = await f.t.action(internal.mcp.reports.tools.numbers, { caller: f.caller, metrics: ["bookRate"], role: "setters", range }).catch((e: unknown) => e);
    expect(isExpectedError(error)).toBe(true);
    expect((error as { data: { code: string; message: string } }).data).toMatchObject({ code: "report.invalid_request", message: "bookRate is a person's page figure. Choose memberId." });
  });
  it("refuses a reversed, overlong or malformed range in words the agent can read", async () => {
    const f = await fixture();
    for (const [startDate, endDateInclusive, message] of [
      ["2026-10-31", "2026-10-01", "Choose an end date on or after the start date."],
      ["2023-01-01", "2026-10-31", "Choose 731 days or fewer."],
      ["2026-02-30", "2026-03-01", "Use real dates as YYYY-MM-DD."],
    ] as const) {
      const error = await f.t.action(internal.mcp.reports.tools.numbers, { caller: f.caller, metrics: ["callsDue"], range: { kind: "custom", startDate, endDateInclusive } }).catch((e: unknown) => e);
      expect(isExpectedError(error)).toBe(true);
      expect((error as { data: { code: string; message: string } }).data).toMatchObject({ code: "report.invalid_request", message });
    }
  });
  it("leaves an unexpected failure as an error, never a refusal", async () => {
    const f = await fixture();
    // A duplicate user row makes access resolution fail: a bug, not a refusal.
    await f.t.run(async ctx => {
      const admin = (await ctx.db.get("users", f.adminId))!;
      const { _id, _creationTime, ...copy } = admin;
      void _id; void _creationTime;
      await ctx.db.insert("users", copy);
    });
    const error = await f.t.action(internal.mcp.reports.tools.numbers, { caller: f.caller, metrics: ["callsDue"], range }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(isExpectedError(error)).toBe(false);
  });
});

it("keeps a term's unit and currency when its input is missing", () => {
  const rows = projectNumbers(new Map(), { metrics: ["perScheduledHour", "cash"], range, role: "setters", memberId: "m", currency: "USD" } as never);
  expect(rows.find(r => r.id === "perScheduledHour")).toMatchObject({ unit: "per_hour", nullReason: "incomplete_input" });
  expect(rows.find(r => r.id === "cash")).toMatchObject({ unit: "minor", currency: "USD", nullReason: "incomplete_input" });
});

describe("admin report regressions", () => {
  it("refuses explicit scopes that closer grouping cannot honor", async () => {
    const f = await fixture();
    for (const scope of ["sold_program", "booked_program_activity"] as const) {
      const error = await f.t.action(internal.mcp.reports.tools.numbers, { caller: f.caller, metrics: ["dealsWon"], scope, groupBy: "closer", range }).catch((e: unknown) => e);
      expect(isExpectedError(error)).toBe(true);
      expect(String(error)).toContain("first_payment_closer");
    }
  });
  it("refuses members outside the requested or default setter role", async () => {
    const f = await fixture();
    await f.t.run(ctx => ctx.db.patch("slackUsers", f.slackId, { teamMemberId: undefined }));
    for (const metric of ["perScheduledHour", "bookRate"] as const) {
      const error = await f.t.action(internal.mcp.reports.tools.numbers, { caller: f.caller, metrics: [metric], memberId: f.memberId, ...(metric === "perScheduledHour" ? { role: "setters" as const } : {}), range }).catch((e: unknown) => e);
      expect(isExpectedError(error)).toBe(true);
      expect(String(error)).toContain("isn't in the setter role");
    }
  });
  it("refuses unavailable currencies and names the available currencies", async () => {
    const f = await fixture();
    for (const call of [
      () => f.t.action(internal.mcp.reports.tools.numbers, { caller: f.caller, metrics: ["cash"], currency: "XYZ", range }),
      () => f.t.action(internal.mcp.reports.tools.report, { caller: f.caller, report: "scorecard", currency: "XYZ", range }),
    ]) {
      const error = await call().catch((e: unknown) => e);
      expect(isExpectedError(error)).toBe(true);
      expect(String(error)).toMatch(/XYZ.*Available currencies:.*USD/);
    }
  });
  it("accepts any currency for a selected panel without money inputs", async () => {
    const f = await fixture();
    const answer = await f.t.action(internal.mcp.reports.tools.report, { caller: f.caller, report: "scorecard", panel: "follow_through", currency: "EUR", range });
    expect(answer.status).not.toBe("unavailable");
  });
  it("answers malformed and wrong-table report IDs with a readable error", async () => {
    const f = await fixture();
    for (const call of [
      () => f.t.action(internal.mcp.reports.tools.numbers, { caller: f.caller, metrics: ["cash"], programId: "not-an-id", range }),
      () => f.t.action(internal.mcp.reports.tools.report, { caller: f.caller, report: "lead_gen", teamId: f.memberId, range }),
      () => f.t.action(internal.mcp.reports.tools.report, { caller: f.caller, report: "calls", closerId: f.memberId, range }),
    ]) {
      const error = await call().catch((e: unknown) => e);
      expect(isExpectedError(error)).toBe(true);
      expect(String(error)).toContain("mcp.invalid_argument");
    }
  });
  it("refuses unknown and malformed field keys with a readable report error", async () => {
    const f = await fixture();
    for (const fieldKey of ["unknown", "   ", "x".repeat(501)]) {
      const error = await f.t.action(internal.mcp.reports.tools.report, { caller: f.caller, report: "scorecard", fieldKey, range }).catch((e: unknown) => e);
      expect(isExpectedError(error)).toBe(true);
      expect(String(error)).toContain("report.invalid_request");
      expect(String(error)).toContain(fieldKey === "unknown" ? "budget" : "report_fields");
    }
  });
  it("counts the comparison range's own day cells before loading panels", async () => {
    const f = await fixture();
    const error = await f.t.action(internal.mcp.reports.tools.numbers, { caller: f.caller, metrics: ["bookingsMade"], groupBy: "day", range: { kind: "preset", preset: "today" }, compareTo: { kind: "custom", startDate: "2026-11-10", endDateInclusive: "2027-01-09" } }).catch((e: unknown) => e);
    expect(isExpectedError(error)).toBe(true);
    expect(String(error)).toContain("60 period");
    expect(await f.t.run(ctx => ctx.db.query("mcpReportRequests").take(1))).toHaveLength(0);
  });
  it("refuses an empty through-yesterday preset on its first day", async () => {
    const f = await fixture();
    for (const [preset, now] of [["this_week", "2026-11-09"], ["this_month", "2026-11-01"]] as const) {
      vi.setSystemTime(Date.parse(`${now}T18:00:00Z`));
      const error = await f.t.action(internal.mcp.reports.tools.report, { caller: f.caller, report: "calls", range: { kind: "preset", preset, throughYesterday: true } }).catch((e: unknown) => e);
      expect(isExpectedError(error)).toBe(true);
      expect(String(error)).toContain("no days before today");
    }
  });
  it("plans a selected live roster or follow-through panel without unrelated warehouse panels", async () => {
    const f = await fixture(true);
    for (const [report, id] of [["people", "people.members"], ["scorecard", "scorecard.follow_through"]] as const) {
      const prepared: Prepared = JSON.parse(await f.t.query(internal.mcp.reports.planning.prepare, { caller: f.caller, request: { kind: "report", report, panel: id, range } }));
      expect([...new Set(prepared.inputs.map(input => input.id))]).toEqual([id]);
      if (report === "people") {
        expect(prepared.inputs.every(input => !input.job)).toBe(true);
        const result = await f.t.action(internal.mcp.reports.tools.report, { caller: f.caller, report, panel: id, range });
        expect(result.status).toBe("ready");
      }
    }
  });
  it("labels grouped closers with an untrusted display name", async () => {
    const f = await fixture();
    const result = await f.t.action(internal.mcp.reports.tools.numbers, { caller: f.caller, metrics: ["dealsWon", "cash"], groupBy: "closer", currency: "USD", range });
    expect(result.status).toBe("ready");
    expect(result.rows).toEqual(expect.arrayContaining([expect.objectContaining({ group: f.closerId, label: { text: "Assigned closer", by: "closer" } })]));
  });
  it("names comparison-only groups separately from a row limit", async () => {
    const f = await fixture(true);
    const request = { kind: "numbers" as const, metrics: ["cash" as const], groupBy: "program" as const, currency: "USD", range: { kind: "custom" as const, startDate: "2026-10-01", endDateInclusive: "2026-10-02" }, compareTo: "previous_period" as const };
    const plan = await warehouse(f, request);
    await f.t.run(async ctx => {
      for (const input of plan.inputs) {
        const job = input.job!;
        const row = await ctx.db.query("mcpReportRequests").withIndex("by_tenantId_and_key", q => q.eq("tenantId", f.tenantId).eq("key", job.key)).unique();
        if (input.id === "scorecard.cash") await ctx.db.patch("mcpReportRequests", row!._id, { resultJson: JSON.stringify({ currencies: [{ currency: "USD", cashMinor: 100, finalMinor: 100, dealsWon: 1, byProgram: [{ programId: input.period === "current" ? "current" : "past", programName: "Program", cashMinor: 100, finalMinor: 100, dealsWon: 1, payments: 1 }], byPaymentType: [] }], isTruncated: false }) });
      }
    });
    const { kind: _kind, ...args } = request;
    const result = await f.t.action(internal.mcp.reports.tools.numbers, { caller: f.caller, ...args });
    expect(result.status).toBe("ready");
    expect(result.reasons).toContain("comparison_only_groups");
    expect(result.reasons).not.toContain("row_limit");
    expect(result.comparisonOmitted).toMatchObject({ groups: 1 });
  });
});
