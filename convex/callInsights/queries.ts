import { v, type Infer } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { query, mutation, type QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { requireTenantUser } from "../requireTenantUser";
import { monthQuery, monthSummary } from "../secondOpinion/month";
import {
  categoryLabel,
  ITEM_KINDS,
  SUGGESTION_KINDS,
  SUGGESTION_KIND_LABELS,
} from "../../lib/callInsights/taxonomy";
import {
  atTime,
  canSeeMeeting,
  insightsViewer,
  visibleHeader,
  VIEWER_ROLES,
  type CallHeader,
  type ItemFact,
} from "./access";
import {
  budgetRow,
  fromMicroUsd,
  monthKeyFor,
  secondOpinionShareMicroUsd,
} from "./budget";
import { initialSettings } from "./settings";
import { previewBackfill } from "./jobs";
import { scopeValidator } from "./admin";
import { compareSuggestion, recordedResultForMeeting } from "./recordedResult";
import {
  liveSuggestionForMeeting,
  presentedNoShowTier,
  suggestionRow,
} from "./suggest/state";
import {
  callInsightsSettingsValidator,
  droppedCountsValidator,
  incomePeriodValidator,
  incomeScenarioValidator,
  itemCheckValidator,
  itemKindValidator,
  noShowTierValidator,
  publishedItemCheckValidator,
  resolutionValidator,
  runReasonValidator,
  runStatusValidator,
  suggestionKindValidator,
  suggestionTierValidator,
  suggestionValuesValidator,
} from "./validators";
import { transcriptGone } from "./retention";

const moneyFields = {
  scenario: v.optional(incomeScenarioValidator),
  period: v.optional(incomePeriodValidator),
  currency: v.optional(v.string()),
  currencyAssumed: v.optional(v.boolean()),
  minMinor: v.optional(v.number()),
  maxMinor: v.optional(v.number()),
  monthlyMinMinor: v.optional(v.number()),
  monthlyMaxMinor: v.optional(v.number()),
  band: v.optional(v.string()),
};
const itemViewValidator = v.object({
  key: v.string(),
  kind: itemKindValidator,
  category: v.string(),
  label: v.string(),
  statement: v.string(),
  quote: v.union(v.string(), v.null()),
  at: v.string(),
  lineIndex: v.number(),
  check: itemCheckValidator,
  isPrimary: v.boolean(),
  resolution: v.optional(resolutionValidator),
  resolutionQuote: v.optional(v.union(v.string(), v.null())),
  deadline: v.optional(v.string()),
  ...moneyFields,
});
const meetingViewValidator = v.object({
  state: v.union(
    v.literal("none"),
    v.literal("queued"),
    v.literal("reading"),
    v.literal("waiting"),
    v.literal("read"),
    v.literal("not_read"),
  ),
  reason: v.optional(runReasonValidator),
  readKind: v.optional(
    v.union(v.literal("full"), v.literal("attendance_only")),
  ),
  analyzedAt: v.optional(v.number()),
  generation: v.optional(v.number()),
  speakerUncertain: v.boolean(),
  quotesDeleted: v.boolean(),
  primaryBlocker: v.optional(v.string()),
  // A newer read is in flight while the published one is still shown.
  rereading: v.boolean(),
  items: v.array(itemViewValidator),
  admin: v.optional(
    v.object({
      runId: v.id("callInsightRuns"),
      recordingId: v.id("callRecordings"),
      costUsd: v.number(),
      model: v.string(),
      promptVersion: v.string(),
      attempt: v.number(),
      dropped: droppedCountsValidator,
      rejected: v.array(
        v.object({
          key: v.string(),
          kind: itemKindValidator,
          category: v.string(),
          label: v.string(),
          statement: v.string(),
          quote: v.union(v.string(), v.null()),
          score: v.optional(v.number()),
          reviewState: v.union(
            v.literal("open"),
            v.literal("restored"),
            v.literal("dismissed"),
            v.literal("superseded"),
          ),
        }),
      ),
      canReadAgain: v.boolean(),
    }),
  ),
});
const emptyMeeting = (): Infer<typeof meetingViewValidator> => ({
  state: "none" as const,
  speakerUncertain: false,
  quotesDeleted: false,
  rereading: false,
  items: [],
});
const noDrops = {
  quoteNotFound: 0,
  notProspect: 0,
  amountNotInQuote: 0,
  badCategory: 0,
  cardNumber: 0,
  overLimit: 0,
};

function money(
  row: ItemFact | NonNullable<Doc<"callInsightRuns">["items"]>[number],
) {
  return {
    scenario: row.scenario,
    period: row.period,
    currency: row.currency,
    currencyAssumed: row.currencyAssumed,
    minMinor: row.minMinor,
    maxMinor: row.maxMinor,
    monthlyMinMinor: row.monthlyMinMinor,
    monthlyMaxMinor: row.monthlyMaxMinor,
    band: row.band,
  };
}

async function meetingHeaders(ctx: QueryCtx, meeting: Doc<"meetings">) {
  const rows = await ctx.db
    .query("callInsightFacts")
    .withIndex("by_meetingId_and_kind", (q) =>
      q.eq("meetingId", meeting._id).eq("kind", "call"),
    )
    .order("desc")
    .take(10);
  return rows.filter((row): row is CallHeader => row.kind === "call");
}

export const forMeeting = query({
  args: { meetingId: v.id("meetings") },
  returns: v.union(v.null(), meetingViewValidator),
  handler: async (ctx, args) => {
    const actor = await requireTenantUser(ctx, [...VIEWER_ROLES]);
    const viewer = await insightsViewer(ctx, actor);
    const meeting = await ctx.db.get("meetings", args.meetingId);
    if (
      !viewer?.settings ||
      (!viewer.isAdmin && viewer.settings.mode !== "on") ||
      !meeting ||
      !(await canSeeMeeting(ctx, viewer, meeting))
    )
      return null;
    const headers = await meetingHeaders(ctx, meeting);
    let header: CallHeader | undefined;
    for (const candidate of headers) {
      if (await visibleHeader(ctx, viewer, meeting, candidate)) {
        header = candidate;
        break;
      }
    }
    if (!header) return emptyMeeting();
    const runId = header.publishedRunId ?? header.latestRunId;
    const run = runId ? await ctx.db.get("callInsightRuns", runId) : null;
    if (
      run &&
      (run.tenantId !== actor.tenantId ||
        run.recordingId !== header.recordingId ||
        run.meetingId !== meeting._id)
    )
      return emptyMeeting();
    const published = !!header.publishedRunId && !!run;
    const state = published
      ? ("read" as const)
      : header.latestStatus === "queued"
        ? ("queued" as const)
        : header.latestStatus === "running" ||
            header.latestStatus === "checking"
          ? ("reading" as const)
          : header.latestStatus === "waiting"
            ? ("waiting" as const)
            : ("not_read" as const);
    // Quotes stop showing the moment the transcript expires, before the cleanup blanks them.
    const source = await ctx.db.get("callRecordings", header.recordingId);
    const purged =
      run?.quotesPurgedAt !== undefined ||
      header.quotesPurgedAt !== undefined ||
      !source ||
      transcriptGone(source, Date.now());
    const items = published
      ? (run.items ?? [])
          .filter((item) => item.check !== "rejected")
          .sort(
            (a, b) => ITEM_KINDS.indexOf(a.kind) - ITEM_KINDS.indexOf(b.kind),
          )
          .map((item) => ({
            key: item.key,
            kind: item.kind,
            category: item.category,
            label: categoryLabel(item.kind, item.category),
            statement: purged ? "" : item.statement,
            quote: purged ? null : item.quote,
            at: atTime(item.atSeconds),
            lineIndex: item.lineIndex,
            check: item.check,
            isPrimary:
              item.kind === "objection" &&
              item.category === header.primaryBlocker,
            resolution: item.resolution,
            resolutionQuote:
              item.resolutionQuote === undefined
                ? undefined
                : purged
                  ? null
                  : item.resolutionQuote,
            deadline: purged ? undefined : item.deadline,
            ...money(item),
          }))
      : [];
    let admin;
    if (viewer.isAdmin && run) {
      const rejected = [];
      for (const item of (run.items ?? []).filter(
        (item) => item.check === "rejected",
      )) {
        const review = await ctx.db
          .query("callInsightItemReviews")
          .withIndex("by_runId_and_itemKey", (q) =>
            q.eq("runId", run._id).eq("itemKey", item.key),
          )
          .first();
        rejected.push({
          key: item.key,
          kind: item.kind,
          category: item.category,
          label: categoryLabel(item.kind, item.category),
          statement: purged ? "" : item.statement,
          quote: purged ? null : item.quote,
          score: item.score,
          reviewState:
            review?.tenantId === actor.tenantId
              ? review.state
              : ("open" as const),
        });
      }
      const recording = await ctx.db.get("callRecordings", header.recordingId);
      admin = {
        runId: run._id,
        recordingId: header.recordingId,
        costUsd:
          run.receipts.reduce(
            (sum, receipt) => sum + (receipt.spentMicroUsd ?? 0),
            0,
          ) / 1e6,
        model: run.config.model,
        promptVersion: run.config.promptVersion,
        attempt: run.attempt,
        dropped: run.dropped ?? noDrops,
        rejected,
        canReadAgain: !!recording && !transcriptGone(recording, Date.now()),
      };
    }
    return {
      state,
      reason:
        state === "not_read" || state === "waiting"
          ? header.reasonCode
          : undefined,
      readKind: published ? header.readKind : undefined,
      analyzedAt: header.analyzedAt,
      generation: header.publishedGeneration,
      speakerUncertain: header.speakerUncertain ?? false,
      quotesDeleted: purged,
      primaryBlocker: published ? header.primaryBlocker : undefined,
      rereading:
        published &&
        header.latestRunId !== header.publishedRunId &&
        ["queued", "running", "checking", "waiting"].includes(
          header.latestStatus,
        ),
      items,
      admin,
    };
  },
});

const personCategory = {
  category: v.string(),
  label: v.string(),
  calls: v.number(),
  lastAt: v.number(),
};
export const forPerson = query({
  args: { leadId: v.id("leads") },
  returns: v.union(
    v.null(),
    v.object({
      callsMatched: v.number(),
      callsRead: v.number(),
      objections: v.array(
        v.object({
          ...personCategory,
          lastResolution: resolutionValidator,
          wasPrimary: v.boolean(),
        }),
      ),
      struggles: v.array(v.object(personCategory)),
      goals: v.array(v.object(personCategory)),
      income: v.array(
        v.object({
          kind: v.string(),
          label: v.string(),
          ...moneyFields,
          at: v.number(),
          check: publishedItemCheckValidator,
        }),
      ),
      dmReportedIncome: v.optional(v.number()),
    }),
  ),
  handler: async (ctx, args) => {
    const actor = await requireTenantUser(ctx, [...VIEWER_ROLES]);
    const viewer = await insightsViewer(ctx, actor);
    const lead = await ctx.db.get("leads", args.leadId);
    if (
      !viewer?.settings ||
      (!viewer.isAdmin && viewer.settings.mode !== "on") ||
      !lead ||
      lead.tenantId !== actor.tenantId
    )
      return null;
    const deals = await ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_leadId", (q) =>
        q.eq("tenantId", actor.tenantId).eq("leadId", lead._id),
      )
      .order("desc")
      .take(25);
    const allowed = deals.filter(
      (deal) =>
        deal.tenantId === actor.tenantId &&
        (viewer.isAdmin || deal.assignedCloserId === actor.userId),
    );
    if (!viewer.isAdmin && allowed.length === 0) return null;
    const meetingGroups = await Promise.all(
      allowed.map((deal) =>
        ctx.db
          .query("meetings")
          .withIndex("by_opportunityId_and_scheduledAt", (q) =>
            q.eq("opportunityId", deal._id),
          )
          .order("desc")
          .take(25),
      ),
    );
    const meetings = meetingGroups
      .flat()
      .filter((meeting) => meeting.tenantId === actor.tenantId)
      .sort((a, b) => b.scheduledAt - a.scheduledAt)
      .slice(0, 25);
    let callsMatched = 0,
      callsRead = 0;
    const items: ItemFact[] = [];
    for (const meeting of meetings) {
      if (!(await canSeeMeeting(ctx, viewer, meeting))) continue;
      for (const header of await meetingHeaders(ctx, meeting)) {
        if (!(await visibleHeader(ctx, viewer, meeting, header))) continue;
        callsMatched++;
        if (!header.publishedRunId) continue;
        const rows = await ctx.db
          .query("callInsightFacts")
          .withIndex("by_recordingId_and_kind", (q) =>
            q.eq("recordingId", header.recordingId),
          )
          .take(61);
        const current = rows.filter(
          (row): row is ItemFact =>
            row.kind !== "call" &&
            row.tenantId === actor.tenantId &&
            row.meetingId === meeting._id &&
            row.publicationRevision === header.publicationRevision,
        );
        if (current.length !== header.expectedItemCount) continue;
        callsRead++;
        items.push(...current);
      }
    }
    const categories = (kind: "objection" | "struggle" | "goal") => {
      const grouped = new Map<string, ItemFact[]>();
      for (const item of items.filter((item) => item.kind === kind))
        grouped.set(item.category, [
          ...(grouped.get(item.category) ?? []),
          item,
        ]);
      return [...grouped].map(([category, rows]) => {
        rows.sort((a, b) => b.scheduledAt - a.scheduledAt);
        return {
          category,
          label: categoryLabel(kind, category),
          calls: new Set(rows.map((row) => row.recordingId)).size,
          lastAt: rows[0].scheduledAt,
          lastResolution: rows[0].resolution ?? ("unknown" as const),
          wasPrimary: rows.some((row) => row.isPrimary),
        };
      });
    };
    const plain = (kind: "struggle" | "goal") =>
      categories(kind).map(({ category, label, calls, lastAt }) => ({
        category,
        label,
        calls,
        lastAt,
      }));
    return {
      callsMatched,
      callsRead,
      objections: categories("objection"),
      struggles: plain("struggle"),
      goals: plain("goal"),
      income: items
        .filter((item) => item.kind === "income")
        .sort((a, b) => b.scheduledAt - a.scheduledAt)
        .map((item) => ({
          kind: item.category,
          label: categoryLabel("income", item.category),
          ...money(item),
          at: item.scheduledAt,
          check: item.check,
        })),
      dmReportedIncome: lead.selfReportedIncome,
    };
  },
});

