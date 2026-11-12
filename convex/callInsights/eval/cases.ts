import { v, type Infer } from "convex/values";
import type { Doc, Id } from "../../_generated/dataModel";
import {
  action,
  mutation,
  query,
  type QueryCtx,
  type MutationCtx,
} from "../../_generated/server";
import { api } from "../../_generated/api";
import { requireTenantUserFromAction } from "../../requireTenantUserFromAction";
import { readTranscriptPage } from "../../fathom/transcript";
import { transcriptLine, type TranscriptLine } from "../../fathom/validators";
import { requireTenantUser } from "../../requireTenantUser";
import { rejectRequest } from "../../lib/observability/errors";
import { readLiveQueryRows } from "../../lib/liveQueryBounds";
import { isCategory } from "../../../lib/callInsights/taxonomy";
import {
  suggestionValuesValidator,
  suggestionKindValidator,
  suggestionTierValidator,
  noShowTierValidator,
  itemKindValidator,
  incomePeriodValidator,
  incomeScenarioValidator,
  resolutionValidator,
} from "../validators";

export const splitValidator = v.union(
  v.literal("dev"),
  v.literal("calib"),
  v.literal("holdout"),
  v.literal("drift_random"),
  v.literal("drift_risk"),
);
export const statusValidator = v.union(
  v.literal("to_read"),
  v.literal("list_committed"),
  v.literal("labels_committed"),
  v.literal("closed"),
);
export const itemClassValidator = v.union(
  itemKindValidator,
  v.literal("result"),
  v.literal("attendance"),
);
export const verdictValidator = v.union(
  v.literal("right"),
  v.literal("wrong"),
  v.literal("unsure"),
);
export const labelValueFields = {
  category: v.optional(v.string()),
  lineStart: v.optional(v.number()),
  lineEnd: v.optional(v.number()),
  resolution: v.optional(resolutionValidator),
  scenario: v.optional(incomeScenarioValidator),
  period: v.optional(incomePeriodValidator),
  currency: v.optional(v.string()),
  minMinor: v.optional(v.number()),
  maxMinor: v.optional(v.number()),
  resultKind: v.optional(suggestionKindValidator),
  resultTier: v.optional(suggestionTierValidator),
  resultValues: v.optional(suggestionValuesValidator),
  noShowTier: v.optional(noShowTierValidator),
};
export const safeLabelValidator = v.object({
  labelId: v.id("callInsightEvalLabels"),
  itemClass: itemClassValidator,
  itemKey: v.optional(v.string()),
  ...labelValueFields,
  adminVerdict: v.optional(verdictValidator),
  wrongFields: v.optional(v.array(v.string())),
  matchedLabelId: v.optional(v.id("callInsightEvalLabels")),
});
export const caseViewValidator = v.object({
  caseId: v.id("callInsightEvalCases"),
  recordingId: v.id("callRecordings"),
  meetingId: v.id("meetings"),
  campaign: v.string(),
  split: splitValidator,
  status: statusValidator,
  labelRevision: v.number(),
  listSkipped: v.boolean(),
  leadName: v.string(),
  scheduledAt: v.number(),
  purgeAt: v.number(),
  exposedBeforeResult: v.boolean(),
  judgeExposed: v.boolean(),
});

export const requireAdminContext = (ctx: QueryCtx | MutationCtx) =>
  requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);
