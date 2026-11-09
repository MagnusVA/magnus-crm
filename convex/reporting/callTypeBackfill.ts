import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalAction, internalQuery, type MutationCtx, type QueryCtx } from "../_generated/server";
import { callTypeFor, type CallType } from "../lib/callType";
import { patchMeetingLifecycle } from "../lib/meetingLifecycle";
import { log } from "../lib/observability/log";

// The call-type backfill (docs/reviews/reports-overhaul.html §15, decisions
// D5 and D6). The booking writers file a call as a first call until the
// person has held one on the deal; meetings written before that rule follow
// "any earlier meeting", so a moved first call and a rebook after a no-show
// were filed as follow-ups. This module gives the backfill in
// `convex/migrations.ts` its rule, a dry run and a way back.
//
// Every change goes through `patchMeetingLifecycle`, so the meetingsByStatus
// aggregate, the Operations projection and the deal's meeting refs follow.
// Each change is written to `callTypeBackfillChanges` first: the old types
// can't be recomputed (meetings from before v0.6 were typed by call time,
// later ones by insert order), so the ledger is what makes the reverse exact.

/** More meetings than any deal holds; a deal past it is reported, not guessed. */
const DEAL_MEETING_LIMIT = 1000;

/** A missing type is read as a first call everywhere (meetingsByStatus, SQL). */
export function storedCallType(meeting: Pick<Doc<"meetings">, "callClassification">): CallType {
  return meeting.callClassification ?? "new";
}

async function dealMeetings(ctx: QueryCtx | MutationCtx, opportunityId: Id<"opportunities">) {
  const meetings = await ctx.db
    .query("meetings")
    .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opportunityId))
    .take(DEAL_MEETING_LIMIT + 1);
  if (meetings.length > DEAL_MEETING_LIMIT) {
    throw new Error(`Opportunity ${opportunityId} has more than ${DEAL_MEETING_LIMIT} meetings`);
  }
  return meetings;
}

/** The type the rule gives `meeting`, from its deal's meetings as they are now. */
export async function ruleCallType(ctx: QueryCtx | MutationCtx, meeting: Doc<"meetings">): Promise<CallType> {
  return callTypeFor(meeting, await dealMeetings(ctx, meeting.opportunityId));
}

/**
 * One meeting's step of the backfill. Writes nothing when the stored type
 * already matches, so a second run changes nothing. A meeting whose deal is
 * gone can't be patched through the lifecycle helper; it's logged and left.
 */
export async function backfillMeetingCallType(ctx: MutationCtx, meeting: Doc<"meetings">) {
  const to = await ruleCallType(ctx, meeting);
  if (storedCallType(meeting) === to) return;
  const deal = await ctx.db.get("opportunities", meeting.opportunityId);
  if (!deal || deal.tenantId !== meeting.tenantId) {
    log.warn("reporting.call_type_backfill.orphan_meeting", { meetingId: meeting._id });
    return;
  }
  await ctx.db.insert("callTypeBackfillChanges", {
    tenantId: meeting.tenantId,
    meetingId: meeting._id,
    from: meeting.callClassification ?? "unset",
    to,
    changedAt: Date.now(),
  });
  await patchMeetingLifecycle(ctx, meeting._id, { callClassification: to });
}

/** The assert's step: throws on the first meeting whose stored type breaks the rule. */
export async function assertMeetingCallType(ctx: MutationCtx, meeting: Doc<"meetings">) {
  const deal = await ctx.db.get("opportunities", meeting.opportunityId);
  if (!deal || deal.tenantId !== meeting.tenantId) return;
  const expected = await ruleCallType(ctx, meeting);
  if (storedCallType(meeting) !== expected) {
    throw new Error(
      `Meeting ${meeting._id} is filed as ${storedCallType(meeting)} but the rule gives ${expected}`,
    );
  }
}

/**
 * The reverse's step: puts back the type a ledger row recorded. A meeting
 * whose type changed again since the backfill (a later booking or result
 * re-checked it) is left alone and logged, since its current type came from
 * the writer, not from the backfill.
 */