export const suggestionForMeeting = query({
  args: { meetingId: v.id("meetings") },
  returns: v.union(
    v.null(),
    v.object({
      stateId: v.id("resultSuggestionStates"),
      revision: v.number(),
      kind: suggestionKindValidator,
      tier: suggestionTierValidator,
      noShowTier: v.optional(noShowTierValidator),
      kindLabel: v.string(),
      quotes: v.array(
        v.object({
          label: v.string(),
          quote: v.string(),
          at: v.string(),
          speaker: v.union(
            v.literal("Closer"),
            v.literal("Prospect"),
            v.literal("Other"),
          ),
        }),
      ),
      claudeReading: v.optional(v.string()),
      jevReading: v.optional(v.string()),
      notes: v.array(v.string()),
      values: suggestionValuesValidator,
      amountHintMinor: v.optional(v.number()),
      amountPrefill: v.boolean(),
      programName: v.optional(v.string()),
      shown: v.boolean(),
    }),
  ),
  handler: async (ctx, args) => {
    const actor = await requireTenantUser(ctx, [...VIEWER_ROLES]);
    const viewer = await insightsViewer(ctx, actor);
    const meeting = await ctx.db.get("meetings", args.meetingId);
    if (!viewer || !meeting || !(await canSeeMeeting(ctx, viewer, meeting)))
      return null;
    const row = await liveSuggestionForMeeting(ctx, {
      tenant: viewer.tenant,
      meeting,
      now: Date.now(),
    });
    if (!row) return null;
    const values = row.tier === "ready" ? row.values : {};
    const program = values.programId
      ? await ctx.db.get("tenantPrograms", values.programId)
      : null;
    return {
      stateId: row._id,
      revision: row.revision,
      kind: row.kind,
      tier: row.tier,
      noShowTier: presentedNoShowTier(row, meeting, viewer.tenant, Date.now()),
      kindLabel: SUGGESTION_KIND_LABELS[row.kind],
      quotes: row.quotes.map((quote) => ({
        label: quote.label,
        quote: quote.quote,
        at: atTime(quote.atSeconds),
        speaker: quote.speaker,
      })),
      claudeReading: row.claudeReading,
      jevReading: row.jevReading,
      notes: row.notes,
      values,
      amountHintMinor: values.amountMinor,
      amountPrefill: viewer.settings?.amountPrefill ?? false,
      programName:
        program?.tenantId === actor.tenantId ? program.name : undefined,
      shown: row.shownAt !== undefined,
    };
  },
});

