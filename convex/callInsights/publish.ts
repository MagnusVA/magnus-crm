import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { ITEM_KINDS } from "../../lib/callInsights/taxonomy";
import { log } from "../lib/observability/log";
import { noShowTier, shadowTiers } from "./noShow/tier";
import { effectiveSettings } from "./settings";
import { deriveSuggestion } from "./suggest/derive";
import { CERTAIN_AFTER_SLOT_MS, upsertSuggestion } from "./suggest/state";
import { headerFor, latestServingRun } from "./trigger";
import type { CallInsightsSettings, InsightItem } from "./validators";

type CallHeader = Extract<Doc<"callInsightFacts">, { kind: "call" }>;

/** The most item rows one publication can hold (12 + 10 + 10 + 12, the extraction limits). */
const MAX_ITEM_ROWS = 60;

async function deleteItemRows(
  ctx: MutationCtx,
  recordingId: Id<"callRecordings">,
) {
  for (const kind of ITEM_KINDS) {
    const rows = await ctx.db
      .query("callInsightFacts")
      .withIndex("by_recordingId_and_kind", (q) =>
        q.eq("recordingId", recordingId).eq("kind", kind),
      )
      .take(MAX_ITEM_ROWS);
    for (const row of rows) await ctx.db.delete("callInsightFacts", row._id);
  }
}

/** The main blocker a card may show: the one Claude named, if its objection survived. */
export function publishedPrimaryBlocker(
  run: Pick<Doc<"callInsightRuns">, "primaryBlockerExtracted">,
  published: InsightItem[],
): string | undefined {
  const extracted = run.primaryBlockerExtracted;
  if (!extracted) return undefined;
  return published.some(
    (item) => item.kind === "objection" && item.category === extracted,
  )
    ? extracted
    : undefined;
}

/**
 * Rebuilds a recording's text-free rows from a run: the header and one row per
 * item Jev did not reject, all at the next publication revision. Old item rows
 * are removed first, so a reader never mixes two revisions. Also opens a
 * review for every rejected item that has none.
 */
export async function projectRun(
  ctx: MutationCtx,
  args: {
    header: CallHeader;
    run: Doc<"callInsightRuns">;
    meeting: Doc<"meetings">;
    now: number;
    /** Set when a fresh reading publishes; a re-projection keeps the old time. */
    analyzedAt?: number;
  },
): Promise<void> {
  const { header, run, meeting, now } = args;
  const items = run.items ?? [];
  const published = items
    .filter((item) => item.check !== "rejected")
    .slice(0, MAX_ITEM_ROWS);
  const rejected = items.filter((item) => item.check === "rejected");
  const revision = header.publicationRevision + 1;
  const primaryBlocker = publishedPrimaryBlocker(run, published);

  await deleteItemRows(ctx, header.recordingId);
  for (const item of published) {
    const check = item.check === "rejected" ? "unsure" : item.check;
    await ctx.db.insert("callInsightFacts", {
      kind: item.kind,
      tenantId: header.tenantId,
      recordingId: header.recordingId,
      meetingId: meeting._id,
      publicationRevision: revision,
      key: item.key,
      category: item.category,
      isPrimary:
        item.kind === "objection" && primaryBlocker === item.category
          ? true
          : undefined,
      resolution: item.resolution,
      scenario: item.scenario,
      period: item.period,
      currency: item.currency,
      currencyAssumed: item.currencyAssumed,
      minMinor: item.minMinor,
      maxMinor: item.maxMinor,
      monthlyMinMinor: item.monthlyMinMinor,
      monthlyMaxMinor: item.monthlyMaxMinor,
      band: item.band,
      check,
      scheduledAt: meeting.scheduledAt,
    });
  }

  for (const item of rejected) {
    const existing = await ctx.db
      .query("callInsightItemReviews")
      .withIndex("by_runId_and_itemKey", (q) =>
        q.eq("runId", run._id).eq("itemKey", item.key),
      )
      .first();
    if (existing) continue;
    await ctx.db.insert("callInsightItemReviews", {
      tenantId: header.tenantId,
      recordingId: header.recordingId,
      meetingId: meeting._id,
      runId: run._id,
      itemKey: item.key,
      itemKind: item.kind,
      category: item.category,
      state: "open",
      createdAt: now,
    });
  }

  const measures = run.measures;
  await ctx.db.patch("callInsightFacts", header._id, {
    active: true,
    meetingId: meeting._id,
    publicationRevision: revision,
    latestStatus: "answered",
    reasonCode: undefined,
    latestRunId: run._id,
    publishedRunId: run._id,
    publishedGeneration: run.generation,
    expectedItemCount: published.length,
    rejectedCount: rejected.length,
    primaryBlocker,
    speakerUncertain: run.speakerUncertain,
    readKind: run.kind,
    model: run.config.model,
    promptVersion: run.config.promptVersion,
    thresholdsVersion: run.config.thresholdsVersion,
    taxonomyVersion: run.config.taxonomyVersion,
    itemCheck: run.config.itemCheck,
    analyzedAt: args.analyzedAt ?? header.analyzedAt ?? now,
    scheduledAt: meeting.scheduledAt,
    ...(measures
      ? {
          startOffsetSeconds: measures.startOffsetSeconds,
          endOffsetSeconds: measures.endOffsetSeconds,
          prospectFirstLineOffsetSeconds:
            measures.prospectFirstLineOffsetSeconds,
          firstOtherLineOffsetSeconds: measures.firstOtherLineOffsetSeconds,
          prospectIdentity:
            header.prospectIdentity === "closer_confirmed"
              ? header.prospectIdentity
              : measures.prospectFirstLineOffsetSeconds !== undefined
                ? ("email_matched" as const)
                : measures.firstOtherLineOffsetSeconds !== undefined
                  ? ("fallback" as const)
                  : ("unknown" as const),
        }
      : {}),
    updatedAt: now,
  });
}

