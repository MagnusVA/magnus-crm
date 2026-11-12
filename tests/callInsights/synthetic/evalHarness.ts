import { anyApi, type ApiFromModules } from "convex/server";
import type { Doc, Id } from "../../../convex/_generated/dataModel";
import { callInsightsHarness } from "../../callInsightsHarness";
import { servingConfig } from "../../../convex/callInsights/settings";
import * as casesApi from "../../../convex/callInsights/eval/cases";
import * as labelsApi from "../../../convex/callInsights/eval/labels";
import * as reportsApi from "../../../convex/callInsights/eval/reports";
import * as waitApi from "../../../convex/callInsights/eval/waitStudy";

type EvalApi = ApiFromModules<{
  "callInsights/eval/cases": typeof casesApi;
  "callInsights/eval/labels": typeof labelsApi;
  "callInsights/eval/reports": typeof reportsApi;
  "callInsights/eval/waitStudy": typeof waitApi;
}>;
const functions = (anyApi as unknown as EvalApi).callInsights.eval;
export const api = {
  cases: functions.cases,
  labels: functions.labels,
  reports: functions.reports,
  wait: functions.waitStudy,
};
export type EvalHarness = Awaited<ReturnType<typeof evalHarness>>;
export const TEST_ITEM = {
  key: "objection:0",
  kind: "objection" as const,
  category: "partner",
  statement: "Needs partner agreement",
  quote: "I need my husband's okay before I buy",
  lineIndex: 3,
  atSeconds: 60,
  resolution: "unresolved" as const,
  check: "confirmed" as const,
};

export async function evalHarness(
  opts: Parameters<typeof callInsightsHarness>[0] = {},
) {
  const f = await callInsightsHarness(opts);
  const ids = await f.t.run(async (ctx) => {
    const tenant = await ctx.db.get("tenants", f.tenantId);
    const meeting = await ctx.db.get("meetings", f.meetingId);
    const runId = await ctx.db.insert("callInsightRuns", {
      tenantId: f.tenantId,
      meetingId: f.meetingId,
      recordingId: f.recordingId,
      purpose: "serve",
      generation: 1,
      inputKey: `${f.recordingId}:serve:1`,
      trigger: "recording_matched",
      kind: "full",
      status: "answered",
      attempt: 1,
      config: servingConfig(tenant!.callInsights!),
      items: [TEST_ITEM],
      receipts: [],
      createdAt: Date.now(),
      finishedAt: Date.now(),
    });
    const headerId = await ctx.db.insert("callInsightFacts", {
      tenantId: f.tenantId,
      meetingId: f.meetingId,
      recordingId: f.recordingId,
      kind: "call",
      active: true,
      publicationRevision: 1,
      latestStatus: "answered",
      publishedRunId: runId,
      expectedItemCount: 1,
      scheduledAt: meeting!.scheduledAt,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startOffsetSeconds: 0,
      endOffsetSeconds: 1200,
      prospectFirstLineOffsetSeconds: 60,
      prospectIdentity: "email_matched",
    });
    const suggestionId = await ctx.db.insert("resultSuggestionStates", {
      tenantId: f.tenantId,
      meetingId: f.meetingId,
      recordingId: f.recordingId,
      runId,
      revision: 1,
      kind: "paid",
      tier: "ready",
      values: { amountMinor: 170000, currency: "USD", currencyAssumed: true },
      quotes: [],
      notes: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return { runId, headerId, suggestionId };
  });
  return { ...f, ...ids };
}
export async function addCall(
  f: EvalHarness,
  order: number,
  opts: { samePerson?: boolean; expiresAt?: number; published?: boolean } = {},
) {
  return f.t.run(async (ctx) => {
    const lead = await ctx.db.get("leads", f.leadId);
    const deal = await ctx.db.get("opportunities", f.opportunityId);
    const meeting = await ctx.db.get("meetings", f.meetingId);
    const recording = await ctx.db.get("callRecordings", f.recordingId);
    const run = await ctx.db.get("callInsightRuns", f.runId);
    const strip = <T extends { _id: unknown; _creationTime: number }>(
      row: T,
    ) => {
      const { _id: _unused, _creationTime: _time, ...fields } = row;
      return fields;
    };
    const leadId = opts.samePerson
      ? f.leadId
      : await ctx.db.insert("leads", {
          ...strip(lead!),
          fullName: `Person ${order}`,
        });
    const opportunityId = await ctx.db.insert("opportunities", {
      ...strip(deal!),
      leadId,
    });
    const meetingId = await ctx.db.insert("meetings", {
      ...strip(meeting!),
      opportunityId,
      scheduledAt: meeting!.scheduledAt + order * 1000,
    });
    const recordingId = await ctx.db.insert("callRecordings", {
      ...strip(recording!),
      meetingId,
      fathomRecordingId: order + 100,
      transcriptExpiresAt: opts.expiresAt ?? Date.now() + 80 * 86_400_000,
    });
    const runId = await ctx.db.insert("callInsightRuns", {
      ...strip(run!),
      meetingId,
      recordingId,
      inputKey: `${recordingId}:serve:1`,
    });
    const header = await ctx.db.get("callInsightFacts", f.headerId);
    if (header?.kind !== "call") throw new Error("Missing fixture header");
    const headerId = await ctx.db.insert("callInsightFacts", {
      ...strip(header),
      meetingId,
      recordingId,
      scheduledAt: meeting!.scheduledAt + order * 1000,
      publishedRunId: opts.published === false ? undefined : runId,
    });
    return { leadId, meetingId, recordingId, runId, headerId };
  });
}
export async function createCase(f: EvalHarness) {
  const { campaign } = await f.owner.mutation(api.cases.createCampaign, {
    name: "Trial",
  });
  const { cases } = await f.owner.query(api.cases.cases, { campaign });
  return { campaign, caseId: cases[0].caseId };
}
export async function committedCase(f: EvalHarness) {
  const c = await createCase(f);
  await f.owner.mutation(api.labels.commitList, {
    caseId: c.caseId,
    skipped: true,
  });
  const labels = await f.t.run((ctx) =>
    ctx.db
      .query("callInsightEvalLabels")
      .withIndex("by_caseId_and_source", (q) => q.eq("caseId", c.caseId))
      .take(100),
  );
  for (const label of labels)
    await f.owner.mutation(api.labels.gradeItem, {
      labelId: label._id,
      verdict: "right",
    });
  await f.owner.mutation(api.labels.commitLabels, { caseId: c.caseId });
  return { ...c, labels };
}
export async function foreignAdmin(f: EvalHarness) {
  await f.t.run(async (ctx) => {
    const tenantId = await ctx.db.insert("tenants", {
      companyName: "Elsewhere",
      contactEmail: "else@example.test",
      workosOrgId: "org_else",
      status: "active",
      inviteExpiresAt: 0,
      createdBy: "test",
    });
    await ctx.db.insert("users", {
      tenantId,
      workosUserId: "user_else",
      email: "else@example.test",
      role: "tenant_admin",
      isActive: true,
    });
  });
  return f.t.withIdentity({ subject: "user_else", org_id: "org_else" });
}
export type CaseId = Id<"callInsightEvalCases">;
export type EvalLabel = Doc<"callInsightEvalLabels">;