export const markSuggestionShown = mutation({
  args: { stateId: v.id("resultSuggestionStates") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireTenantUser(ctx, [...VIEWER_ROLES]);
    const viewer = await insightsViewer(ctx, actor);
    const row = await ctx.db.get("resultSuggestionStates", args.stateId);
    if (!viewer || !row || row.tenantId !== actor.tenantId) return null;
    const meeting = await ctx.db.get("meetings", row.meetingId);
    if (!meeting || !(await canSeeMeeting(ctx, viewer, meeting))) return null;
    const live = await liveSuggestionForMeeting(ctx, {
      tenant: viewer.tenant,
      meeting,
      now: Date.now(),
    });
    if (!live || live._id !== row._id || row.shownAt !== undefined) return null;
    await ctx.db.patch("resultSuggestionStates", row._id, {
      shownAt: Date.now(),
      shownToUserId: actor.userId,
    });
    return null;
  },
});

const jobViewValidator = v.object({
  jobId: v.id("callInsightJobs"),
  kind: v.union(
    v.literal("backfill"),
    v.literal("rerun"),
    v.literal("eval_judge"),
    v.literal("eval_regression"),
  ),
  status: v.union(
    v.literal("running"),
    v.literal("done"),
    v.literal("canceled"),
  ),
  total: v.number(),
  done: v.number(),
  failed: v.number(),
  skipped: v.number(),
  spentUsd: v.number(),
  ceilingUsd: v.number(),
  estimateUsd: v.number(),
  createdAt: v.number(),
});
export const settings = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      enabled: v.boolean(),
      settings: v.union(v.null(), callInsightsSettingsValidator),
      defaults: callInsightsSettingsValidator,
      secondOpinion: v.object({
        mode: v.union(v.literal("off"), v.literal("shadow"), v.literal("on")),
        capUsd: v.number(),
        spentUsd: v.number(),
      }),
      budget: v.object({
        monthKey: v.string(),
        capUsd: v.number(),
        secondOpinionShareUsd: v.number(),
        limitUsd: v.number(),
        reservedUsd: v.number(),
        spentUsd: v.number(),
        evalSpentUsd: v.number(),
        evalCapUsd: v.number(),
      }),
      waiting: v.number(),
      job: v.union(v.null(), jobViewValidator),
    }),
  ),
  handler: async (ctx) => {
    const actor = await requireTenantUser(ctx, [...VIEWER_ROLES]);
    const viewer = await insightsViewer(ctx, actor);
    if (!viewer?.isAdmin) return null;
    const now = Date.now(),
      monthKey = monthKeyFor(now);
    const defaults = initialSettings(actor.userId, now);
    const config = viewer.tenant.callInsights ?? defaults;
    const [month, budget, waiting, job] = await Promise.all([
      monthSummary(ctx, actor.tenantId, now),
      budgetRow(ctx, actor.tenantId, monthKey),
      ctx.db
        .query("callInsightFacts")
        .withIndex("by_tenantId_and_kind_and_latestStatus", (q) =>
          q
            .eq("tenantId", actor.tenantId)
            .eq("kind", "call")
            .eq("latestStatus", "waiting"),
        )
        .take(1000),
      ctx.db
        .query("callInsightJobs")
        .withIndex("by_tenantId_and_createdAt", (q) =>
          q.eq("tenantId", actor.tenantId),
        )
        .order("desc")
        .first(),
    ]);
    const share = fromMicroUsd(
      secondOpinionShareMicroUsd(viewer.tenant, month.costUsd),
    );
    return {
      enabled: viewer.settings !== null,
      settings: viewer.tenant.callInsights ?? null,
      defaults,
      secondOpinion: {
        mode: viewer.tenant.secondOpinion?.mode ?? ("off" as const),
        capUsd: viewer.tenant.secondOpinion?.monthlyCapUsd ?? 40,
        spentUsd: month.costUsd,
      },
      budget: {
        monthKey,
        capUsd: config.monthlyCapUsd,
        secondOpinionShareUsd: share,
        limitUsd: Math.max(0, config.monthlyCapUsd - share),
        reservedUsd: fromMicroUsd(budget?.reservedMicroUsd ?? 0),
        spentUsd: fromMicroUsd(budget?.spentMicroUsd ?? 0),
        evalSpentUsd: fromMicroUsd(budget?.evalSpentMicroUsd ?? 0),
        evalCapUsd: config.evalMonthlyUsd,
      },
      waiting: waiting.length,
      job: job
        ? {
            jobId: job._id,
            kind: job.kind,
            status: job.status,
            total: job.total,
            done: job.done,
            failed: job.failed,
            skipped: job.skipped,
            spentUsd: fromMicroUsd(job.spentMicroUsd),
            ceilingUsd: fromMicroUsd(job.ceilingMicroUsd),
            estimateUsd: fromMicroUsd(job.estimateMicroUsd),
            createdAt: job.createdAt,
          }
        : null,
    };
  },
});

