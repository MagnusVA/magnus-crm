import { v } from "convex/values";
import type { Doc, Id } from "../../_generated/dataModel";
import { internal } from "../../_generated/api";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../../_generated/server";
import { rejectRequest } from "../../lib/observability/errors";
import { effectiveSettings, servingConfig } from "../settings";
import type { RunConfig } from "../validators";
import { caseLabels, itemClassValidator, requireAdminContext } from "./cases";
import {
  assertNoRunningJob,
  campaignCases,
  candidatesFromRun,
  createEvalJob,
  liveCase,
} from "./judge";
import { type Candidate } from "./judgePrompt";
import { computeMetrics, type MetricCase } from "./metrics";

type Label = Doc<"callInsightEvalLabels">;
export type Match = {
  candidate: Candidate;
  label: Label;
  wrongFields: string[];
};
export type Matches = {
  matched: Match[];
  missing: Label[];
  changed: Match[];
  new: Candidate[];
};

function samePosition(c: Candidate, l: Label) {
  if (c.itemClass !== l.itemClass) return false;
  if (c.itemClass === "result" || c.itemClass === "attendance") return true;
  if (c.category !== l.category) return false;
  return (
    c.lineStart !== undefined &&
    l.lineStart !== undefined &&
    c.lineStart <= (l.lineEnd ?? l.lineStart) + 2 &&
    l.lineStart <= (c.lineEnd ?? c.lineStart) + 2
  );
}
function differences(c: Candidate, l: Label): string[] {
  if (c.itemClass === "income")
    return (
      ["scenario", "period", "currency", "minMinor", "maxMinor"] as const
    ).filter(
      (k) =>
        (k === "maxMinor" ? (c.maxMinor ?? c.minMinor) : c[k]) !==
        (k === "maxMinor" ? (l.maxMinor ?? l.minMinor) : l[k]),
    );
  if (c.itemClass === "objection")
    return (c.resolution ?? "unknown") === (l.resolution ?? "unknown")
      ? []
      : ["resolution"];
  if (c.itemClass === "result")
    return [
      ...(c.resultKind !== l.resultKind ? ["resultKind"] : []),
      ...(
        [
          "amountMinor",
          "currency",
          "paymentType",
          "callbackAt",
          "lossCategory",
          "contactMethod",
        ] as const
      ).filter((k) => c.resultValues?.[k] !== l.resultValues?.[k]),
    ];
  if (c.itemClass === "attendance") {
    if (l.source === "admin")
      return (l.category === "held") === ((c.noShowTier ?? "none") === "none")
        ? []
        : ["attendance"];
    return c.noShowTier === l.noShowTier ? [] : ["noShowTier"];
  }
  return [];
}
/** Admin inventory and its matched extractor label describe one reference item, not two. */
function referenceLabels(labels: Label[]): Label[] {
  const admin = labels.filter((l) => l.source === "admin");
  const linked = new Set(admin.map((l) => l.matchedLabelId).filter(Boolean));
  return [
    ...admin,
    ...labels.filter(
      (l) =>
        l.source === "extractor" &&
        !linked.has(l._id) &&
        !(
          ["result", "attendance"].includes(l.itemClass) &&
          admin.some((a) => a.itemClass === l.itemClass)
        ),
    ),
  ];
}
/** Match globally nearest spans first, using each reference and each candidate once. */
export function matchToLabels(
  candidates: readonly Candidate[],
  labels: Label[],
): Matches {
  const refs = referenceLabels(labels);
  const pairs = candidates.flatMap((candidate, ci) =>
    refs.flatMap((label, li) =>
      samePosition(candidate, label)
        ? [
            {
              ci,
              li,
              distance: Math.abs(
                (candidate.lineStart ?? 0) - (label.lineStart ?? 0),
              ),
            },
          ]
        : [],
    ),
  );
  pairs.sort((a, b) => a.distance - b.distance || a.ci - b.ci || a.li - b.li);
  const usedCandidates = new Set<number>(),
    usedLabels = new Set<number>();
  const result: Matches = { matched: [], changed: [], missing: [], new: [] };
  for (const pair of pairs) {
    if (usedCandidates.has(pair.ci) || usedLabels.has(pair.li)) continue;
    usedCandidates.add(pair.ci);
    usedLabels.add(pair.li);
    const match = {
      candidate: candidates[pair.ci],
      label: refs[pair.li],
      wrongFields: differences(candidates[pair.ci], refs[pair.li]),
    };
    (match.wrongFields.length ? result.changed : result.matched).push(match);
  }
  result.missing = refs.filter(
    (l, i) =>
      !usedLabels.has(i) &&
      (l.source === "admin" || l.adminVerdict === "right"),
  );
  result.new = candidates.filter((_, i) => !usedCandidates.has(i));
  return result;
}
export const startRegression = mutation({
  args: {
    campaign: v.string(),
    candidate: v.object({
      model: v.optional(v.string()),
      promptVersion: v.optional(v.string()),
      itemCheck: v.optional(v.boolean()),
    }),
  },
  returns: v.union(v.id("callInsightJobs"), v.null()),
  handler: async (ctx, args) => {
    const me = await requireAdminContext(ctx);
    await assertNoRunningJob(ctx, me.tenantId);
    const tenant = await ctx.db.get("tenants", me.tenantId);
    const settings = effectiveSettings(tenant);
    if (!settings || settings.evalMonthlyUsd <= 0) return null;
    if (
      (args.candidate.model !== undefined &&
        !["anthropic/claude-sonnet-5.5", "anthropic/claude-opus-5.5"].includes(
          args.candidate.model,
        )) ||
      (args.candidate.promptVersion !== undefined &&
        args.candidate.promptVersion !== servingConfig(settings).promptVersion)
    )
      throw rejectRequest(
        "call_insights.eval_candidate",
        "Choose a supported candidate configuration.",
      );
    const candidateConfig: RunConfig = {
      ...servingConfig(settings),
      ...Object.fromEntries(
        Object.entries(args.candidate).filter(([, v]) => v !== undefined),
      ),
    };
    const rows = await campaignCases(ctx, me.tenantId, args.campaign),
      eligible = [];
    for (const row of rows)
      if (
        (row.status === "labels_committed" || row.status === "closed") &&
        (await liveCase(ctx, row))
      )
        eligible.push(row);
    return await createEvalJob(ctx, {
      tenantId: me.tenantId,
      userId: me.userId,
      campaign: args.campaign,
      kind: "eval_regression",
      cases: eligible,
      ceilingUsd: settings.evalMonthlyUsd,
      candidateConfig,
    });
  },
});
const itemArgs = {
  jobId: v.id("callInsightJobs"),
  jobItemId: v.id("callInsightJobItems"),
};
export const reextract = internalMutation({
  args: itemArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get("callInsightJobs", args.jobId);
    const item = await ctx.db.get("callInsightJobItems", args.jobItemId);
    if (
      !job ||
      job.kind !== "eval_regression" ||
      !job.candidateConfig ||
      !item ||
      item.jobId !== job._id ||
      item.status !== "running" ||
      item.runId
    )
      return null;
    const row = (
      await ctx.db
        .query("callInsightEvalCases")
        .withIndex("by_recordingId_and_campaign", (q) =>
          q
            .eq("recordingId", item.recordingId)
            .eq("campaign", job.campaign ?? ""),
        )
        .take(2)
    ).find((c) => c.tenantId === job.tenantId);
    if (
      job.status !== "running" ||
      !row ||
      (row.status !== "labels_committed" && row.status !== "closed") ||
      !(await liveCase(ctx, row))
    ) {
      await ctx.scheduler.runAfter(0, internal.callInsights.jobs.itemFinished, {
        ...args,
        outcome: "skipped",
      });
      return null;
    }
    const runId = await ctx.db.insert("callInsightRuns", {
      tenantId: job.tenantId,
      recordingId: row.recordingId,
      meetingId: row.meetingId,
      purpose: "eval",
      evalRole: "candidate",
      evalCaseId: row._id,
      jobId: job._id,
      generation: 0,
      inputKey: `${row.recordingId}:eval:candidate:${row._id}:${job._id}`,
      trigger: "eval",
      kind: "full",
      status: "queued",
      attempt: 0,
      config: job.candidateConfig,
      receipts: [],
      nextAttemptAt: Date.now(),
      quotesExpireAt: row.purgeAt,
      createdAt: Date.now(),
    });
    await ctx.db.patch("callInsightJobItems", item._id, { runId });
    await ctx.scheduler.runAfter(0, internal.callInsights.run.read, { runId });
    return null;
  },
});

