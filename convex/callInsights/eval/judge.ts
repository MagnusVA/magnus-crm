import { anyApi, type ApiFromModules } from "convex/server";
import type * as judgeModule from "./judge";
import {
  DEFAULT_BUSINESS_DAY,
  businessDayStart,
} from "../../../lib/businessDay";
import { getServiceToken } from "convex/server";
import { v, type Infer } from "convex/values";
import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../../_generated/server";
import schema from "../../schema";
import { rejectRequest } from "../../lib/observability/errors";
import { readLiveQueryRows } from "../../lib/liveQueryBounds";
import { isOtherProspectsCall } from "../../secondOpinion/trigger";
import { reserve, secondOpinionSpendUsd, settle, toMicroUsd } from "../budget";
import {
  buildMessagesRequest,
  callMessages,
  maxCostMicroUsd,
} from "../gateway";
import { parseAmounts } from "../income";
import { noShowTier } from "../noShow/tier";
import { deriveSuggestion } from "../suggest/derive";
import { CERTAIN_AFTER_SLOT_MS } from "../suggest/state";
import { BACKOFF_MS, LEASE_MS, MAX_ATTEMPTS, MAX_OUTPUT_TOKENS } from "../run";
import { effectiveSettings, servingConfig } from "../settings";
import {
  MAX_TRANSCRIPT_TOKENS,
  parseStoredTranscript,
  prepareTranscript,
  renderLines,
} from "../transcriptPrep";
import { JUDGE_MODEL, runReasonValidator, type RunConfig } from "../validators";
import {
  caseLabels,
  itemClassValidator,
  labelValueFields,
  requireAdminContext,
  splitValidator,
} from "./cases";
import {
  GRADING_SCHEMA,
  GRADING_SYSTEM,
  INVENTORY_SCHEMA,
  INVENTORY_SYSTEM,
  gradingMessage,
  inventoryMessage,
  parseGrades,
  parseInventory,
  shuffled,
  type Candidate,
  type Grade,
  type Inventory,
} from "./judgePrompt";
import { plantDefects } from "./planted";
import { lowerBound } from "./stats";

const evalInternal = (
  anyApi as unknown as ApiFromModules<{
    "callInsights/eval/judge": typeof judgeModule;
  }>
).callInsights.eval;

const caseArgs = {
  caseId: v.id("callInsightEvalCases"),
  jobId: v.optional(v.id("callInsightJobs")),
  jobItemId: v.optional(v.id("callInsightJobItems")),
};
const document = <T extends "callInsightEvalCases" | "callInsightEvalLabels">(
  table: T,
) =>
  v.object({
    ...schema.tables[table].validator.fields,
    _id: v.id(table),
    _creationTime: v.number(),
  });
const caseValidator = document("callInsightEvalCases");
const labelValidator = document("callInsightEvalLabels");
const candidateValidator = v.object({
  key: v.string(),
  labelId: v.optional(v.id("callInsightEvalLabels")),
  originalKey: v.optional(v.string()),
  itemClass: itemClassValidator,
  ...labelValueFields,
  resolutionLineIndex: v.optional(v.number()),
  numberlessProspectLines: v.optional(v.array(v.number())),
  plantedDefect:
    schema.tables.callInsightEvalLabels.validator.fields.plantedDefect,
});
const committed = (row: Pick<Doc<"callInsightEvalCases">, "status">) =>
  row.status === "labels_committed" || row.status === "closed";
const drift = (row: Pick<Doc<"callInsightEvalCases">, "split">) =>
  row.split === "drift_random" || row.split === "drift_risk";

/** No statements or quotes are copied from the serving run. */
export function candidatesFromRun(
  run: Pick<
    Doc<"callInsightRuns">,
    | "items"
    | "result"
    | "attendance"
    | "measures"
    | "earlyReading"
    | "finishedAt"
  >,
  waitMinutes?: number,
): Candidate[] {
  const items: Candidate[] = (run.items ?? []).map((i) => ({
    key: i.key,
    itemClass: i.kind,
    category: i.category,
    lineStart: i.lineIndex,
    lineEnd: i.lineIndex,
    resolution: i.resolution,
    resolutionLineIndex: i.resolutionLineIndex,
    scenario: i.scenario,
    period: i.period,
    currency: i.currency,
    minMinor: i.minMinor,
    maxMinor: i.maxMinor,
  }));
  const noShow = run.measures
    ? noShowTier({
        eligible: true,
        now: Math.max(
          run.finishedAt ?? Date.now(),
          run.measures.slotEndedAt + CERTAIN_AFTER_SLOT_MS,
        ),
        measures: run.measures,
        attendance: run.attendance,
        jev: run.earlyReading?.attendance,
        waitMinutes,
      })
    : { tier: "none" as const, notes: [] };
  const suggestion = deriveSuggestion({
    noShow,
    result: run.result,
    attendance: run.attendance,
    reading: run.earlyReading,
  });
  if (suggestion)
    items.push({
      key: "result",
      itemClass: "result",
      resultKind: suggestion.kind,
      resultTier: suggestion.tier,
      resultValues: suggestion.values,
      noShowTier: suggestion.noShowTier,
      lineStart: run.result?.quotes[0]?.lineIndex,
      lineEnd: run.result?.quotes.at(-1)?.lineIndex,
    });
  items.push({
    key: "attendance",
    itemClass: "attendance",
    noShowTier: noShow.tier,
  });
  return items;
}
export function candidateFromLabel(l: Doc<"callInsightEvalLabels">): Candidate {
  return {
    key: l.itemKey ?? String(l._id),
    labelId: l._id,
    itemClass: l.itemClass,
    category: l.category,
    lineStart: l.lineStart,
    lineEnd: l.lineEnd,
    resolution: l.resolution,
    scenario: l.scenario,
    period: l.period,
    currency: l.currency,
    minMinor: l.minMinor,
    maxMinor: l.maxMinor,
    resultKind: l.resultKind,
    resultTier: l.resultTier,
    resultValues: l.resultValues,
    noShowTier: l.noShowTier,
  };
}