export async function loadCase(
  ctx: QueryCtx | MutationCtx,
  caseId: Id<"callInsightEvalCases">,
  tenantId: Id<"tenants">,
) {
  const row = await ctx.db.get("callInsightEvalCases", caseId);
  if (!row || row.tenantId !== tenantId || row.purgeAt <= Date.now())
    throw rejectRequest(
      "call_insights.eval_case_unavailable",
      "This quality case is unavailable.",
    );
  return row;
}
export async function caseLabels(
  ctx: QueryCtx | MutationCtx,
  caseId: Id<"callInsightEvalCases">,
) {
  return await ctx.db
    .query("callInsightEvalLabels")
    .withIndex("by_caseId_and_source", (q) => q.eq("caseId", caseId))
    .take(200);
}
export function labelValues(row: Doc<"callInsightEvalLabels">) {
  const {
    category,
    lineStart,
    lineEnd,
    resolution,
    scenario,
    period,
    currency,
    minMinor,
    maxMinor,
    resultKind,
    resultTier,
    resultValues,
    noShowTier,
  } = row;
  return {
    category,
    lineStart,
    lineEnd,
    resolution,
    scenario,
    period,
    currency,
    minMinor,
    maxMinor,
    resultKind,
    resultTier,
    resultValues,
    noShowTier,
  };
}
/** Explicit projection: judge fields cannot leak through a spread of a stored label. */
export function safeLabel(row: Doc<"callInsightEvalLabels">) {
  return {
    labelId: row._id,
    itemClass: row.itemClass,
    itemKey: row.itemKey,
    ...labelValues(row),
    adminVerdict: row.adminVerdict,
    wrongFields: row.wrongFields,
    matchedLabelId: row.matchedLabelId,
  };
}
export function assertCategory(
  kind: Doc<"callInsightEvalLabels">["itemClass"],
  category?: string,
) {
  if (
    kind === "result" ||
    kind === "attendance" ||
    !category ||
    !isCategory(kind, category)
  )
    throw rejectRequest(
      "call_insights.eval_category",
      "Choose a category for this item.",
    );
}
async function caseView(
  ctx: QueryCtx,
  row: Doc<"callInsightEvalCases">,
  labels: Doc<"callInsightEvalLabels">[],
) {
  const meeting = await ctx.db.get("meetings", row.meetingId);
  const deal =
    meeting && meeting.tenantId === row.tenantId
      ? await ctx.db.get("opportunities", meeting.opportunityId)
      : null;
  const lead =
    deal?.tenantId === row.tenantId
      ? await ctx.db.get("leads", deal.leadId)
      : null;
  return {
    caseId: row._id,
    recordingId: row.recordingId,
    meetingId: row.meetingId,
    campaign: row.campaign,
    split: row.split,
    status: row.status,
    labelRevision: row.labelRevision,
    listSkipped:
      row.listCommittedAt !== undefined &&
      !labels.some((l) => l.source === "admin"),
    leadName:
      lead?.tenantId === row.tenantId
        ? (lead.fullName ?? "Unknown person")
        : "Unknown person",
    scheduledAt: meeting?.tenantId === row.tenantId ? meeting.scheduledAt : 0,
    purgeAt: row.purgeAt,
    exposedBeforeResult: row.exposedBeforeResult ?? false,
    judgeExposed: row.judgeExposed ?? false,
  };
}

export const createCampaign = mutation({
  args: { name: v.string() },
  returns: v.object({
    campaign: v.string(),
    dev: v.number(),
    calib: v.number(),
    holdout: v.number(),
    capped: v.boolean(),
  }),
  handler: async (ctx, { name }) => {
    const me = await requireAdminContext(ctx);
    const slug = name
      .trim()
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 70);
    if (!slug)
      throw rejectRequest("call_insights.eval_name", "Enter a campaign name.");
    const campaign = `${slug}-${new Date(Date.now()).toISOString().slice(0, 10)}`;
    const existing = await readLiveQueryRows(
      ctx.db
        .query("callInsightEvalCases")
        .withIndex("by_tenantId_and_campaign_and_split", (q) =>
          q.eq("tenantId", me.tenantId),
        ),
      1000,
    );
    if (existing.capped)
      throw rejectRequest(
        "call_insights.eval_limit",
        "Close older quality campaigns first.",
      );
    if (existing.rows.some((c) => c.campaign === campaign))
      throw rejectRequest(
        "call_insights.eval_campaign_exists",
        "Choose a different campaign name.",
      );
    const used = new Set(
      existing.rows
        .filter(
          (c) =>
            c.split === "dev" || c.split === "calib" || c.split === "holdout",
        )
        .map((c) => c.recordingId),
    );
    const headers = await readLiveQueryRows(
      ctx.db
        .query("callInsightFacts")
        .withIndex("by_tenantId_and_kind_and_scheduledAt", (q) =>
          q.eq("tenantId", me.tenantId).eq("kind", "call"),
        )
        .order("desc"),
      500,
    );
    const tenant = await ctx.db.get("tenants", me.tenantId);
    const counts = { dev: 0, calib: 0, holdout: 0 };
    const people = new Set<string>();
    for (const header of headers.rows) {
      if (
        header.kind !== "call" ||
        !header.active ||
        !header.publishedRunId ||
        used.has(header.recordingId)
      )
        continue;
      const recording = await ctx.db.get("callRecordings", header.recordingId);
      if (
        !recording ||
        recording.tenantId !== me.tenantId ||
        recording.matchStatus !== "matched" ||
        recording.meetingId !== header.meetingId ||
        !recording.transcriptStorageId ||
        recording.transcriptDeletedAt !== undefined ||
        (recording.transcriptExpiresAt ?? 0) <= Date.now() + 14 * 86_400_000
      )
        continue;
      const meeting = await ctx.db.get("meetings", header.meetingId);
      const run = await ctx.db.get("callInsightRuns", header.publishedRunId);
      if (
        !meeting ||
        meeting.tenantId !== me.tenantId ||
        !run ||
        run.tenantId !== me.tenantId ||
        run.recordingId !== recording._id ||
        run.meetingId !== meeting._id ||
        run.purpose !== "serve" ||
        run.status !== "answered"
      )
        continue;
      const deal = await ctx.db.get("opportunities", meeting.opportunityId);
      if (!deal || deal.tenantId !== me.tenantId || people.has(deal.leadId))
        continue;
      people.add(deal.leadId);
      const order = counts.dev + counts.calib + counts.holdout;
      const split = order < 20 ? "dev" : order < 40 ? "calib" : "holdout";
      // Historical mode changes are not retained. Current visibility, plus an actual
      // shown stamp before the saved result, conservatively approximates exposure.
      const suggestion = await ctx.db
        .query("resultSuggestionStates")
        .withIndex("by_recordingId", (q) => q.eq("recordingId", recording._id))
        .first();
      const savedAt = meeting.heldMarkedAt ?? meeting.noShowMarkedAt;
      const exposed =
        tenant?.callInsights?.mode === "on" ||
        tenant?.callInsights?.suggestions === "on" ||
        (suggestion?.shownAt !== undefined &&
          (savedAt === undefined || suggestion.shownAt <= savedAt));
      await ctx.db.insert("callInsightEvalCases", {
        tenantId: me.tenantId,
        recordingId: recording._id,
        meetingId: meeting._id,
        campaign,
        split,
        groupKey: deal.leadId,
        status: "to_read",
        labelRevision: 0,
        candidateRunId: run._id,
        candidateConfig: run.config,
        purgeAt: recording.transcriptExpiresAt!,
        exposedBeforeResult: exposed,
        createdByUserId: me.userId,
        createdAt: Date.now(),
      });
      counts[split]++;
      if (order === 59) break;
    }
    return { campaign, ...counts, capped: headers.capped };
  },
});

