import { v } from "convex/values";
import { mutation, query, type QueryCtx } from "../../_generated/server";
import schema from "../../schema";
import type { Id } from "../../_generated/dataModel";
import { rejectRequest } from "../../lib/observability/errors";
import { readLiveQueryRows } from "../../lib/liveQueryBounds";
import { requireAdminContext, caseLabels, splitValidator } from "./cases";
import { computeMetrics, type MetricCase } from "./metrics";

const kindValidator = v.union(
  v.literal("quality"),
  v.literal("suggestions"),
  v.literal("no_show"),
);
export const reportValidator = v.object({
  ...schema.tables.callInsightEvalReports.validator.fields,
  _id: v.id("callInsightEvalReports"),
  _creationTime: v.number(),
});
export const buildReport = mutation({
  args: { campaign: v.string(), split: splitValidator, kind: kindValidator },
  returns: v.id("callInsightEvalReports"),
  handler: async (ctx, args) => {
    const me = await requireAdminContext(ctx);
    const { rows, capped } = await readLiveQueryRows(
      ctx.db
        .query("callInsightEvalCases")
        .withIndex("by_tenantId_and_campaign_and_split", (q) =>
          q
            .eq("tenantId", me.tenantId)
            .eq("campaign", args.campaign)
            .eq("split", args.split),
        ),
      100,
    );
    if (capped)
      throw rejectRequest(
        "call_insights.eval_limit",
        "This campaign is too large for one report.",
      );
    const input: MetricCase[] = [];
    for (const row of rows) {
      if (
        (row.status !== "labels_committed" && row.status !== "closed") ||
        row.purgeAt <= Date.now()
      )
        continue;
      const run = row.candidateRunId
        ? await ctx.db.get("callInsightRuns", row.candidateRunId)
        : null;
      const meeting = await ctx.db.get("meetings", row.meetingId);
      const validRun =
        run?.tenantId === me.tenantId && run.recordingId === row.recordingId
          ? run
          : null;
      const m = validRun?.measures;
      const hardCaseHeld =
        !!m &&
        (!m.closerOnly ||
          m.startOffsetSeconds > 180 ||
          m.otherRecordingsAny > 0 ||
          m.newerBooking ||
          m.answerLikePairs > 0 ||
          !!validRun?.attendance?.someoneThere.length ||
          !!validRun?.attendance?.secondPerson.length);
      input.push({
        case: row,
        labels: await caseLabels(ctx, row._id),
        items: validRun?.items,
        recordedKind:
          meeting?.tenantId === me.tenantId ? meeting.status : undefined,
        hardCaseHeld,
      });
    }
    return await ctx.db.insert("callInsightEvalReports", {
      tenantId: me.tenantId,
      ...args,
      bars: computeMetrics(input, args.kind),
      spentMicroUsd: 0,
      createdByUserId: me.userId,
      createdAt: Date.now(),
    });
  },
});
async function newestReports(ctx: QueryCtx, tenantId: Id<"tenants">) {
  const reports = [];
  let capped = false;
  for (const kind of [
    "quality",
    "judge_calibration",
    "regression",
    "drift",
    "suggestions",
    "no_show",
    "wait_study",
  ] as const) {
    const read = await readLiveQueryRows(
      ctx.db
        .query("callInsightEvalReports")
        .withIndex("by_tenantId_and_kind_and_createdAt", (q) =>
          q.eq("tenantId", tenantId).eq("kind", kind),
        )
        .order("desc"),
      200,
    );
    capped ||= read.capped;
    const seen = new Set<string>();
    for (const row of read.rows) {
      const split = row.split ?? "";
      if (!seen.has(split)) {
        reports.push(row);
        seen.add(split);
      }
    }
  }
  return { reports, capped };
}
export const latestReports = query({
  args: {},
  returns: v.object({ reports: v.array(reportValidator), capped: v.boolean() }),
  handler: async (ctx) => {
    const me = await requireAdminContext(ctx);
    return await newestReports(ctx, me.tenantId);
  },
});
export const CAPABILITY_BARS = {
  whatTheySaid: [
    "invented_income",
    "income_right",
    "objection_precision",
    "objection_recall",
    "resolution_right",
  ],
  suggestions: [
    "right_result",
    "callback_date",
    "loss_category",
    "actionable_coverage",
    "promise_as_paid",
    "named_currency",
    "usd_assumed",
    "wrong_review",
    "no_show_coverage",
    "no_show_check",
  ],
  amountPrefill: [
    "right_result",
    "promise_as_paid",
    "named_currency",
    "usd_assumed",
    "amount_carried",
    "amount_prefill",
  ],
  noShowCertain: [
    "wrong_review",
    "no_show_coverage",
    "no_show_check",
    "hard_held_certain",
    "wrong_certain",
  ],
} as const;
export const capabilityStatus = query({
  args: {},
  returns: v.object({
    capabilities: v.array(
      v.object({
        key: v.string(),
        bars: v.array(
          v.object({
            key: v.string(),
            result: v.union(
              v.literal("pass"),
              v.literal("fail"),
              v.literal("inconclusive"),
            ),
          }),
        ),
        result: v.union(
          v.literal("pass"),
          v.literal("fail"),
          v.literal("inconclusive"),
        ),
      }),
    ),
    capped: v.boolean(),
  }),
  handler: async (ctx) => {
    const me = await requireAdminContext(ctx);
    const { reports, capped } = await newestReports(ctx, me.tenantId);
    // Development and calibration describe quality; only fresh holdout labels certify visibility.
    const bars = reports
      .filter(
        (r) =>
          r.split === "holdout" &&
          ["quality", "suggestions", "no_show"].includes(r.kind),
      )
      .flatMap((r) => r.bars);
    const capabilities = Object.entries(CAPABILITY_BARS).map(
      ([key, depends]) => {
        const required = depends.map((key) => ({
          key,
          result:
            bars.find((b) => b.key === key)?.result ??
            ("inconclusive" as const),
        }));
        return {
          key,
          bars: required,
          result: required.some((b) => b.result === "fail")
            ? ("fail" as const)
            : required.every((b) => b.result === "pass")
              ? ("pass" as const)
              : ("inconclusive" as const),
        };
      },
    );
    return { capabilities, capped };
  },
});
