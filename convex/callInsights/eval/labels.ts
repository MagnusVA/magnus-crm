import { v } from "convex/values";
import type { Doc, Id } from "../../_generated/dataModel";
import { mutation, type MutationCtx } from "../../_generated/server";
import { rejectRequest } from "../../lib/observability/errors";
import {
  itemKindValidator,
  suggestionKindValidator,
  suggestionValuesValidator,
} from "../validators";
import {
  requireAdminContext,
  loadCase,
  caseLabels,
  labelValueFields,
  verdictValidator,
  assertCategory,
} from "./cases";

const caseArg = { caseId: v.id("callInsightEvalCases") };
const labelArg = { labelId: v.id("callInsightEvalLabels") };
export const WRONG_FIELDS = [
  "exists",
  "speaker",
  "category",
  "resolution",
  "scenario",
  "period",
  "currency",
  "currencyAssumed",
  "minMinor",
  "maxMinor",
  "kind",
  "resultKind",
  "tier",
  "resultTier",
  "amountMinor",
  "paymentType",
  "programId",
  "callbackAt",
  "contactMethod",
  "lossCategory",
  "noShowReason",
  "attendance",
  "noShowTier",
] as const;

function wrongFields(fields: string[] | undefined) {
  if (fields?.some((f) => !(WRONG_FIELDS as readonly string[]).includes(f)))
    throw rejectRequest(
      "call_insights.eval_wrong_field",
      "Choose a field from the grading form.",
    );
}
function assertPhase(
  row: Doc<"callInsightEvalCases">,
  phase: "to_read" | "list_committed",
) {
  if (row.status !== phase)
    throw rejectRequest(
      "call_insights.eval_phase",
      "This case is in a different grading phase.",
    );
}
function assertValues(values: {
  currency?: string;
  minMinor?: number;
  maxMinor?: number;
  resultValues?: Doc<"callInsightEvalLabels">["resultValues"];
}) {
  const currency = values.currency ?? values.resultValues?.currency;
  if (
    currency !== undefined &&
    !["USD", "CAD", "AUD", "EUR", "GBP", "HNL", "MXN"].includes(currency)
  )
    throw rejectRequest(
      "call_insights.eval_currency",
      "Choose a supported currency.",
    );
  for (const n of [
    values.minMinor,
    values.maxMinor,
    values.resultValues?.amountMinor,
  ])
    if (n !== undefined && (!Number.isSafeInteger(n) || n < 0))
      throw rejectRequest(
        "call_insights.eval_amount",
        "Enter a non-negative amount in minor units.",
      );
  if (
    values.minMinor !== undefined &&
    values.maxMinor !== undefined &&
    values.maxMinor < values.minMinor
  )
    throw rejectRequest(
      "call_insights.eval_amount",
      "The maximum must be at least the minimum.",
    );
  if (
    values.resultValues?.callbackAt !== undefined &&
    !Number.isFinite(values.resultValues.callbackAt)
  )
    throw rejectRequest(
      "call_insights.eval_date",
      "Enter a valid call-back time.",
    );
}
async function ownedLabel(
  ctx: MutationCtx,
  labelId: Id<"callInsightEvalLabels">,
) {
  const me = await requireAdminContext(ctx);
  const label = await ctx.db.get("callInsightEvalLabels", labelId);
  if (!label || label.tenantId !== me.tenantId)
    throw rejectRequest(
      "call_insights.eval_label_unavailable",
      "This quality label is unavailable.",
    );
  const row = await loadCase(ctx, label.caseId, me.tenantId);
  return { me, label, row };
}