/** Bounded reads reject an oversized campaign rather than silently judging a partial set. */
export async function campaignCases(
  ctx: QueryCtx | MutationCtx,
  tenantId: Id<"tenants">,
  campaign: string,
) {
  const found = await readLiveQueryRows(
    ctx.db
      .query("callInsightEvalCases")
      .withIndex("by_tenantId_and_campaign_and_split", (q) =>
        q.eq("tenantId", tenantId).eq("campaign", campaign),
      ),
    100,
  );
  if (found.capped)
    throw rejectRequest(
      "call_insights.eval_limit",
      "This campaign is too large for one job.",
    );
  return found.rows;
}
export async function assertNoRunningJob(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
) {
  const jobs = await readLiveQueryRows(
    ctx.db
      .query("callInsightJobs")
      .withIndex("by_status_and_createdAt", (q) => q.eq("status", "running")),
    500,
  );
  if (jobs.capped || jobs.rows.some((j) => j.tenantId === tenantId))
    throw rejectRequest(
      "call_insights.eval_job_running",
      "Another job is already running.",
    );
}
export async function createEvalJob(
  ctx: MutationCtx,
  a: {
    tenantId: Id<"tenants">;
    userId: Id<"users">;
    campaign: string;
    kind: "eval_judge" | "eval_regression";
    cases: Doc<"callInsightEvalCases">[];
    ceilingUsd: number;
    candidateConfig?: RunConfig;
  },
): Promise<Id<"callInsightJobs"> | null> {
  if (!a.cases.length) return null;
  const now = Date.now();
  const jobId = await ctx.db.insert("callInsightJobs", {
    tenantId: a.tenantId,
    kind: a.kind,
    campaign: a.campaign,
    candidateConfig: a.candidateConfig,
    status: "running",
    ceilingMicroUsd: toMicroUsd(a.ceilingUsd),
    spentMicroUsd: 0,
    estimateMicroUsd:
      a.cases.length * (a.kind === "eval_judge" ? 500_000 : 125_000),
    total: a.cases.length,
    done: 0,
    failed: 0,
    skipped: 0,
    createdByUserId: a.userId,
    createdAt: now,
  });
  for (const row of [...a.cases].sort((a, b) => a.purgeAt - b.purgeAt))
    await ctx.db.insert("callInsightJobItems", {
      tenantId: a.tenantId,
      jobId,
      recordingId: row.recordingId,
      order: row.purgeAt,
      status: "pending",
    });
  await ctx.scheduler.runAfter(0, internal.callInsights.jobs.advance, {
    jobId,
  });
  return jobId;
}
export async function liveCase(
  ctx: QueryCtx | MutationCtx,
  row: Doc<"callInsightEvalCases">,
) {
  if (row.purgeAt <= Date.now()) return null;
  const recording = await ctx.db.get("callRecordings", row.recordingId);
  if (
    !recording ||
    recording.tenantId !== row.tenantId ||
    recording.meetingId !== row.meetingId ||
    recording.matchStatus !== "matched" ||
    !recording.transcriptStorageId ||
    recording.transcriptDeletedAt !== undefined ||
    (recording.transcriptExpiresAt ??
      recording.recordingStartAt + 90 * 86_400_000) <= Date.now()
  )
    return null;
  return recording;
}
export const startJudgeJob = mutation({
  args: {
    campaign: v.string(),
    split: v.optional(splitValidator),
    ceilingUsd: v.optional(v.number()),
  },
  returns: v.union(v.id("callInsightJobs"), v.null()),
  handler: async (ctx, args) => {
    const me = await requireAdminContext(ctx);
    await assertNoRunningJob(ctx, me.tenantId);
    const tenant = await ctx.db.get("tenants", me.tenantId);
    const settings = effectiveSettings(tenant);
    if (!settings || settings.evalMonthlyUsd <= 0) return null;
    if (
      args.ceilingUsd !== undefined &&
      (!Number.isFinite(args.ceilingUsd) || args.ceilingUsd <= 0)
    )
      throw rejectRequest(
        "call_insights.eval_ceiling",
        "Enter a positive job ceiling.",
      );
    const rows = await campaignCases(ctx, me.tenantId, args.campaign);
    const eligible = [];
    for (const row of rows)
      if (
        (!args.split || row.split === args.split) &&
        (committed(row) || drift(row)) &&
        (await liveCase(ctx, row))
      )
        eligible.push(row);
    return await createEvalJob(ctx, {
      tenantId: me.tenantId,
      userId: me.userId,
      campaign: args.campaign,
      kind: "eval_judge",
      cases: eligible,
      ceilingUsd: Math.min(
        args.ceilingUsd ?? settings.evalMonthlyUsd,
        settings.evalMonthlyUsd,
      ),
    });
  },
});