/**
 * Stores the no-show tier and the suggested result a run's reading gives its
 * meeting. The time rules (the slot is over; an hour after it for a one-step
 * confirm) are applied when a card is read, so the tier here assumes them met.
 */
export async function storeSuggestion(
  ctx: MutationCtx,
  args: {
    header: CallHeader;
    run: Doc<"callInsightRuns">;
    meeting: Doc<"meetings">;
    settings: CallInsightsSettings;
    now: number;
  },
): Promise<void> {
  const { run, meeting, now } = args;
  // A run with no measurements was read for another meeting's slot (see
  // `reproject`): it says nothing about attendance at this one.
  const tierInput = run.measures && {
    eligible: true,
    now: Math.max(now, run.measures.slotEndedAt + CERTAIN_AFTER_SLOT_MS),
    measures: run.measures,
    attendance: run.attendance,
    jev: run.earlyReading?.attendance,
  };
  const tier = tierInput
    ? noShowTier({ ...tierInput, waitMinutes: args.settings.noShowWaitMinutes })
    : { tier: "none" as const, notes: ["ineligible"] };
  await ctx.db.patch("callInsightFacts", args.header._id, {
    noShowTier: tier.tier,
    shadowTiers: tierInput ? shadowTiers(tierInput) : undefined,
  });
  // A suggestion left on a meeting this recording no longer belongs to goes,
  // unless somebody already saved from it.
  const stale = await ctx.db
    .query("resultSuggestionStates")
    .withIndex("by_recordingId", (q) => q.eq("recordingId", run.recordingId))
    .take(5);
  for (const row of stale)
    if (row.meetingId !== meeting._id && row.usedAt === undefined)
      await ctx.db.delete("resultSuggestionStates", row._id);
  await upsertSuggestion(ctx, {
    tenantId: run.tenantId,
    meetingId: meeting._id,
    recordingId: run.recordingId,
    runId: run._id,
    derived: deriveSuggestion({
      noShow: tier,
      result: run.result,
      attendance: run.attendance,
      reading: run.earlyReading,
    }),
    quotesPurgedAt: run.quotesPurgedAt,
    waitedSeconds: run.measures?.endOffsetSeconds,
    now,
  });
}

/**
 * Shows a recording's saved reading on the meeting it is matched to now. Used
 * when a recording is matched to a different meeting after it was read, and
 * when an admin restores an item. No model is called.
 */
export const reproject = internalMutation({
  args: { recordingId: v.id("callRecordings") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const recording = await ctx.db.get("callRecordings", args.recordingId);
    if (
      !recording ||
      recording.matchStatus !== "matched" ||
      !recording.meetingId
    )
      return null;
    const header = await headerFor(ctx, recording._id);
    if (!header) return null;
    const meeting = await ctx.db.get("meetings", recording.meetingId);
    if (!meeting || meeting.tenantId !== recording.tenantId) return null;
    const run =
      (header.publishedRunId &&
        (await ctx.db.get("callInsightRuns", header.publishedRunId))) ||
      (await latestServingRun(ctx, recording._id));
    if (!run || run.status !== "answered" || run.purpose !== "serve")
      return null;
    const now = Date.now();
    let shown = run;
    if (run.meetingId !== meeting._id) {
      // The run's meeting follows the recording so readers and saves agree.
      // What the prospect said holds for any meeting. The timing measurements
      // were taken against the old meeting's slot, so they go, and with them
      // any no-show reading: this run says nothing about attendance here.
      await ctx.db.patch("callInsightRuns", run._id, {
        meetingId: meeting._id,
        measures: undefined,
      });
      shown = { ...run, meetingId: meeting._id, measures: undefined };
      await ctx.db.patch("callInsightFacts", header._id, {
        startOffsetSeconds: undefined,
        endOffsetSeconds: undefined,
        prospectFirstLineOffsetSeconds: undefined,
        firstOtherLineOffsetSeconds: undefined,
        prospectIdentity: undefined,
        confirmedArrivalOffsetSeconds: undefined,
      });
    }
    await projectRun(ctx, { header, run: shown, meeting, now });
    const settings = effectiveSettings(
      await ctx.db.get("tenants", run.tenantId),
    );
    if (settings)
      await storeSuggestion(ctx, {
        header,
        run: shown,
        meeting,
        settings,
        now,
      });
    log.info("call_insights.reprojected", {
      tenantId: recording.tenantId,
      recordingId: recording._id,
      runId: run._id,
    });
    return null;
  },
});
