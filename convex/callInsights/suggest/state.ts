import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { canRecordMeetingOutcome } from "../../opportunities/dealGuards";
import { isOtherProspectsCall } from "../../secondOpinion/trigger";
import { log } from "../../lib/observability/log";
import type {
  NoShowTier,
  SuggestionKind,
  SuggestionTier,
} from "../../../lib/callInsights/taxonomy";
import { transcriptGone } from "../retention";
import { effectiveSettings } from "../settings";
import type {
  FoundQuote,
  FromSuggestion,
  SuggestionValues,
} from "../validators";

/**
 * The suggested result of a meeting nobody has recorded yet
 * (`resultSuggestionStates`, one row per meeting). The row is written when a
 * call is read. Nothing ever closes it: a reader shows it only while it is
 * live, which is decided from the meeting, the deal and the recording as they
 * are now.
 */

export type DerivedSuggestion = {
  kind: SuggestionKind;
  tier: SuggestionTier;
  noShowTier?: NoShowTier;
  values: SuggestionValues;
  quotes: Array<{ label: string } & FoundQuote>;
  claudeReading?: string;
  jevReading?: string;
  notes: string[];
};

const NO_SHOW_KINDS = new Set<SuggestionKind>(["no_show", "empty_recording"]);

/** A Certain no-show can be confirmed in one step only an hour after the slot ended. */
export const CERTAIN_AFTER_SLOT_MS = 60 * 60_000;

export function slotEndAt(
  meeting: Pick<Doc<"meetings">, "scheduledAt" | "durationMinutes">,
): number {
  return meeting.scheduledAt + Math.max(0, meeting.durationMinutes) * 60_000;
}

function sameValues(a: SuggestionValues, b: SuggestionValues): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<
    keyof SuggestionValues
  >;
  for (const key of keys) if (a[key] !== b[key]) return false;
  return true;
}

export async function suggestionRow(
  ctx: Pick<QueryCtx, "db">,
  meetingId: Id<"meetings">,
): Promise<Doc<"resultSuggestionStates"> | null> {
  return await ctx.db
    .query("resultSuggestionStates")
    .withIndex("by_meetingId", (q) => q.eq("meetingId", meetingId))
    .first();
}

/**
 * Stores what a reading suggests for its meeting. A changed kind, tier or
 * value raises the revision and clears who saw and used the old one. A
 * reading that suggests nothing removes an unused row.
 */
export async function upsertSuggestion(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    meetingId: Id<"meetings">;
    recordingId: Id<"callRecordings">;
    runId: Id<"callInsightRuns">;
    derived: DerivedSuggestion | null;
    /** Set when the run's quotes were already deleted with the transcript. */
    quotesPurgedAt?: number;
    /** How long the closer waited, for a no-show reading. */
    waitedSeconds?: number;
    now: number;
  },
): Promise<void> {
  const existing = await suggestionRow(ctx, args.meetingId);
  const derived = args.derived;
  if (!derived) {
    if (existing && existing.usedAt === undefined)
      await ctx.db.delete("resultSuggestionStates", existing._id);
    return;
  }
  const content = {
    recordingId: args.recordingId,
    runId: args.runId,
    kind: derived.kind,
    tier: derived.tier,
    noShowTier: derived.noShowTier,
    waitedSeconds: args.waitedSeconds,
    values: derived.values,
    quotes: derived.quotes,
    claudeReading: derived.claudeReading,
    jevReading: derived.jevReading,
    notes: derived.notes,
    quotesPurgedAt: args.quotesPurgedAt,
    updatedAt: args.now,
  };
  if (!existing) {
    await ctx.db.insert("resultSuggestionStates", {
      tenantId: args.tenantId,
      meetingId: args.meetingId,
      revision: 1,
      createdAt: args.now,
      ...content,
    });
    return;
  }
  // A suggestion somebody already saved from is history: leave it as it was.
  if (existing.usedAt !== undefined) return;
  const changed =
    existing.kind !== derived.kind ||
    existing.tier !== derived.tier ||
    existing.noShowTier !== derived.noShowTier ||
    existing.recordingId !== args.recordingId ||
    !sameValues(existing.values, derived.values);
  await ctx.db.patch("resultSuggestionStates", existing._id, {
    ...content,
    ...(changed
      ? {
          revision: existing.revision + 1,
          shownAt: undefined,
          shownToUserId: undefined,
          comparison: undefined,
          savedKind: undefined,
          comparedAt: undefined,
        }
      : {}),
  });
}

export type Liveness =
  | { live: true }
  | {
      live: false;
      reason:
        | "off"
        | "has_result"
        | "deal_not_waiting"
        | "recording_moved"
        | "transcript_expired"
        | "other_prospect"
        | "slot_not_over"
        | "used";
    };

/**
 * Whether a stored suggestion may be shown or saved from right now. Pass
 * `ignoreVisibility` to judge the row alone, as the Quality pages do during
 * the hidden trial.
 */