const inputValidator = v.object({
  row: caseValidator,
  labels: v.array(labelValidator),
  candidates: v.array(candidateValidator),
  transcriptStorageId: v.id("_storage"),
  recorder: v.object({ email: v.string(), names: v.array(v.string()) }),
  inviteeEmails: v.array(v.string()),
});
type JudgeInput = Infer<typeof inputValidator>;
export const load = internalQuery({
  args: caseArgs,
  returns: v.union(inputValidator, v.null()),
  handler: async (ctx, args): Promise<JudgeInput | null> => {
    const row = await ctx.db.get("callInsightEvalCases", args.caseId);
    if (!row || (!committed(row) && !drift(row))) return null;
    const tenant = await ctx.db.get("tenants", row.tenantId);
    const settings = effectiveSettings(tenant);
    if (!settings) return null;
    if (args.jobId) {
      const job = await ctx.db.get("callInsightJobs", args.jobId);
      const item = args.jobItemId
        ? await ctx.db.get("callInsightJobItems", args.jobItemId)
        : null;
      if (
        !job ||
        job.status !== "running" ||
        job.kind !== "eval_judge" ||
        job.tenantId !== row.tenantId ||
        job.campaign !== row.campaign ||
        !item ||
        item.jobId !== job._id ||
        item.recordingId !== row.recordingId ||
        item.status !== "running"
      )
        return null;
    }
    const recording = await liveCase(ctx, row);
    const meeting = recording
      ? await ctx.db.get("meetings", row.meetingId)
      : null;
    if (
      !recording ||
      !meeting ||
      meeting.tenantId !== row.tenantId ||
      (await isOtherProspectsCall(ctx, meeting, recording))
    )
      return null;
    const labels = await caseLabels(ctx, row._id);
    const run = row.candidateRunId
      ? await ctx.db.get("callInsightRuns", row.candidateRunId)
      : null;
    if (
      !run ||
      run.tenantId !== row.tenantId ||
      run.recordingId !== row.recordingId ||
      run.quotesPurgedAt !== undefined
    )
      return null;
    const extractor = labels.filter((l) => l.source === "extractor");
    const candidates = extractor.length
      ? extractor.map(candidateFromLabel)
      : drift(row)
        ? candidatesFromRun(run, settings.noShowWaitMinutes)
        : [];
    const recorderUser = recording.recordedByUserId
      ? await ctx.db.get("users", recording.recordedByUserId)
      : null;
    const roster = await ctx.db
      .query("fathomOrgMembers")
      .withIndex("by_tenantId_and_email", (q) =>
        q
          .eq("tenantId", row.tenantId)
          .eq("email", recording.recordedByEmail.toLowerCase()),
      )
      .first();
    const names = [
      recorderUser?.tenantId === row.tenantId
        ? recorderUser.fullName
        : undefined,
      roster?.name,
    ].filter((n): n is string => Boolean(n));
    return {
      row,
      labels,
      candidates,
      transcriptStorageId: recording.transcriptStorageId!,
      recorder: { email: recording.recordedByEmail, names },
      inviteeEmails: recording.inviteeEmails,
    };
  },
});
const phaseValidator = v.union(
  v.literal("inventory"),
  v.literal("forward"),
  v.literal("reverse"),
);
const claimValidator = v.object({
  runId: v.id("callInsightRuns"),
  state: v.union(
    v.literal("claimed"),
    v.literal("cached"),
    v.literal("busy"),
    v.literal("skipped"),
    v.literal("failed"),
  ),
  token: v.optional(v.string()),
  attempt: v.number(),
  output: v.optional(v.string()),
});
type Claim = Infer<typeof claimValidator>;
export const claim = internalMutation({
  args: {
    ...caseArgs,
    revision: v.number(),
    phase: phaseValidator,
    estimatedInputTokens: v.number(),
    secondOpinionSpentUsd: v.number(),
  },
  returns: v.union(claimValidator, v.null()),
  handler: async (ctx, args): Promise<Claim | null> => {
    const row = await ctx.db.get("callInsightEvalCases", args.caseId);
    if (
      !row ||
      row.labelRevision !== args.revision ||
      (!committed(row) && !drift(row))
    )
      return null;
    const recording = await liveCase(ctx, row);
    const tenant = await ctx.db.get("tenants", row.tenantId);
    const settings = effectiveSettings(tenant);
    if (!recording || !tenant || !settings) return null;
    const role = args.phase === "inventory" ? "inventory" : "judge";
    const inputKey = `${row.recordingId}:eval:${role}:${row._id}:${args.jobId ?? "manual"}:${args.revision}:${args.phase}`;
    let run = await ctx.db
      .query("callInsightRuns")
      .withIndex("by_tenantId_and_inputKey", (q) =>
        q.eq("tenantId", row.tenantId).eq("inputKey", inputKey),
      )
      .first();
    if (!run) {
      const runId = await ctx.db.insert("callInsightRuns", {
        tenantId: row.tenantId,
        recordingId: row.recordingId,
        meetingId: row.meetingId,
        purpose: "eval",
        evalRole: role,
        evalCaseId: row._id,
        jobId: args.jobId,
        generation: 0,
        inputKey,
        trigger: "eval",
        kind: "full",
        status: "queued",
        attempt: 0,
        config: {
          ...servingConfig(settings),
          model: JUDGE_MODEL,
          promptVersion: "judge-v1",
          itemCheck: false,
        },
        receipts: [],
        quotesExpireAt: row.purgeAt,
        createdAt: Date.now(),
      });
      run = await ctx.db.get("callInsightRuns", runId);
    }
    if (!run) return null;
    const base = { runId: run._id, attempt: run.attempt };
    if (run.status === "answered" && run.judgeOutput)
      return { ...base, state: "cached", output: run.judgeOutput };
    if (run.status === "skipped") return { ...base, state: "skipped" };
    if (run.status === "failed") return { ...base, state: "failed" };
    if (run.status === "running" || (run.nextAttemptAt ?? 0) > Date.now())
      return { ...base, state: "busy" };
    const amount = maxCostMicroUsd(
      JUDGE_MODEL,
      args.estimatedInputTokens,
      MAX_OUTPUT_TOKENS,
    );
    if (args.jobId) {
      const job = await ctx.db.get("callInsightJobs", args.jobId);
      const otherRuns = await ctx.db
        .query("callInsightRuns")
        .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
        .take(400);
      const reserved = otherRuns
        .flatMap((r) => r.receipts)
        .filter((r) => r.settledAt === undefined)
        .reduce((s, r) => s + r.reservedMicroUsd, 0);
      if (
        !job ||
        job.status !== "running" ||
        job.tenantId !== row.tenantId ||
        job.spentMicroUsd + reserved + amount > job.ceilingMicroUsd
      ) {
        await ctx.db.patch("callInsightRuns", run._id, {
          status: "skipped",
          reason: "cap_reached",
          finishedAt: Date.now(),
        });
        return { ...base, state: "skipped" };
      }
    }
    const attempt = run.attempt + 1;
    const receipt = await reserve(ctx, {
      tenant,
      settings,
      now: Date.now(),
      key: `opus:${attempt}`,
      origin: "opus",
      pool: "eval",
      amountMicroUsd: amount,
      secondOpinionSpentUsd: args.secondOpinionSpentUsd,
    });
    if (!receipt) {
      await ctx.db.patch("callInsightRuns", run._id, {
        status: "skipped",
        reason: "cap_reached",
        finishedAt: Date.now(),
      });
      return { ...base, state: "skipped" };
    }
    const token = crypto.randomUUID();
    if (args.jobItemId && args.jobId) {
      const item = await ctx.db.get("callInsightJobItems", args.jobItemId);
      if (
        !item ||
        item.jobId !== args.jobId ||
        item.recordingId !== row.recordingId ||
        item.status !== "running"
      ) {
        const receipts = await settle(ctx, {
          tenantId: row.tenantId,
          jobId: args.jobId,
          receipts: [...run.receipts, receipt],
          costs: { [receipt.key]: { costUsd: 0 } },
          now: Date.now(),
        });
        await ctx.db.patch("callInsightRuns", run._id, {
          status: "skipped",
          reason: "canceled",
          receipts,
          finishedAt: Date.now(),
        });
        return { ...base, state: "skipped" };
      }
      await ctx.db.patch("callInsightJobItems", item._id, { runId: run._id });
    }
    await ctx.db.patch("callInsightRuns", run._id, {
      status: "running",
      attempt,
      claimToken: token,
      leaseUntil: Date.now() + LEASE_MS,
      nextAttemptAt: undefined,
      reason: undefined,
      receipts: [...run.receipts, receipt],
      startedAt: run.startedAt ?? Date.now(),
    });
    return { runId: run._id, state: "claimed", token, attempt };
  },
});
const costValidator = v.object({
  costUsd: v.optional(v.number()),
  inputTokens: v.optional(v.number()),
  outputTokens: v.optional(v.number()),
  gatewayRequestId: v.optional(v.string()),
});
export const endRequest = internalMutation({
  args: {
    ...caseArgs,
    runId: v.id("callInsightRuns"),
    token: v.string(),
    output: v.optional(v.string()),
    reason: v.optional(runReasonValidator),
    retry: v.boolean(),
    retryAfterSeconds: v.optional(v.number()),
    cost: costValidator,
  },
  returns: v.union(v.boolean(), v.null()),
  handler: async (ctx, args) => {
    const run = await ctx.db.get("callInsightRuns", args.runId);
    if (
      !run ||
      run.evalCaseId !== args.caseId ||
      run.claimToken !== args.token ||
      run.status !== "running"
    )
      return null;
    const receipts = await settle(ctx, {
      tenantId: run.tenantId,
      jobId: run.jobId,
      receipts: run.receipts,
      costs: { [`opus:${run.attempt}`]: args.cost },
      now: Date.now(),
    });
    const purged = run.quotesPurgedAt !== undefined;
    const retry = !purged && args.retry && run.attempt < MAX_ATTEMPTS;
    const delay = Math.max(
      BACKOFF_MS[Math.min(run.attempt - 1, 2)],
      (args.retryAfterSeconds ?? 0) * 1000,
    );
    await ctx.db.patch("callInsightRuns", run._id, {
      status: purged
        ? "skipped"
        : args.output
          ? "answered"
          : retry
            ? "queued"
            : "failed",
      reason: purged ? "no_transcript" : args.reason,
      judgeOutput: purged ? undefined : args.output,
      receipts,
      claimToken: undefined,
      leaseUntil: undefined,
      nextAttemptAt: retry ? Date.now() + delay : undefined,
      finishedAt: retry ? undefined : Date.now(),
    });
    if (retry)
      await ctx.scheduler.runAfter(delay, evalInternal.judge.judgeCase, {
        caseId: args.caseId,
        jobId: args.jobId,
        jobItemId: args.jobItemId,
      });
    return retry;
  },
});
const gradeValidator = v.object({
  n: v.number(),
  verdict: v.union(
    v.literal("supported"),
    v.literal("contradicted"),
    v.literal("insufficient"),
  ),
  wrongFields: v.array(v.string()),
  lines: v.array(v.number()),
});
function canonicalJson(value: unknown): string {
  const sorted = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sorted)
      : v !== null && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, sorted(x)]),
          )
        : v;
  return JSON.stringify(sorted(value));
}
const currencyFor = (said: string) =>
  said === "dollars_unspecified"
    ? "USD"
    : ["usd", "cad", "aud", "eur", "gbp", "hnl", "mxn"].includes(said)
      ? said.toUpperCase()
      : undefined;