export const campaigns = query({
  args: {},
  returns: v.object({
    campaigns: v.array(
      v.object({
        campaign: v.string(),
        counts: v.record(v.string(), v.number()),
        statuses: v.record(v.string(), v.number()),
      }),
    ),
    capped: v.boolean(),
  }),
  handler: async (ctx) => {
    const me = await requireAdminContext(ctx);
    const { rows, capped } = await readLiveQueryRows(
      ctx.db
        .query("callInsightEvalCases")
        .withIndex("by_tenantId_and_campaign_and_split", (q) =>
          q.eq("tenantId", me.tenantId),
        ),
      1000,
    );
    const groups = new Map<
      string,
      {
        campaign: string;
        counts: Record<string, number>;
        statuses: Record<string, number>;
      }
    >();
    for (const row of rows) {
      if (row.purgeAt <= Date.now()) continue;
      const group = groups.get(row.campaign) ?? {
        campaign: row.campaign,
        counts: {},
        statuses: {},
      };
      group.counts[row.split] = (group.counts[row.split] ?? 0) + 1;
      group.statuses[row.status] = (group.statuses[row.status] ?? 0) + 1;
      groups.set(row.campaign, group);
    }
    return { campaigns: [...groups.values()], capped };
  },
});
export const cases = query({
  args: { campaign: v.string(), split: v.optional(splitValidator) },
  returns: v.object({ cases: v.array(caseViewValidator), capped: v.boolean() }),
  handler: async (ctx, args) => {
    const me = await requireAdminContext(ctx);
    const { rows, capped } = await readLiveQueryRows(
      ctx.db
        .query("callInsightEvalCases")
        .withIndex("by_tenantId_and_campaign_and_split", (q) =>
          args.split
            ? q
                .eq("tenantId", me.tenantId)
                .eq("campaign", args.campaign)
                .eq("split", args.split)
            : q.eq("tenantId", me.tenantId).eq("campaign", args.campaign),
        ),
      100,
    );
    const result = [];
    for (const row of rows)
      if (row.purgeAt > Date.now())
        result.push(await caseView(ctx, row, await caseLabels(ctx, row._id)));
    return { cases: result, capped };
  },
});
export const gradingViewValidator = v.object({
  case: caseViewValidator,
  phase: v.union(v.literal("list"), v.literal("grade"), v.literal("done")),
  transcript: v.object({
    recordingId: v.id("callRecordings"),
    lineCount: v.number(),
  }),
  adminItems: v.array(safeLabelValidator),
  candidates: v.optional(
    v.array(
      v.object({
        ...safeLabelValidator.fields,
        statement: v.optional(v.string()),
        quote: v.optional(v.string()),
      }),
    ),
  ),
  suggestion: v.optional(
    v.object({
      kind: suggestionKindValidator,
      tier: suggestionTierValidator,
      noShowTier: v.optional(noShowTierValidator),
      values: suggestionValuesValidator,
    }),
  ),
  judge: v.optional(
    v.array(
      v.object({
        labelId: v.id("callInsightEvalLabels"),
        verdict: v.optional(
          v.union(
            v.literal("supported"),
            v.literal("contradicted"),
            v.literal("insufficient"),
          ),
        ),
        wrongFields: v.optional(v.array(v.string())),
        lines: v.optional(v.array(v.number())),
        rerunVerdict: v.optional(
          v.union(
            v.literal("supported"),
            v.literal("contradicted"),
            v.literal("insufficient"),
          ),
        ),
      }),
    ),
  ),
});
export const caseForGrading = query({
  args: { caseId: v.id("callInsightEvalCases") },
  returns: gradingViewValidator,
  handler: async (
    ctx,
    { caseId },
  ): Promise<Infer<typeof gradingViewValidator>> => {
    const me = await requireAdminContext(ctx);
    const row = await loadCase(ctx, caseId, me.tenantId);
    const labels = await caseLabels(ctx, caseId);
    const recording = await ctx.db.get("callRecordings", row.recordingId);
    const live =
      recording?.tenantId === me.tenantId &&
      recording.matchStatus === "matched" &&
      recording.meetingId === row.meetingId &&
      recording.transcriptStorageId &&
      recording.transcriptDeletedAt === undefined &&
      (recording.transcriptExpiresAt ?? 0) > Date.now();
    const phase =
      row.status === "to_read"
        ? ("list" as const)
        : row.status === "list_committed"
          ? ("grade" as const)
          : ("done" as const);
    const base = {
      case: await caseView(ctx, row, labels),
      phase,
      transcript: {
        recordingId: row.recordingId,
        lineCount: live ? (recording.transcriptLineCount ?? 0) : 0,
      },
      adminItems: labels.filter((l) => l.source === "admin").map(safeLabel),
    };
    if (phase === "list") return base;
    const run = row.candidateRunId
      ? await ctx.db.get("callInsightRuns", row.candidateRunId)
      : null;
    const items =
      live && run?.tenantId === me.tenantId && run.quotesPurgedAt === undefined
        ? (run.items ?? [])
        : [];
    const candidates = labels
      .filter((l) => l.source === "extractor")
      .map((l) => {
        const item = items.find((i) => i.key === l.itemKey);
        return {
          ...safeLabel(l),
          ...(item ? { statement: item.statement, quote: item.quote } : {}),
        };
      });
    const result = labels.find(
      (l) => l.source === "extractor" && l.itemClass === "result",
    );
    return {
      ...base,
      candidates,
      ...(result?.resultKind && result.resultTier
        ? {
            suggestion: {
              kind: result.resultKind,
              tier: result.resultTier,
              noShowTier: result.noShowTier,
              values: result.resultValues ?? {},
            },
          }
        : {}),
      ...(phase === "done"
        ? {
            judge: labels
              .filter(
                (l) =>
                  l.judgeVerdict !== undefined ||
                  l.judgeRerunVerdict !== undefined,
              )
              .map((l) => ({
                labelId: l._id,
                verdict: l.judgeVerdict,
                wrongFields: l.judgeWrongFields,
                lines: l.judgeLines,
                rerunVerdict: l.judgeRerunVerdict,
              })),
          }
        : {}),
    };
  },
});

/** Pages the existing storage reader after authorizing the tenant and quality case. */
export const transcriptPage = action({
  args: {
    caseId: v.id("callInsightEvalCases"),
    page: v.number(),
    pageSize: v.number(),
  },
  returns: v.object({
    lines: v.array(transcriptLine),
    page: v.number(),
    pageCount: v.number(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{ lines: TranscriptLine[]; page: number; pageCount: number }> => {
    await requireTenantUserFromAction(ctx, ["tenant_master", "tenant_admin"]);
    const view: Infer<typeof gradingViewValidator> = await ctx.runQuery(
      api.callInsights.eval.cases.caseForGrading,
      { caseId: args.caseId },
    );
    if (view.transcript.lineCount === 0)
      return { lines: [], page: args.page, pageCount: 0 };
    try {
      return await readTranscriptPage(
        ctx,
        view.transcript.recordingId,
        args.page,
        args.pageSize,
      );
    } catch {
      // Storage validation errors can contain the bad input. Keep it out of errors.
      throw rejectRequest(
        "call_insights.eval_transcript_unavailable",
        "This transcript page is unavailable.",
      );
    }
  },
});