export async function suggestionLiveness(
  ctx: QueryCtx | MutationCtx,
  args: {
    tenant: Doc<"tenants">;
    meeting: Doc<"meetings">;
    row: Doc<"resultSuggestionStates">;
    now: number;
    ignoreVisibility?: boolean;
  },
): Promise<Liveness> {
  const settings = effectiveSettings(args.tenant);
  if (!settings || (!args.ignoreVisibility && settings.suggestions !== "on"))
    return { live: false, reason: "off" };
  if (args.row.usedAt !== undefined) return { live: false, reason: "used" };
  if (args.meeting.status !== "scheduled")
    return { live: false, reason: "has_result" };
  const deal = await ctx.db.get("opportunities", args.meeting.opportunityId);
  if (
    !deal ||
    deal.tenantId !== args.meeting.tenantId ||
    !canRecordMeetingOutcome(deal)
  )
    return { live: false, reason: "deal_not_waiting" };
  const recording = await ctx.db.get("callRecordings", args.row.recordingId);
  if (
    !recording ||
    recording.tenantId !== args.meeting.tenantId ||
    recording.matchStatus !== "matched" ||
    recording.meetingId !== args.meeting._id
  )
    return { live: false, reason: "recording_moved" };
  // Expiry counts from the moment it passes, not from when the cleanup runs.
  if (
    transcriptGone(recording, args.now) ||
    args.row.quotesPurgedAt !== undefined
  )
    return { live: false, reason: "transcript_expired" };
  if (await isOtherProspectsCall(ctx, args.meeting, recording))
    return { live: false, reason: "other_prospect" };
  if (NO_SHOW_KINDS.has(args.row.kind) && args.now < slotEndAt(args.meeting))
    return { live: false, reason: "slot_not_over" };
  return { live: true };
}

/** The meeting's suggestion if one is live now, else null. */
export async function liveSuggestionForMeeting(
  ctx: QueryCtx | MutationCtx,
  args: { tenant: Doc<"tenants">; meeting: Doc<"meetings">; now: number },
): Promise<Doc<"resultSuggestionStates"> | null> {
  if (effectiveSettings(args.tenant)?.suggestions !== "on") return null;
  const row = await suggestionRow(ctx, args.meeting._id);
  if (!row || row.tenantId !== args.tenant._id) return null;
  const liveness = await suggestionLiveness(ctx, { ...args, row });
  return liveness.live ? row : null;
}

/**
 * The no-show tier a reader should present. A Certain reads as Review unless
 * the tenant switched Certain on, the closer waited at least as long as the
 * tenant requires today (the wait may have been raised or cleared since the
 * call was read), and an hour has passed since the slot ended.
 */
export function presentedNoShowTier(
  row: Pick<Doc<"resultSuggestionStates">, "noShowTier" | "waitedSeconds">,
  meeting: Pick<Doc<"meetings">, "scheduledAt" | "durationMinutes">,
  tenant: Pick<Doc<"tenants">, "callInsights">,
  now: number,
): NoShowTier | undefined {
  if (row.noShowTier !== "certain") return row.noShowTier;
  const settings = effectiveSettings(tenant);
  const wait = settings?.noShowWaitMinutes;
  const allowed =
    settings?.noShowCertain === true &&
    wait !== undefined &&
    row.waitedSeconds !== undefined &&
    row.waitedSeconds >= wait * 60 &&
    now >= slotEndAt(meeting) + CERTAIN_AFTER_SLOT_MS;
  return allowed ? "certain" : "review";
}

/**
 * The live suggestion a save names, or null when the reference is for another
 * tenant or meeting, an older revision, or a suggestion that is no longer
 * live. A null never blocks a save: the save goes ahead as if no suggestion
 * had been named.
 */
export async function resolveSuggestionRef(
  ctx: QueryCtx | MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    meetingId: Id<"meetings">;
    ref: FromSuggestion;
  },
): Promise<Doc<"resultSuggestionStates"> | null> {
  const ignore = (reason: string) => {
    log.info("call_insights.suggestion_ref_ignored", {
      tenantId: args.tenantId,
      meetingId: args.meetingId,
      reason,
    });
    return null;
  };
  const row = await ctx.db.get("resultSuggestionStates", args.ref.stateId);
  if (!row || row.tenantId !== args.tenantId) return ignore("not_found");
  if (row.meetingId !== args.meetingId) return ignore("other_meeting");
  if (row.revision !== args.ref.revision) return ignore("stale_revision");
  const [tenant, meeting] = await Promise.all([
    ctx.db.get("tenants", args.tenantId),
    ctx.db.get("meetings", args.meetingId),
  ]);
  if (!tenant || !meeting || meeting.tenantId !== args.tenantId)
    return ignore("not_found");
  const liveness = await suggestionLiveness(ctx, {
    tenant,
    meeting,
    row,
    now: Date.now(),
  });
  if (!liveness.live) return ignore(liveness.reason);
  return row;
}

/**
 * True when a payment saved without a proof file may skip the closer's proof
 * rule: it names a live payment suggestion that every check agreed on and that
 * was shown on the meeting. A suggestion Jev disputes or couldn't confirm
 * offers no "Log payment" button and waives nothing.
 */
export function suggestionWaivesProof(
  row: Doc<"resultSuggestionStates"> | null,
): boolean {
  return (
    row !== null &&
    (row.kind === "paid" || row.kind === "promised") &&
    row.tier === "ready" &&
    row.shownAt !== undefined
  );
}

/** Records that a result was saved from the suggestion. Call after the save's own writes. */
export async function markSuggestionUsed(
  ctx: MutationCtx,
  args: {
    state: Doc<"resultSuggestionStates">;
    userId: Id<"users">;
    changedFields?: string[];
    paymentId?: Id<"paymentRecords">;
    proofWaived?: boolean;
  },
): Promise<void> {
  const now = Date.now();
  await ctx.db.patch("resultSuggestionStates", args.state._id, {
    usedAt: now,
    usedByUserId: args.userId,
    // Field names only. A client could send anything here, so keep it short.
    changedFields: (args.changedFields ?? [])
      .slice(0, 12)
      .map((name) => name.slice(0, 40)),
    paymentId: args.paymentId,
    proofWaived: args.proofWaived,
    updatedAt: now,
  });
  log.info("call_insights.suggestion_used", {
    tenantId: args.state.tenantId,
    meetingId: args.state.meetingId,
    kind: args.state.kind,
    tier: args.state.tier,
    edited: (args.changedFields ?? []).length > 0,
    proofWaived: args.proofWaived === true,
  });
}