export const finish = internalMutation({
  args: {
    ...caseArgs,
    revision: v.number(),
    candidates: v.array(candidateValidator),
    inventory: v.string(),
    grades: v.array(gradeValidator),
    rerun: v.array(gradeValidator),
    inventoryRunId: v.id("callInsightRuns"),
    judgeRunId: v.id("callInsightRuns"),
    judgeRerunId: v.id("callInsightRuns"),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get("callInsightEvalCases", args.caseId);
    if (
      !row ||
      row.labelRevision !== args.revision ||
      (!committed(row) && !drift(row)) ||
      !(await liveCase(ctx, row))
    )
      return false;
    if (
      row.judgeRunId === args.judgeRunId &&
      row.judgeRerunId === args.judgeRerunId
    )
      return true;
    const runIds = [args.inventoryRunId, args.judgeRunId, args.judgeRerunId];
    const outputs = [
      args.inventory,
      JSON.stringify(args.grades),
      JSON.stringify(args.rerun),
    ];
    for (let i = 0; i < runIds.length; i++) {
      const run = await ctx.db.get("callInsightRuns", runIds[i]);
      if (
        !run ||
        run.evalCaseId !== row._id ||
        run.tenantId !== row.tenantId ||
        run.status !== "answered" ||
        run.quotesPurgedAt !== undefined ||
        run.judgeOutput === undefined ||
        canonicalJson(JSON.parse(run.judgeOutput)) !==
          canonicalJson(JSON.parse(outputs[i]))
      )
        return false;
    }
    const inventory = JSON.parse(args.inventory) as Inventory;
    const existing = await caseLabels(ctx, row._id);
    for (const label of existing.filter(
      (l) => l.source === "inventory" || l.source === "planted",
    ))
      await ctx.db.delete("callInsightEvalLabels", label._id);
    const common = {
      tenantId: row.tenantId,
      caseId: row._id,
      labelRevision: row.labelRevision,
      createdAt: Date.now(),
    };
    for (const i of inventory.items)
      await ctx.db.insert("callInsightEvalLabels", {
        ...common,
        source: "inventory",
        itemClass: i.itemClass,
        category: i.category,
        lineStart: i.lineStart,
        lineEnd: i.lineEnd,
        resolution: i.resolution === "none" ? undefined : i.resolution,
        scenario: i.scenario === "none" ? undefined : i.scenario,
        period: i.period,
        minMinor:
          i.itemClass === "income" ? Math.round(i.amountMin * 100) : undefined,
        maxMinor:
          i.itemClass === "income" && (i.amountMax > 0 || i.amountMin === 0)
            ? Math.round(i.amountMax * 100)
            : undefined,
        currency: currencyFor(i.currencyAsSaid),
      });
    const tenant = await ctx.db.get("tenants", row.tenantId);
    const local = inventory.result.callbackLocal
      ? new Date(inventory.result.callbackLocal).toISOString()
      : undefined;
    const callbackAt = local
      ? businessDayStart(local.slice(0, 10), {
          timeZone: (tenant?.businessDay ?? DEFAULT_BUSINESS_DAY).timeZone,
          dayStartHour: Number(local.slice(11, 13)),
        }) +
        Number(local.slice(14, 16)) * 60_000 +
        Number(local.slice(17, 19)) * 1000
      : undefined;
    await ctx.db.insert("callInsightEvalLabels", {
      ...common,
      source: "inventory",
      itemClass: "result",
      resultKind:
        inventory.result.kind === "none"
          ? "no_decision"
          : inventory.result.kind,
      resultValues: {
        amountMinor: Math.round(inventory.result.amount * 100),
        currency: currencyFor(inventory.result.currencyAsSaid),
        callbackAt,
        lossCategory:
          inventory.result.lossCategory === "none"
            ? undefined
            : inventory.result.lossCategory,
      },
    });
    await ctx.db.insert("callInsightEvalLabels", {
      ...common,
      source: "inventory",
      itemClass: "attendance",
      category:
        inventory.attendance === "present"
          ? "held"
          : inventory.attendance === "absent"
            ? "no_show"
            : inventory.attendance,
    });
    for (let index = 0; index < args.candidates.length; index++) {
      const c = args.candidates[index];
      const g = args.grades.find((g) => g.n === index + 1)!;
      const r = args.rerun.find((g) => g.n === args.candidates.length - index)!;
      const grading = {
        judgeVerdict: g.verdict,
        judgeWrongFields: g.wrongFields,
        judgeLines: g.lines,
        judgeRerunVerdict: r.verdict,
      };
      if (c.plantedDefect) {
        const {
          key,
          labelId: _labelId,
          originalKey,
          resolutionLineIndex: _line,
          numberlessProspectLines: _lines,
          ...values
        } = c;
        void _labelId;
        void _line;
        void _lines;
        await ctx.db.insert("callInsightEvalLabels", {
          ...common,
          ...values,
          ...grading,
          source: "planted",
          itemKey: key,
          matchedLabelId: existing.find(
            (l) =>
              l.source === "extractor" &&
              (l.itemKey ?? String(l._id)) === originalKey,
          )?._id,
        });
      } else if (c.labelId) {
        const label = existing.find(
          (l) => l._id === c.labelId && l.source === "extractor",
        );
        if (label)
          await ctx.db.patch("callInsightEvalLabels", label._id, grading);
      }
    }
    await ctx.db.patch("callInsightEvalCases", row._id, {
      inventoryRunId: args.inventoryRunId,
      judgeRunId: args.judgeRunId,
      judgeRerunId: args.judgeRerunId,
      ...(drift(row) ? { judgeExposed: true } : {}),
    });
    return true;
  },
});
export const itemEnded = internalMutation({
  args: {
    ...caseArgs,
    outcome: v.union(
      v.literal("done"),
      v.literal("failed"),
      v.literal("skipped"),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.jobId && args.jobItemId)
      await ctx.scheduler.runAfter(0, internal.callInsights.jobs.itemFinished, {
        jobId: args.jobId,
        jobItemId: args.jobItemId,
        outcome: args.outcome,
      });
    return null;
  },
});
export const judgeCase = internalAction({
  args: caseArgs,
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const end = async (outcome: "done" | "failed" | "skipped") => {
      await ctx.runMutation(evalInternal.judge.itemEnded, { ...args, outcome });
      return null;
    };
    const input: JudgeInput | null = await ctx.runQuery(
      evalInternal.judge.load,
      args,
    );
    if (!input) return await end("skipped");
    let rendered: string, numberless: number[], lineCount: number;
    try {
      const blob = await ctx.storage.get(input.transcriptStorageId);
      if (!blob) return await end("skipped");
      const transcript = prepareTranscript(
        parseStoredTranscript(JSON.parse(await blob.text())),
        input.recorder,
        input.inviteeEmails,
      );
      if (transcript.estimatedTokens > MAX_TRANSCRIPT_TOKENS)
        return await end("failed");
      if (!transcript.lines.length) return await end("skipped");
      rendered = renderLines(transcript.lines);
      lineCount = transcript.lines.length;
      numberless = transcript.lines
        .filter(
          (l) =>
            l.role === "Prospect" &&
            !/\d/.test(l.text) &&
            !parseAmounts(l.text).length,
        )
        .map((l) => l.index);
    } catch {
      return await end("failed");
    }
    const real: Candidate[] = input.candidates.map((c) => ({
      ...c,
      numberlessProspectLines: numberless,
    }));
    const candidates = shuffled(
      [...real, ...plantDefects(String(args.caseId), real)],
      String(args.caseId),
    );
    const outputs: string[] = [],
      ids: Id<"callInsightRuns">[] = [];
    for (const phase of ["inventory", "forward", "reverse"] as const) {
      const user =
        phase === "inventory"
          ? inventoryMessage(rendered)
          : gradingMessage(
              rendered,
              phase === "forward" ? candidates : [...candidates].reverse(),
            );
      const system = phase === "inventory" ? INVENTORY_SYSTEM : GRADING_SYSTEM;
      const claim: Claim | null = await ctx.runMutation(
        evalInternal.judge.claim,
        {
          ...args,
          revision: input.row.labelRevision,
          phase,
          estimatedInputTokens: Math.ceil((user.length + system.length) / 3.5),
          secondOpinionSpentUsd: await secondOpinionSpendUsd(
            ctx,
            input.row.tenantId,
            Date.now(),
          ),
        },
      );
      if (!claim || claim.state === "skipped") return await end("skipped");
      if (claim.state === "failed") return await end("failed");
      if (claim.state === "busy") return null;
      ids.push(claim.runId);
      if (claim.state === "cached") {
        outputs.push(claim.output!);
        continue;
      }
      let cost: Infer<typeof costValidator> = {};
      try {
        const response = await callMessages(
          buildMessagesRequest({
            model: JUDGE_MODEL,
            system,
            user,
            schema: phase === "inventory" ? INVENTORY_SCHEMA : GRADING_SCHEMA,
            maxTokens: 8000,
            effort: "medium",
          }),
          () => getServiceToken("ai-gateway"),
        );
        if (
          response.kind === "ok" ||
          response.kind === "refused" ||
          response.kind === "format_changed"
        )
          cost = { costUsd: response.costUsd };
        if (response.kind === "ok") {
          cost = {
            costUsd: response.costUsd,
            inputTokens: response.inputTokens,
            outputTokens: response.outputTokens,
            gatewayRequestId: response.id,
          };
          const output = JSON.stringify(
            phase === "inventory"
              ? parseInventory(response.text, lineCount)
              : parseGrades(response.text, candidates.length, lineCount),
          );
          const ended: boolean | null = await ctx.runMutation(
            evalInternal.judge.endRequest,
            {
              ...args,
              runId: claim.runId,
              token: claim.token!,
              output,
              retry: false,
              cost,
            },
          );
          if (ended === null) return null;
          outputs.push(output);
        } else {
          const retry: boolean | null = await ctx.runMutation(
            evalInternal.judge.endRequest,
            {
              ...args,
              runId: claim.runId,
              token: claim.token!,
              retry: response.kind === "busy",
              retryAfterSeconds:
                response.kind === "busy"
                  ? response.retryAfterSeconds
                  : undefined,
              reason:
                response.kind === "busy" ? "upstream_error" : response.kind,
              cost:
                response.kind === "rejected" ||
                (response.kind === "busy" && response.status !== 0)
                  ? { costUsd: 0 }
                  : cost,
            },
          );
          return retry === null || retry ? null : await end("failed");
        }
      } catch {
        const ended: boolean | null = await ctx.runMutation(
          evalInternal.judge.endRequest,
          {
            ...args,
            runId: claim.runId,
            token: claim.token!,
            reason: "format_changed",
            retry: false,
            cost,
          },
        );
        return ended === null ? null : await end("failed");
      }
    }
    const saved: boolean = await ctx.runMutation(evalInternal.judge.finish, {
      ...args,
      revision: input.row.labelRevision,
      candidates,
      inventory: outputs[0],
      grades: JSON.parse(outputs[1]) as Grade[],
      rerun: JSON.parse(outputs[2]) as Grade[],
      inventoryRunId: ids[0],
      judgeRunId: ids[1],
      judgeRerunId: ids[2],
    });
    return await end(saved ? "done" : "skipped");
  },
});