export const backfillPreview = query({
  args: { scope: scopeValidator },
  returns: v.union(
    v.null(),
    v.object({
      total: v.number(),
      unread: v.number(),
      outdated: v.number(),
      expired: v.number(),
      estimateUsd: v.number(),
      soonestExpiryAt: v.union(v.number(), v.null()),
      capped: v.boolean(),
    }),
  ),
  handler: async (ctx, args) => {
    const actor = await requireTenantUser(ctx, [...VIEWER_ROLES]);
    const viewer = await insightsViewer(ctx, actor);
    return viewer?.isAdmin
      ? await previewBackfill(ctx, viewer.tenant, args.scope, Date.now())
      : null;
  },
});

export const calls = query({
  args: {
    paginationOpts: paginationOptsValidator,
    status: v.optional(runStatusValidator),
  },
  returns: v.object({
    page: v.array(
      v.object({
        recordingId: v.id("callRecordings"),
        meetingId: v.id("meetings"),
        scheduledAt: v.number(),
        leadName: v.string(),
        closerName: v.string(),
        latestStatus: runStatusValidator,
        reasonCode: v.optional(runReasonValidator),
        analyzedAt: v.optional(v.number()),
        itemCount: v.number(),
        rejectedCount: v.number(),
        noShowTier: v.optional(noShowTierValidator),
        active: v.boolean(),
      }),
    ),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    const actor = await requireTenantUser(ctx, [...VIEWER_ROLES]);
    const viewer = await insightsViewer(ctx, actor);
    if (!viewer?.isAdmin) return { page: [], isDone: true, continueCursor: "" };
    const result = await ctx.db
      .query("callInsightFacts")
      .withIndex("by_tenantId_and_kind_and_scheduledAt", (q) =>
        q.eq("tenantId", actor.tenantId).eq("kind", "call"),
      )
      .order("desc")
      .paginate({
        ...args.paginationOpts,
        numItems: Math.min(50, Math.max(1, args.paginationOpts.numItems)),
        maximumBytesRead: 300_000,
      });
    const page = [];
    for (const header of result.page) {
      if (
        header.kind !== "call" ||
        (args.status && header.latestStatus !== args.status)
      )
        continue;
      const meeting = await ctx.db.get("meetings", header.meetingId);
      if (!meeting || meeting.tenantId !== actor.tenantId) continue;
      const closer = await ctx.db.get("users", meeting.assignedCloserId);
      page.push({
        recordingId: header.recordingId,
        meetingId: header.meetingId,
        scheduledAt: header.scheduledAt,
        leadName: meeting.leadName ?? "Sales call",
        closerName:
          closer?.tenantId === actor.tenantId
            ? (closer.fullName ?? "Closer")
            : "Closer",
        latestStatus: header.latestStatus,
        reasonCode: header.reasonCode,
        analyzedAt: header.analyzedAt,
        itemCount: header.expectedItemCount,
        rejectedCount: header.rejectedCount ?? 0,
        noShowTier: header.noShowTier,
        active: await visibleHeader(ctx, viewer, meeting, header),
      });
    }
    return {
      page,
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

const comparisonValidator = v.union(
  v.literal("same_result"),
  v.literal("different_result"),
  v.literal("same_result_different_values"),
);
export const suggestionQueue = query({
  args: {},
  returns: v.object({
    queue: v.array(
      v.object({
        stateId: v.id("resultSuggestionStates"),
        meetingId: v.id("meetings"),
        scheduledAt: v.number(),
        leadName: v.string(),
        closerName: v.string(),
        kind: suggestionKindValidator,
        tier: suggestionTierValidator,
        noShowTier: v.optional(noShowTierValidator),
        revision: v.number(),
      }),
    ),
    differs: v.array(
      v.object({
        meetingId: v.id("meetings"),
        leadName: v.string(),
        suggestedKind: suggestionKindValidator,
        recordedKind: v.string(),
        comparison: comparisonValidator,
        usedAt: v.optional(v.number()),
      }),
    ),
  }),
  handler: async (ctx) => {
    const actor = await requireTenantUser(ctx, [...VIEWER_ROLES]);
    const viewer = await insightsViewer(ctx, actor);
    if (!viewer?.isAdmin) return { queue: [], differs: [] };
    const groups = await Promise.all(
      SUGGESTION_KINDS.map((kind) =>
        ctx.db
          .query("resultSuggestionStates")
          .withIndex("by_tenantId_and_kind_and_createdAt", (q) =>
            q.eq("tenantId", actor.tenantId).eq("kind", kind),
          )
          .order("desc")
          .take(50),
      ),
    );
    const rows = groups.flat().sort((a, b) => b.createdAt - a.createdAt);
    const queue = [],
      differs = [];
    for (const row of rows) {
      const meeting = await ctx.db.get("meetings", row.meetingId);
      if (!meeting || !(await canSeeMeeting(ctx, viewer, meeting))) continue;
      if (meeting.status === "scheduled" && queue.length < 50) {
        const live = await liveSuggestionForMeeting(ctx, {
          tenant: viewer.tenant,
          meeting,
          now: Date.now(),
        });
        if (live?._id !== row._id) continue;
        const closer = await ctx.db.get("users", meeting.assignedCloserId);
        queue.push({
          stateId: row._id,
          meetingId: meeting._id,
          scheduledAt: meeting.scheduledAt,
          leadName: meeting.leadName ?? "Sales call",
          closerName:
            closer?.tenantId === actor.tenantId
              ? (closer.fullName ?? "Closer")
              : "Closer",
          kind: row.kind,
          tier: row.tier,
          noShowTier: presentedNoShowTier(
            row,
            meeting,
            viewer.tenant,
            Date.now(),
          ),
          revision: row.revision,
        });
      } else if (meeting.status !== "scheduled" && differs.length < 50) {
        const recorded = await recordedResultForMeeting(ctx, meeting);
        if (!recorded) continue;
        const comparison = compareSuggestion(row, recorded);
        if (comparison !== "same_result")
          differs.push({
            meetingId: meeting._id,
            leadName: meeting.leadName ?? "Sales call",
            suggestedKind: row.kind,
            recordedKind: recorded.kind,
            comparison,
            usedAt: row.usedAt,
          });
      }
    }
    return { queue, differs };
  },
});

const splitGroup = v.object({
  total: v.number(),
  agrees: v.number(),
  disagrees: v.number(),
  unsure: v.number(),
});
export const agreementSplit = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      noneShown: splitGroup,
      shownNotUsed: splitGroup,
      used: splitGroup,
      usedEdited: splitGroup,
    }),
  ),
  handler: async (ctx) => {
    const actor = await requireTenantUser(ctx, [...VIEWER_ROLES]);
    const viewer = await insightsViewer(ctx, actor);
    if (!viewer?.isAdmin) return null;
    const group = () => ({ total: 0, agrees: 0, disagrees: 0, unsure: 0 });
    const result = {
      noneShown: group(),
      shownNotUsed: group(),
      used: group(),
      usedEdited: group(),
    };
    const rows = await monthQuery(ctx, actor.tenantId, Date.now())
      .order("desc")
      .take(500);
    for (const opinion of rows) {
      if (opinion.status !== "answered" || opinion.supersededById !== undefined)
        continue;
      const meeting = await ctx.db.get("meetings", opinion.meetingId);
      if (!meeting || meeting.tenantId !== actor.tenantId) continue;
      const row = await suggestionRow(ctx, meeting._id);
      const state = row?.tenantId === actor.tenantId ? row : null;
      const key =
        state?.usedAt !== undefined
          ? state.changedFields?.length
            ? "usedEdited"
            : "used"
          : state?.shownAt !== undefined
            ? "shownNotUsed"
            : "noneShown";
      result[key].total++;
      if (opinion.verdict === "agrees") result[key].agrees++;
      else if (opinion.verdict === "disagrees") result[key].disagrees++;
      else result[key].unsure++;
    }
    return result;
  },
});