export const addAdminItem = mutation({
  args: {
    ...caseArg,
    itemClass: itemKindValidator,
    category: v.optional(v.string()),
    lineStart: v.number(),
    lineEnd: v.number(),
    resolution: labelValueFields.resolution,
    scenario: labelValueFields.scenario,
    period: labelValueFields.period,
    currency: labelValueFields.currency,
    minMinor: labelValueFields.minMinor,
    maxMinor: labelValueFields.maxMinor,
  },
  returns: v.id("callInsightEvalLabels"),
  handler: async (ctx, args) => {
    const me = await requireAdminContext(ctx);
    const row = await loadCase(ctx, args.caseId, me.tenantId);
    assertPhase(row, "to_read");
    assertCategory(args.itemClass, args.category);
    assertValues(args);
    const recording = await ctx.db.get("callRecordings", row.recordingId);
    if (
      !Number.isSafeInteger(args.lineStart) ||
      !Number.isSafeInteger(args.lineEnd) ||
      args.lineStart < 1 ||
      args.lineEnd < args.lineStart ||
      args.lineEnd > (recording?.transcriptLineCount ?? 0)
    )
      throw rejectRequest(
        "call_insights.eval_lines",
        "Choose lines in this transcript.",
      );
    const labels = await caseLabels(ctx, row._id);
    if (labels.filter((l) => l.source === "admin").length >= 60)
      throw rejectRequest(
        "call_insights.eval_item_limit",
        "This case has reached its item limit.",
      );
    return await ctx.db.insert("callInsightEvalLabels", {
      ...args,
      tenantId: me.tenantId,
      source: "admin",
      adminVerdict: "right",
      labelRevision: row.labelRevision + 1,
      createdAt: Date.now(),
    });
  },
});
export const removeAdminItem = mutation({
  args: labelArg,
  returns: v.null(),
  handler: async (ctx, { labelId }) => {
    await requireAdminContext(ctx);
    const { label, row } = await ownedLabel(ctx, labelId);
    assertPhase(row, "to_read");
    if (label.source !== "admin")
      throw rejectRequest(
        "call_insights.eval_source",
        "Only your own items can be removed.",
      );
    await ctx.db.delete("callInsightEvalLabels", labelId);
    return null;
  },
});
export const setAdminResult = mutation({
  args: {
    ...caseArg,
    resultKind: suggestionKindValidator,
    resultValues: v.optional(suggestionValuesValidator),
    noShowHeld: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const me = await requireAdminContext(ctx);
    const row = await loadCase(ctx, args.caseId, me.tenantId);
    assertPhase(row, "to_read");
    assertValues(args);
    const labels = await caseLabels(ctx, row._id);
    for (const itemClass of ["result", "attendance"] as const) {
      const data = {
        itemClass,
        ...(itemClass === "result"
          ? {
              resultKind: args.resultKind,
              resultValues: args.resultValues ?? {},
            }
          : { category: args.noShowHeld ? "held" : "no_show" }),
        adminVerdict: "right" as const,
        labelRevision: row.labelRevision + 1,
      };
      const existing = labels.find(
        (l) => l.source === "admin" && l.itemClass === itemClass,
      );
      if (existing)
        await ctx.db.patch("callInsightEvalLabels", existing._id, data);
      else
        await ctx.db.insert("callInsightEvalLabels", {
          ...data,
          tenantId: me.tenantId,
          caseId: row._id,
          source: "admin",
          createdAt: Date.now(),
        });
    }
    return null;
  },
});