export type CalibrationCase = {
  case: Pick<
    Doc<"callInsightEvalCases">,
    "groupKey" | "split" | "status" | "judgeExposed"
  >;
  labels: Doc<"callInsightEvalLabels">[];
};
const dimensionValidator = v.object({
  dimension: itemClassValidator,
  calls: v.number(),
  agreement: v.number(),
  lowerBound: v.number(),
  plantedCaught: v.number(),
  planted: v.number(),
  stable: v.number(),
  stabilityN: v.number(),
  stability: v.number(),
  trust: v.union(v.literal("advisory"), v.literal("may_block")),
});
const calibrationValidator = v.object({
  dimensions: v.array(dimensionValidator),
  inventoryMisses: v.object({ found: v.number(), shared: v.number() }),
});
export function calibration(
  input: CalibrationCase[],
): Infer<typeof calibrationValidator> {
  const seen = new Set<string>();
  const cases = input
    .filter(
      (c) =>
        c.case.split === "calib" && committed(c.case) && !c.case.judgeExposed,
    )
    .filter((c) => {
      if (seen.has(c.case.groupKey)) return false;
      seen.add(c.case.groupKey);
      return true;
    });
  const moneyPlants = cases
    .flatMap((c) => c.labels)
    .filter(
      (l) =>
        l.source === "planted" &&
        ["income", "result", "attendance"].includes(l.itemClass),
    );
  const dimensions = (
    ["objection", "struggle", "goal", "income", "result", "attendance"] as const
  ).map((dimension) => {
    let calls = 0,
      agreement = 0,
      plantedCaught = 0,
      planted = 0,
      stable = 0,
      stabilityN = 0;
    for (const c of cases) {
      const real = c.labels.filter(
        (l) => l.source === "extractor" && l.itemClass === dimension,
      );
      if (real.some((l) => l.adminVerdict !== undefined)) {
        calls++;
        if (
          real.every((l) =>
            l.adminVerdict === "right"
              ? l.judgeVerdict === "supported"
              : l.adminVerdict === "wrong" &&
                (l.judgeVerdict === "contradicted" ||
                  l.judgeVerdict === "insufficient"),
          )
        )
          agreement++;
      }
      for (const l of c.labels.filter(
        (l) =>
          l.itemClass === dimension &&
          (l.source === "planted" || l.source === "extractor"),
      )) {
        if (l.source === "planted") {
          planted++;
          if (
            l.judgeVerdict === "contradicted" ||
            l.judgeVerdict === "insufficient"
          )
            plantedCaught++;
        }
        stabilityN++;
        if (
          l.judgeVerdict !== undefined &&
          l.judgeVerdict === l.judgeRerunVerdict
        )
          stable++;
      }
    }
    const bound = lowerBound(agreement, calls),
      stability = stabilityN ? stable / stabilityN : 0;
    return {
      dimension,
      calls,
      agreement,
      lowerBound: bound,
      plantedCaught,
      planted,
      stable,
      stabilityN,
      stability,
      trust:
        !["income", "result", "attendance"].includes(dimension) &&
        calls >= 29 &&
        bound >= 0.9 &&
        moneyPlants.length > 0 &&
        moneyPlants.every(
          (l) =>
            l.judgeVerdict === "contradicted" ||
            l.judgeVerdict === "insufficient",
        ) &&
        stability >= 0.95
          ? ("may_block" as const)
          : ("advisory" as const),
    };
  });
  let found = 0,
    shared = 0;
  for (const c of cases) {
    const inventory = c.labels.filter((l) => l.source === "inventory");
    for (const admin of c.labels.filter(
      (l) =>
        l.source === "admin" &&
        !["result", "attendance"].includes(l.itemClass) &&
        !l.matchedLabelId,
    )) {
      const match = inventory.find(
        (i) =>
          i.itemClass === admin.itemClass &&
          i.category === admin.category &&
          i.lineStart !== undefined &&
          admin.lineStart !== undefined &&
          i.lineStart <= (admin.lineEnd ?? admin.lineStart) + 2 &&
          admin.lineStart <= (i.lineEnd ?? i.lineStart) + 2 &&
          (admin.itemClass !== "income" ||
            ["scenario", "period", "currency", "minMinor", "maxMinor"].every(
              (k) => {
                const key = k as
                  | "scenario"
                  | "period"
                  | "currency"
                  | "minMinor"
                  | "maxMinor";
                return (
                  (key === "maxMinor" ? (i.maxMinor ?? i.minMinor) : i[key]) ===
                  (key === "maxMinor"
                    ? (admin.maxMinor ?? admin.minMinor)
                    : admin[key])
                );
              },
            )) &&
          (admin.itemClass !== "objection" ||
            i.resolution === admin.resolution),
      );
      if (match) {
        found++;
        inventory.splice(inventory.indexOf(match), 1);
      } else shared++;
    }
  }
  return { dimensions, inventoryMisses: { found, shared } };
}
export const judgeCalibration = query({
  args: { campaign: v.string() },
  returns: calibrationValidator,
  handler: async (ctx, args) => {
    const me = await requireAdminContext(ctx);
    const rows = await campaignCases(ctx, me.tenantId, args.campaign);
    const cases: CalibrationCase[] = [];
    for (const row of rows)
      if (row.split === "calib" && row.purgeAt > Date.now())
        cases.push({ case: row, labels: await caseLabels(ctx, row._id) });
    return calibration(cases);
  },
});
