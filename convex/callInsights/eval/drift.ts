import { anyApi, type ApiFromModules } from "convex/server";
import { v, type Infer } from "convex/values";
import type { Doc } from "../../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../../_generated/server";
import { effectiveSettings } from "../settings";
import { createEvalJob } from "./judge";
import { seedFor, shuffled } from "./judgePrompt";
import type * as driftModule from "./drift";

const driftInternal = (
  anyApi as unknown as ApiFromModules<{
    "callInsights/eval/drift": typeof driftModule;
  }>
).callInsights.eval.drift;
const HEADER_PAGE = 40;
const WEEK_MS = 7 * 86_400_000;

/** ISO weeks start Monday and belong to the year containing their Thursday. */
export function isoWeek(now: number): string {
  const date = new Date(now);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const year = date.getUTCFullYear();
  const week = Math.ceil(
    ((date.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7,
  );
  return `${year}-W${String(week).padStart(2, "0")}`;
}
export function selectDrift<T extends { risk: boolean }>(
  calls: readonly T[],
  week: string,
) {
  const shuffledCalls = shuffled(calls, week);
  const random = shuffledCalls.slice(0, 3);
  const randomSet = new Set(random);
  return {
    random,
    risk: shuffledCalls.filter((c) => c.risk && !randomSet.has(c)).slice(0, 2),
  };
}
const sampleValidator = v.object({
  recordingId: v.id("callRecordings"),
  meetingId: v.id("meetings"),
  runId: v.id("callInsightRuns"),
  groupKey: v.string(),
  purgeAt: v.number(),
  risk: v.boolean(),
  rank: v.number(),
});
type Sample = Infer<typeof sampleValidator>;
const scanArgs = {
  tenantId: v.id("tenants"),
  cursor: v.union(v.string(), v.null()),
  now: v.number(),
  samples: v.array(sampleValidator),
};
/** Three random calls plus five risk reserves leave two risk calls even if all random calls are risky. */
function keepSamples(samples: Sample[]): Sample[] {
  const rankOrder = (a: Sample, b: Sample) =>
    a.rank - b.rank ||
    String(a.recordingId).localeCompare(String(b.recordingId));
  const distinct = (rows: Sample[]) => {
    const people = new Set<string>();
    return rows.sort(rankOrder).filter((row) => {
      if (people.has(row.groupKey)) return false;
      people.add(row.groupKey);
      return true;
    });
  };
  const random = distinct([...samples]).slice(0, 3);
  const risk = distinct(samples.filter((s) => s.risk)).slice(0, 5);
  return [
    ...new Map([...random, ...risk].map((s) => [s.recordingId, s])).values(),
  ];
}
async function scanTenant(
  ctx: MutationCtx,
  args: Infer<typeof _scanValidator>,
): Promise<void> {
  const tenant = await ctx.db.get("tenants", args.tenantId);
  const settings = effectiveSettings(tenant);
  if (!tenant || !settings || settings.evalMonthlyUsd <= 0) return;
  const running = await ctx.db
    .query("callInsightJobs")
    .withIndex("by_status_and_createdAt", (q) => q.eq("status", "running"))
    .take(501);
  if (running.length > 500 || running.some((j) => j.tenantId === tenant._id))
    return;
  const week = isoWeek(args.now),
    campaign = `drift-${week}`;
  const existing = await ctx.db
    .query("callInsightEvalCases")
    .withIndex("by_tenantId_and_campaign_and_split", (q) =>
      q.eq("tenantId", tenant._id).eq("campaign", campaign),
    )
    .first();
  if (existing) return;
  const page = await ctx.db
    .query("callInsightFacts")
    .withIndex("by_tenantId_and_kind_and_latestStatus", (q) =>
      q.eq("tenantId", tenant._id).eq("kind", "call"),
    )
    .paginate({ cursor: args.cursor, numItems: HEADER_PAGE });
  const samples = [...args.samples];
  for (const header of page.page) {
    if (
      header.kind !== "call" ||
      !header.active ||
      !header.publishedRunId ||
      header.analyzedAt === undefined ||
      header.analyzedAt < args.now - WEEK_MS ||
      header.analyzedAt > args.now ||
      header.quotesPurgedAt !== undefined
    )
      continue;
    const recording = await ctx.db.get("callRecordings", header.recordingId);
    if (
      !recording ||
      recording.tenantId !== tenant._id ||
      recording.matchStatus !== "matched" ||
      recording.meetingId !== header.meetingId ||
      !recording.transcriptStorageId ||
      recording.transcriptDeletedAt !== undefined ||
      (recording.transcriptExpiresAt ?? 0) <= args.now
    )
      continue;
    const run = await ctx.db.get("callInsightRuns", header.publishedRunId);
    const meeting = await ctx.db.get("meetings", header.meetingId);
    const deal =
      meeting?.tenantId === tenant._id
        ? await ctx.db.get("opportunities", meeting.opportunityId)
        : null;
    if (
      !run ||
      run.tenantId !== tenant._id ||
      run.recordingId !== header.recordingId ||
      run.status !== "answered" ||
      run.purpose !== "serve" ||
      run.quotesPurgedAt !== undefined ||
      !deal ||
      deal.tenantId !== tenant._id
    )
      continue;
    const suggestion = await ctx.db
      .query("resultSuggestionStates")
      .withIndex("by_recordingId", (q) => q.eq("recordingId", recording._id))
      .first();
    const risk =
      !!run.items?.some((i) => i.kind === "income") ||
      !!(
        suggestion?.tenantId === tenant._id &&
        suggestion.runId === run._id &&
        ["paid", "promised", "no_show"].includes(suggestion.kind)
      ) ||
      ["review", "certain", "check", "unconfirmed"].includes(
        header.noShowTier ?? "none",
      );
    samples.push({
      recordingId: recording._id,
      meetingId: header.meetingId,
      runId: run._id,
      groupKey: String(deal.leadId),
      purgeAt: recording.transcriptExpiresAt!,
      risk,
      rank: seedFor(`${tenant._id}:${week}:${recording._id}`),
    });
  }
  const kept = keepSamples(samples);
  if (!page.isDone) {
    await ctx.scheduler.runAfter(0, driftInternal.sampleTenant, {
      ...args,
      cursor: page.continueCursor,
      samples: kept,
    });
    return;
  }
  const randomPeople = new Set<string>();
  const random = kept
    .slice()
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        String(a.recordingId).localeCompare(String(b.recordingId)),
    )
    .filter((s) => {
      if (randomPeople.has(s.groupKey)) return false;
      randomPeople.add(s.groupKey);
      return true;
    })
    .slice(0, 3);
  const randomGroups = new Set(random.map((s) => s.groupKey));
  const risk = kept
    .filter((s) => s.risk && !randomGroups.has(s.groupKey))
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        String(a.recordingId).localeCompare(String(b.recordingId)),
    )
    .slice(0, 2);
  const cases: Doc<"callInsightEvalCases">[] = [];
  for (const [split, chosen] of [
    ["drift_random", random],
    ["drift_risk", risk],
  ] as const) {
    for (const sample of chosen) {
      const recording = await ctx.db.get("callRecordings", sample.recordingId);
      const run = await ctx.db.get("callInsightRuns", sample.runId);
      if (
        !recording?.transcriptStorageId ||
        recording.transcriptDeletedAt !== undefined ||
        recording.matchStatus !== "matched" ||
        recording.meetingId !== sample.meetingId ||
        !run ||
        run.quotesPurgedAt !== undefined ||
        sample.purgeAt <= Date.now()
      )
        continue;
      const id = await ctx.db.insert("callInsightEvalCases", {
        tenantId: tenant._id,
        recordingId: sample.recordingId,
        meetingId: sample.meetingId,
        campaign,
        split,
        groupKey: sample.groupKey,
        status: "to_read",
        labelRevision: 0,
        candidateRunId: sample.runId,
        candidateConfig: run.config,
        purgeAt: sample.purgeAt,
        createdAt: args.now,
      });
      const row = await ctx.db.get("callInsightEvalCases", id);
      if (row) cases.push(row);
    }
  }
  await createEvalJob(ctx, {
    tenantId: tenant._id,
    userId: settings.changedByUserId,
    campaign,
    kind: "eval_judge",
    cases,
    ceilingUsd: settings.evalMonthlyUsd,
  });
}
const _scanValidator = v.object(scanArgs);
export const sampleTenant = internalMutation({
  args: scanArgs,
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    await scanTenant(ctx, args);
    return null;
  },
});
/** One tenant and one call page per transaction; off tenants never read calls or write rows. */
export const weekly = internalMutation({
  args: { cursor: v.optional(v.string()), now: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const now = args.now ?? Date.now();
    const page = await ctx.db
      .query("tenants")
      .paginate({ cursor: args.cursor ?? null, numItems: 1 });
    const tenant = page.page[0];
    if (tenant) {
      const settings = effectiveSettings(tenant);
      if (settings && settings.evalMonthlyUsd > 0)
        await ctx.scheduler.runAfter(0, driftInternal.sampleTenant, {
          tenantId: tenant._id,
          cursor: null,
          now,
          samples: [],
        });
    }
    if (!page.isDone)
      await ctx.scheduler.runAfter(0, driftInternal.weekly, {
        cursor: page.continueCursor,
        now,
      });
    return null;
  },
});