export async function reverseCallTypeChange(ctx: MutationCtx, change: Doc<"callTypeBackfillChanges">) {
  if (change.revertedAt !== undefined) return;
  const meeting = await ctx.db.get("meetings", change.meetingId);
  const now = Date.now();
  if (!meeting) {
    await ctx.db.patch("callTypeBackfillChanges", change._id, { revertedAt: now, revertSkipped: "meeting_deleted" });
    return;
  }
  if (storedCallType(meeting) !== change.to) {
    log.warn("reporting.call_type_backfill.reverse_skipped", { meetingId: meeting._id });
    await ctx.db.patch("callTypeBackfillChanges", change._id, { revertedAt: now, revertSkipped: "changed_since" });
    return;
  }
  await patchMeetingLifecycle(ctx, meeting._id, {
    callClassification: change.from === "unset" ? undefined : change.from,
  });
  await ctx.db.patch("callTypeBackfillChanges", change._id, { revertedAt: now });
}

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

const changeCountsValidator = v.object({
  toFirst: v.number(),
  toFollowUp: v.number(),
});

const previewPageValidator = v.object({
  continueCursor: v.string(),
  isDone: v.boolean(),
  read: v.number(),
  /** UTC month of the call ("2026-10") → changes. */
  byMonth: v.record(v.string(), changeCountsValidator),
  /** Closer on the meeting → changes. */
  byCloser: v.record(v.string(), v.number()),
  samples: v.array(v.id("meetings")),
});

/** One page of the dry run: what the backfill would change, read only. */
export const previewCallTypeBackfillPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()), numItems: v.number() },
  returns: previewPageValidator,
  handler: async (ctx, { cursor, numItems }) => {
    const page = await ctx.db.query("meetings").paginate({ cursor, numItems });
    const byMonth: Record<string, { toFirst: number; toFollowUp: number }> = {};
    const byCloser: Record<string, number> = {};
    const samples: Id<"meetings">[] = [];
    for (const meeting of page.page) {
      const to = await ruleCallType(ctx, meeting);
      if (storedCallType(meeting) === to) continue;
      const month = new Date(meeting.scheduledAt).toISOString().slice(0, 7);
      const counts = (byMonth[month] ??= { toFirst: 0, toFollowUp: 0 });
      if (to === "new") counts.toFirst += 1;
      else counts.toFollowUp += 1;
      byCloser[meeting.assignedCloserId] = (byCloser[meeting.assignedCloserId] ?? 0) + 1;
      if (samples.length < 5) samples.push(meeting._id);
    }
    return {
      continueCursor: page.continueCursor,
      isDone: page.isDone,
      read: page.page.length,
      byMonth,
      byCloser,
      samples,
    };
  },
});

/**
 * The backfill's dry run over every meeting, for launch day: run it on
 * production before the backfill and compare the total with the read-only
 * ClickHouse check (`npx convex run --prod reporting/callTypeBackfill:previewCallTypeBackfill`).
 */
export const previewCallTypeBackfill = internalAction({
  args: { pageSize: v.optional(v.number()) },
  returns: v.object({
    read: v.number(),
    changes: v.number(),
    toFirst: v.number(),
    toFollowUp: v.number(),
    byMonth: v.record(v.string(), changeCountsValidator),
    byCloser: v.record(v.string(), v.number()),
    samples: v.array(v.id("meetings")),
  }),
  handler: async (ctx, { pageSize }) => {
    const byMonth: Record<string, { toFirst: number; toFollowUp: number }> = {};
    const byCloser: Record<string, number> = {};
    const samples: Id<"meetings">[] = [];
    let cursor: string | null = null;
    let read = 0;
    for (;;) {
      const page: {
        continueCursor: string;
        isDone: boolean;
        read: number;
        byMonth: Record<string, { toFirst: number; toFollowUp: number }>;
        byCloser: Record<string, number>;
        samples: Id<"meetings">[];
      } = await ctx.runQuery(internal.reporting.callTypeBackfill.previewCallTypeBackfillPage, {
        cursor,
        numItems: pageSize ?? 200,
      });
      read += page.read;
      for (const [month, counts] of Object.entries(page.byMonth)) {
        const total = (byMonth[month] ??= { toFirst: 0, toFollowUp: 0 });
        total.toFirst += counts.toFirst;
        total.toFollowUp += counts.toFollowUp;
      }
      for (const [closer, count] of Object.entries(page.byCloser)) {
        byCloser[closer] = (byCloser[closer] ?? 0) + count;
      }
      for (const id of page.samples) if (samples.length < 20) samples.push(id);
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    const toFirst = Object.values(byMonth).reduce((sum, counts) => sum + counts.toFirst, 0);
    const toFollowUp = Object.values(byMonth).reduce((sum, counts) => sum + counts.toFollowUp, 0);
    return { read, changes: toFirst + toFollowUp, toFirst, toFollowUp, byMonth, byCloser, samples };
  },
});