export const commitList = mutation({
  args: { ...caseArg, skipped: v.optional(v.boolean()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const me = await requireAdminContext(ctx);
    const row = await loadCase(ctx, args.caseId, me.tenantId);
    assertPhase(row, "to_read");
    const labels = await caseLabels(ctx, row._id);
    const own = labels.filter((l) => l.source === "admin");
    if (
      args.skipped
        ? own.length > 0
        : !own.some((l) => l.itemClass === "result") ||
          !own.some((l) => l.itemClass === "attendance")
    )
      throw rejectRequest(
        "call_insights.eval_list_incomplete",
        "Record the result and attendance, or skip an empty list.",
      );
    const run = row.candidateRunId
      ? await ctx.db.get("callInsightRuns", row.candidateRunId)
      : null;
    if (
      !run ||
      run.tenantId !== me.tenantId ||
      run.recordingId !== row.recordingId ||
      run.quotesPurgedAt !== undefined
    )
      throw rejectRequest(
        "call_insights.eval_run_unavailable",
        "This reading is unavailable.",
      );
    const common = {
      tenantId: me.tenantId,
      caseId: row._id,
      source: "extractor" as const,
      labelRevision: row.labelRevision + 1,
      createdAt: Date.now(),
    };
    for (const item of run.items ?? []) {
      await ctx.db.insert("callInsightEvalLabels", {
        ...common,
        itemClass: item.kind,
        itemKey: item.key,
        category: item.category,
        lineStart: item.lineIndex,
        lineEnd: item.lineIndex,
        resolution: item.resolution,
        scenario: item.scenario,
        period: item.period,
        currency: item.currency,
        minMinor: item.minMinor,
        maxMinor: item.maxMinor,
      });
    }
    const suggestion = await ctx.db
      .query("resultSuggestionStates")
      .withIndex("by_recordingId", (q) => q.eq("recordingId", row.recordingId))
      .first();
    if (suggestion?.tenantId === me.tenantId && suggestion.runId === run._id) {
      await ctx.db.insert("callInsightEvalLabels", {
        ...common,
        itemClass: "result",
        itemKey: "result",
        resultKind: suggestion.kind,
        resultTier: suggestion.tier,
        resultValues: suggestion.values,
        noShowTier: suggestion.noShowTier,
      });
      await ctx.db.insert("callInsightEvalLabels", {
        ...common,
        itemClass: "attendance",
        itemKey: "attendance",
        noShowTier: suggestion.noShowTier ?? "none",
      });
    } else {
      // No suggestion is still an attendance candidate, including a held call.
      await ctx.db.insert("callInsightEvalLabels", {
        ...common,
        itemClass: "attendance",
        itemKey: "attendance",
        noShowTier: "none",
      });
    }
    await ctx.db.patch("callInsightEvalCases", row._id, {
      status: "list_committed",
      listCommittedAt: Date.now(),
    });
    return null;
  },
});
export const gradeItem = mutation({
  args: {
    ...labelArg,
    verdict: verdictValidator,
    wrongFields: v.optional(v.array(v.string())),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAdminContext(ctx);
    const { label, row } = await ownedLabel(ctx, args.labelId);
    assertPhase(row, "list_committed");
    if (label.source !== "extractor")
      throw rejectRequest(
        "call_insights.eval_source",
        "Grade an extractor item.",
      );
    wrongFields(args.wrongFields);
    await ctx.db.patch("callInsightEvalLabels", label._id, {
      adminVerdict: args.verdict,
      wrongFields: args.verdict === "wrong" ? (args.wrongFields ?? []) : [],
    });
    return null;
  },
});
export const matchAdminItem = mutation({
  args: {
    ...labelArg,
    matchedLabelId: v.union(v.id("callInsightEvalLabels"), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAdminContext(ctx);
    const { label, row } = await ownedLabel(ctx, args.labelId);
    assertPhase(row, "list_committed");
    if (
      label.source !== "admin" ||
      label.itemClass === "result" ||
      label.itemClass === "attendance"
    )
      throw rejectRequest(
        "call_insights.eval_source",
        "Match an item from your own list.",
      );
    if (args.matchedLabelId !== null) {
      const target = await ctx.db.get(
        "callInsightEvalLabels",
        args.matchedLabelId,
      );
      if (
        !target ||
        target.tenantId !== row.tenantId ||
        target.caseId !== row._id ||
        target.source !== "extractor" ||
        target.itemClass !== label.itemClass
      )
        throw rejectRequest(
          "call_insights.eval_match",
          "Choose an extractor item from this case and class.",
        );
      const labels = await caseLabels(ctx, row._id);
      if (
        labels.some(
          (l) =>
            l.source === "admin" &&
            l._id !== label._id &&
            l.matchedLabelId === target._id,
        )
      )
        throw rejectRequest(
          "call_insights.eval_match",
          "This extractor item already has a match.",
        );
    }
    await ctx.db.patch("callInsightEvalLabels", label._id, {
      matchedLabelId: args.matchedLabelId ?? undefined,
    });
    return null;
  },
});
export const commitLabels = mutation({
  args: caseArg,
  returns: v.null(),
  handler: async (ctx, { caseId }) => {
    const me = await requireAdminContext(ctx);
    const row = await loadCase(ctx, caseId, me.tenantId);
    assertPhase(row, "list_committed");
    const labels = await caseLabels(ctx, caseId);
    if (labels.some((l) => l.source === "extractor" && !l.adminVerdict))
      throw rejectRequest(
        "call_insights.eval_labels_incomplete",
        "Grade every extractor item first.",
      );
    for (const label of labels)
      await ctx.db.patch("callInsightEvalLabels", label._id, {
        labelRevision: row.labelRevision + 1,
        ...(row.labelRevision > 0
          ? {
              judgeVerdict: undefined,
              judgeWrongFields: undefined,
              judgeLines: undefined,
              judgeRerunVerdict: undefined,
            }
          : {}),
      });
    await ctx.db.patch("callInsightEvalCases", caseId, {
      status: "labels_committed",
      labelRevision: row.labelRevision + 1,
      labelsCommittedAt: Date.now(),
      labelledByUserId: me.userId,
      ...(row.labelRevision > 0
        ? { judgeRunId: undefined, judgeRerunId: undefined }
        : {}),
    });
    return null;
  },
});
export const reopenCase = mutation({
  args: caseArg,
  returns: v.null(),
  handler: async (ctx, { caseId }) => {
    const me = await requireAdminContext(ctx);
    const row = await loadCase(ctx, caseId, me.tenantId);
    if (row.status !== "labels_committed" && row.status !== "closed")
      throw rejectRequest(
        "call_insights.eval_phase",
        "Only committed cases can be reopened.",
      );
    const labels = await caseLabels(ctx, caseId);
    const exposed =
      row.judgeExposed ||
      labels.some(
        (l) =>
          l.judgeVerdict !== undefined || l.judgeRerunVerdict !== undefined,
      );
    await ctx.db.patch("callInsightEvalCases", caseId, {
      status: "list_committed",
      judgeExposed: Boolean(exposed),
    });
    return null;
  },
});

type MatchItem = {
  labelId: string;
  itemClass: string;
  category?: string;
  lineStart?: number;
  lineEnd?: number;
};
/** Nearest overlapping spans first, with stable input-order ties and no reused item. */
export function autoMatch<A extends MatchItem, E extends MatchItem>(
  adminItems: A[],
  extractorItems: E[],
): Array<{ labelId: A["labelId"]; matchedLabelId: E["labelId"] | null }> {
  const pairs = adminItems.flatMap((a, ai) =>
    extractorItems.flatMap((e, ei) =>
      a.itemClass === e.itemClass &&
      a.category === e.category &&
      a.lineStart !== undefined &&
      e.lineStart !== undefined &&
      a.lineStart <= (e.lineEnd ?? e.lineStart) + 2 &&
      e.lineStart <= (a.lineEnd ?? a.lineStart) + 2
        ? [{ ai, ei, distance: Math.abs(a.lineStart - e.lineStart) }]
        : [],
    ),
  );
  pairs.sort((a, b) => a.distance - b.distance || a.ai - b.ai || a.ei - b.ei);
  const matches = new Map<number, number>();
  const used = new Set<number>();
  for (const pair of pairs)
    if (!matches.has(pair.ai) && !used.has(pair.ei)) {
      matches.set(pair.ai, pair.ei);
      used.add(pair.ei);
    }
  return adminItems.map((a, i) => ({
    labelId: a.labelId,
    matchedLabelId: matches.has(i)
      ? extractorItems[matches.get(i)!].labelId
      : null,
  }));
}