type Evaluated = {
  row: Doc<"callInsightEvalCases">;
  labels: Label[];
  run: Doc<"callInsightRuns">;
  candidates: Candidate[];
  matches: Matches;
};
async function evaluatedCases(
  ctx: QueryCtx | MutationCtx,
  job: Doc<"callInsightJobs">,
): Promise<Evaluated[]> {
  const runs = await ctx.db
    .query("callInsightRuns")
    .withIndex("by_jobId", (q) => q.eq("jobId", job._id))
    .take(101);
  if (runs.length > 100)
    throw rejectRequest(
      "call_insights.eval_limit",
      "This job is too large for one report.",
    );
  const results: Evaluated[] = [];
  const settings = effectiveSettings(await ctx.db.get("tenants", job.tenantId));
  for (const run of runs) {
    if (
      run.purpose !== "eval" ||
      run.evalRole !== "candidate" ||
      run.status !== "answered" ||
      !run.evalCaseId ||
      run.quotesPurgedAt !== undefined
    )
      continue;
    const row = await ctx.db.get("callInsightEvalCases", run.evalCaseId);
    if (
      !row ||
      row.tenantId !== job.tenantId ||
      row.purgeAt <= Date.now() ||
      (row.status !== "labels_committed" && row.status !== "closed")
    )
      continue;
    const labels = await caseLabels(ctx, row._id);
    const candidates = candidatesFromRun(run, settings?.noShowWaitMinutes);
    results.push({
      row,
      labels,
      run,
      candidates,
      matches: matchToLabels(candidates, labels),
    });
  }
  return results;
}
/** Rebind the committed human truth to candidate items before using F1's fixed-sample metrics. */
function metricCase(e: Evaluated): MetricCase {
  const pairs = [...e.matches.matched, ...e.matches.changed];
  const admin = e.labels
    .filter((l) => l.source === "admin")
    .map((l) => ({
      ...l,
      matchedLabelId: undefined as Id<"callInsightEvalLabels"> | undefined,
    }));
  const extracted: MetricCase["labels"] = e.candidates.map((c, i) => {
    const pair = pairs.find((p) => p.candidate.key === c.key);
    const _id = `${e.run._id}:${i}` as Id<"callInsightEvalLabels">;
    const label = pair?.label;
    const wrong = pair?.wrongFields.length
      ? pair.wrongFields
      : (label?.wrongFields ?? ["exists"]);
    const verdict =
      pair && !pair.wrongFields.length
        ? (label?.adminVerdict ?? "right")
        : "wrong";
    const own = label ? admin.find((a) => a._id === label._id) : undefined;
    if (own) own.matchedLabelId = _id;
    return {
      _id,
      source: "extractor",
      itemClass: c.itemClass,
      itemKey: c.key,
      category: c.category,
      resolution: c.resolution,
      adminVerdict: verdict,
      wrongFields: verdict === "right" ? [] : wrong,
      resultKind: c.resultKind,
      resultTier: c.resultTier,
      resultValues: c.resultValues,
      noShowTier: c.noShowTier,
    };
  });
  return { case: e.row, labels: [...admin, ...extracted], items: e.run.items };
}
export const buildReport = internalMutation({
  args: { jobId: v.id("callInsightJobs") },
  returns: v.union(v.id("callInsightEvalReports"), v.null()),
  handler: async (ctx, args) => {
    const job = await ctx.db.get("callInsightJobs", args.jobId);
    if (!job || job.kind !== "eval_regression" || job.status !== "done")
      return null;
    const existing = await ctx.db
      .query("callInsightEvalReports")
      .withIndex("by_tenantId_and_kind_and_createdAt", (q) =>
        q.eq("tenantId", job.tenantId).eq("kind", "regression"),
      )
      .order("desc")
      .take(100);
    const prior = existing.find((r) => r.jobId === job._id);
    if (prior) return prior._id;
    const evaluated = await evaluatedCases(ctx, job);
    const people = new Set<string>();
    const independent = evaluated
      .sort((a, b) => a.row.createdAt - b.row.createdAt)
      .filter((e) => {
        if (people.has(e.row.groupKey)) return false;
        people.add(e.row.groupKey);
        return true;
      });
    const moneyItems = independent
      .flatMap((e) => referenceLabels(e.labels))
      .filter(
        (l) =>
          ["income", "result"].includes(l.itemClass) &&
          (l.source === "admin" || l.adminVerdict === "right"),
      ).length;
    const bars = computeMetrics(independent.map(metricCase), "quality").map(
      (b) => ({
        ...b,
        result:
          independent.length < 15 ||
          (["income_right", "invented_income"].includes(b.key) &&
            moneyItems < 10)
            ? ("inconclusive" as const)
            : b.result,
      }),
    );
    let flags = 0,
      moneyN = 0;
    for (const e of independent) {
      moneyN += referenceLabels(e.labels).filter((l) =>
        ["income", "result"].includes(l.itemClass),
      ).length;
      flags += e.matches.missing.filter((l) =>
        ["income", "result"].includes(l.itemClass),
      ).length;
      flags += e.matches.changed.filter((m) =>
        ["income", "result"].includes(m.label.itemClass),
      ).length;
      flags += e.matches.new.filter((c) => c.itemClass === "income").length;
    }
    bars.push({
      key: "regression_money_review",
      n:
        moneyN +
        independent.reduce(
          (n, e) =>
            n + e.matches.new.filter((c) => c.itemClass === "income").length,
          0,
        ),
      wrong: flags,
      calls: independent.length,
      floor: 10,
      rule: "a person reviews every missing or changed money label and new income item",
      result: flags
        ? "fail"
        : independent.length < 15 || moneyItems < 10
          ? "inconclusive"
          : "pass",
    });
    return await ctx.db.insert("callInsightEvalReports", {
      tenantId: job.tenantId,
      kind: "regression",
      campaign: job.campaign,
      config: job.candidateConfig,
      bars,
      spentMicroUsd: job.spentMicroUsd,
      jobId: job._id,
      createdByUserId: job.createdByUserId,
      createdAt: Date.now(),
    });
  },
});
const detailItemValidator = v.object({
  key: v.string(),
  itemClass: itemClassValidator,
  category: v.optional(v.string()),
  lineStart: v.optional(v.number()),
  lineEnd: v.optional(v.number()),
});
export const regressionDetail = query({
  args: { reportId: v.id("callInsightEvalReports") },
  returns: v.array(
    v.object({
      caseId: v.id("callInsightEvalCases"),
      recordingId: v.id("callRecordings"),
      missing: v.array(detailItemValidator),
      changed: v.array(detailItemValidator),
      new: v.array(detailItemValidator),
    }),
  ),
  handler: async (ctx, args) => {
    const me = await requireAdminContext(ctx);
    const report = await ctx.db.get("callInsightEvalReports", args.reportId);
    if (
      !report ||
      report.tenantId !== me.tenantId ||
      report.kind !== "regression" ||
      !report.jobId
    )
      throw rejectRequest(
        "call_insights.eval_report_unavailable",
        "This regression report is unavailable.",
      );
    const job = await ctx.db.get("callInsightJobs", report.jobId);
    if (!job || job.tenantId !== me.tenantId) return [];
    const safe = (
      c: Pick<
        Candidate,
        "key" | "itemClass" | "category" | "lineStart" | "lineEnd"
      >,
    ) => ({
      key: c.key,
      itemClass: c.itemClass,
      category: c.category,
      lineStart: c.lineStart,
      lineEnd: c.lineEnd,
    });
    return (await evaluatedCases(ctx, job)).map((e) => ({
      caseId: e.row._id,
      recordingId: e.row.recordingId,
      missing: e.matches.missing.map((l) =>
        safe({ ...l, key: l.itemKey ?? String(l._id) }),
      ),
      changed: e.matches.changed.map((m) => safe(m.candidate)),
      new: e.matches.new.map(safe),
    }));
  },
});
