import { v } from "convex/values";
import type { Doc, Id } from "../../../_generated/dataModel";
import { internalQuery, type QueryCtx } from "../../../_generated/server";
import { readLiveQueryRows } from "../../../lib/liveQueryBounds";
import { isMissedMeetingLoss } from "../../../opportunities/dealState";
import { buildTeamReview } from "../../../team/reviewCore";
import { mcpCallerValidator, requireMcpAdmin, loadInTenant } from "../../guard";
import { rejectRequest } from "../../../lib/observability/errors";
import { formatLocal } from "../../time";
import { appLink } from "../prepare";
import {
  type Admin,
  text,
  textValidator,
  ageValidator,
  limitOf,
  tenantId,
  notFound,
  canSeeOpinions,
  paymentActions,
  dealActions,
  meetingActions,
  paths,
  partialReason,
} from "./common";
import { pageNotRecorded, readNotRecorded } from "./notRecorded";

export const queueValidator = v.union(
  v.literal("payments_to_review"),
  v.literal("missed_meetings"),
  v.literal("second_opinions"),
  v.literal("booking_reviews"),
  v.literal("not_recorded"),
  v.literal("team_review"),
  v.literal("unmatched_recordings"),
  v.literal("failed_work"),
);
export type Queue =
  | "payments_to_review"
  | "missed_meetings"
  | "second_opinions"
  | "booking_reviews"
  | "not_recorded"
  | "team_review"
  | "unmatched_recordings"
  | "failed_work";
export const queueArgs = {
  queue: queueValidator,
  itemId: v.optional(v.string()),
  closerId: v.optional(v.id("users")),
  cursor: v.optional(v.string()),
  limit: v.optional(v.number()),
};
export const queueItemValidator = v.object({
  queue: queueValidator,
  id: v.string(),
  title: textValidator,
  age: v.union(ageValidator, v.null()),
  reasonCodes: v.array(v.string()),
  allowedActions: v.array(v.string()),
  openInMagnus: v.string(),
  flags: v.optional(
    v.object({
      proof_reused: v.boolean(),
      no_proof: v.boolean(),
      recorded_by_you: v.boolean(),
      via: v.union(v.string(), v.null()),
    }),
  ),
  meetingId: v.optional(v.id("meetings")),
  opportunityId: v.optional(v.id("opportunities")),
  closerId: v.optional(v.id("users")),
  amountMinor: v.optional(v.number()),
  currency: v.optional(v.string()),
  generation: v.optional(v.number()),
  workKind: v.optional(v.string()),
  sourceId: v.optional(v.string()),
  state: v.optional(v.string()),
});
type QueueItem = {
  queue: Queue;
  id: string;
  title: ReturnType<typeof text>;
  age: { seconds: number; since: string } | null;
  reasonCodes: string[];
  allowedActions: string[];
  openInMagnus: string;
  flags?: {
    proof_reused: boolean;
    no_proof: boolean;
    recorded_by_you: boolean;
    via: string | null;
  };
  meetingId?: Id<"meetings">;
  opportunityId?: Id<"opportunities">;
  closerId?: Id<"users">;
  amountMinor?: number;
  currency?: string;
  generation?: number;
  workKind?: string;
  sourceId?: string;
  state?: string;
};
function item(
  me: Admin,
  queue: Queue,
  id: string,
  title: string,
  since: number | null,
  reasonCodes: string[],
  allowedActions: string[],
  link: string,
  by: Parameters<typeof text>[1] = "person",
): QueueItem {
  return {
    queue,
    id,
    title: text(title, by, 160),
    age:
      since === null
        ? null
        : {
            seconds: Math.max(0, Math.floor((Date.now() - since) / 1000)),
            since: formatLocal(since, me.timeZone),
          },
    reasonCodes,
    allowedActions,
    openInMagnus: link,
  };
}
async function meetingItem(ctx: QueryCtx, me: Admin, row: Doc<"meetings">) {
  const deal = await loadInTenant(ctx, me, "opportunities", row.opportunityId);
  return {
    ...item(
      me,
      "not_recorded",
      row._id,
      row.leadName ?? "Unnamed person",
      row.scheduledAt + row.durationMinutes * 60000,
      ["attendance_not_recorded"],
      meetingActions(me, row, deal),
      paths.meeting(row._id),
    ),
    meetingId: row._id,
    opportunityId: row.opportunityId,
    closerId: row.assignedCloserId,
    state: "not_recorded",
  };
}
async function paymentItem(
  ctx: QueryCtx,
  me: Admin,
  row: Doc<"paymentRecords">,
) {
  const deal = row.opportunityId
    ? await ctx.db.get("opportunities", row.opportunityId)
    : null;
  const lead =
    deal?.tenantId === me.tenantId
      ? await ctx.db.get("leads", deal.leadId)
      : null;
  const flags = {
    proof_reused: row.proofReused === true,
    no_proof: !row.proofFileId,
    recorded_by_you: row.recordedByUserId === me.userId,
    via: row.agentClient ?? null,
  };
  return {
    ...item(
      me,
      "payments_to_review",
      row._id,
      lead?.tenantId === me.tenantId
        ? (lead.fullName ?? "Unnamed person")
        : "Payment",
      row.recordedAt,
      Object.entries(flags)
        .filter(([k, val]) => k !== "via" && val === true)
        .map(([k]) => k),
      paymentActions(me, row),
      paths.payment(row._id),
    ),
    flags,
    amountMinor: row.amountMinor,
    currency: row.currency,
    ...(row.opportunityId ? { opportunityId: row.opportunityId } : {}),
    ...(row.attributedCloserId ? { closerId: row.attributedCloserId } : {}),
    state: row.status,
  };
}
async function missedItem(ctx: QueryCtx, me: Admin, row: Doc<"opportunities">) {
  const lead = await ctx.db.get("leads", row.leadId);
  return {
    ...item(
      me,
      "missed_meetings",
      row._id,
      lead?.tenantId === me.tenantId
        ? (lead.fullName ?? "Unnamed person")
        : "Unnamed person",
      row.lostAt ?? row.updatedAt,
      [isMissedMeetingLoss(row) ?? "missed_meeting"],
      dealActions(me, row),
      paths.deal(row._id),
    ),
    opportunityId: row._id,
    ...(row.latestMeetingId ? { meetingId: row.latestMeetingId } : {}),
    ...(row.assignedCloserId ? { closerId: row.assignedCloserId } : {}),
    state: row.outcome,
  };
}
async function opinionItem(
  ctx: QueryCtx,
  me: Admin,
  row: Doc<"secondOpinions">,
) {
  const meeting = await loadInTenant(ctx, me, "meetings", row.meetingId);
  const actions = ["magnus_queue", "magnus_get_recording"];
  if (
    me.writeFamilies.includes("opinions") &&
    row.status === "answered" &&
    row.reviewState === "open" &&
    row.verdict === "disagrees"
  )
    actions.push("magnus_decide_second_opinion");
  return {
    ...item(
      me,
      "second_opinions",
      row._id,
      meeting.leadName ?? "Unnamed person",
      row.createdAt,
      [row.verdict ?? "unknown"],
      actions,
      appLink(`/workspace/pipeline/second-opinions/${row._id}`),
    ),
    meetingId: meeting._id,
    opportunityId: meeting.opportunityId,
    closerId: row.closerUserId,
    state: row.reviewState ?? row.status,
  };
}
function bookingItem(me: Admin, row: Doc<"bookingReviews">) {
  return {
    ...item(
      me,
      "booking_reviews",
      row._id,
      row.booking.name ?? "Booking review",
      row.createdAt,
      [
        row.kind,
        ...(row.reason && /^[a-z_]{1,60}$/.test(row.reason)
          ? [row.reason]
          : []),
      ],
      ["magnus_queue"],
      appLink(`/workspace/operations/booking-reviews/${row._id}`),
    ),
    state: row.status,
  };
}
function recordingItem(me: Admin, row: Doc<"callRecordings">) {
  const actions = ["magnus_get_recording"];
  if (me.writeFamilies.includes("repairs") && row.matchStatus === "unmatched")
    actions.push("magnus_repair");
  return {
    ...item(
      me,
      "unmatched_recordings",
      row._id,
      row.title,
      row.createdAt,
      ["unmatched_recording"],
      actions,
      appLink("/workspace/settings/fathom"),
      "integration",
    ),
    ...(row.recordedByUserId ? { closerId: row.recordedByUserId } : {}),
    state: row.matchStatus,
  };
}
function failedSources(ctx: QueryCtx, me: Admin) {
  return [
    ctx.db
      .query("meetingProjections")
      .withIndex("by_tenantId_and_status_and_requestedAt", (q) =>
        q.eq("tenantId", me.tenantId).eq("status", "failed"),
      ),
    ctx.db
      .query("opportunityProjectionJobs")
      .withIndex("by_tenantId_and_status_and_requestedAt", (q) =>
        q.eq("tenantId", me.tenantId).eq("status", "failed"),
      ),
    ctx.db
      .query("webhookDeliveries")
      .withIndex("by_tenantId_and_status_and_receivedAt", (q) =>
        q.eq("tenantId", me.tenantId).eq("status", "failed"),
      ),
    ctx.db
      .query("webhookDeliveries")
      .withIndex("by_tenantId_and_status_and_receivedAt", (q) =>
        q.eq("tenantId", me.tenantId).eq("status", "blocked"),
      ),
  ] as const;
}
type FailedRow =
  | Doc<"meetingProjections">
  | Doc<"opportunityProjectionJobs">
  | Doc<"webhookDeliveries">;
function failedItem(me: Admin, row: FailedRow) {
  const isProjection = "requestedAt" in row;
  return {
    ...item(
      me,
      "failed_work",
      row._id,
      isProjection ? "Failed projection" : "Booking delivery needs attention",
      isProjection ? row.requestedAt : row.receivedAt,
      [
        isProjection
          ? "projection_failed"
          : row.status === "blocked"
            ? "delivery_blocked"
            : "delivery_failed",
      ],
      [
        "magnus_queue",
        ...(me.writeFamilies.includes("repairs") ? ["magnus_repair"] : []),
      ],
      appLink("/workspace/operations"),
      "integration",
    ),
    generation: row.generation,
    workKind:
      "requestedAt" in row
        ? "meetingId" in row
          ? "meeting_projection"
          : "opportunity_projection"
        : "booking_delivery",
    sourceId:
      "requestedAt" in row
        ? "meetingId" in row
          ? row.meetingId
          : row.opportunityId
        : row.rawEventId,
    state: row.status,
  };
}
export async function buildQueue(
  ctx: QueryCtx,
  me: Admin,
  args: {
    queue: Queue;
    itemId?: string;
    closerId?: Id<"users">;
    cursor?: string;
    limit?: number;
  },
) {
  // Six full items fit the gateway's 12 KiB answer, which carries each twice.
  const limit = Math.min(limitOf(args.limit), 6),
    now = Date.now();
  if (args.closerId) await loadInTenant(ctx, me, "users", args.closerId);
  let items: QueueItem[] = [],
    isPartial = false,
    cursor: string | null = null;
  const options = {
    cursor: args.cursor ?? null,
    numItems: limit,
    maximumRowsRead: limit,
    maximumBytesRead: 512 * 1024,
  };
  const closer = (id: Id<"users"> | undefined) =>
    !args.closerId || id === args.closerId;
  if (args.queue === "payments_to_review") {
    const page = args.itemId
      ? {
          page: [
            await loadInTenant(
              ctx,
              me,
              "paymentRecords",
              await tenantId(ctx, me, "paymentRecords", args.itemId),
            ),
          ],
          isDone: true,
          continueCursor: "",
        }
      : await ctx.db
          .query("paymentRecords")
          .withIndex("by_tenantId_and_status_and_recordedAt", (q) =>
            q.eq("tenantId", me.tenantId).eq("status", "recorded"),
          )
          .paginate(options);
    const rows = page.page.filter(
      (r) => r.status === "recorded" && closer(r.attributedCloserId),
    );
    items = await Promise.all(rows.map((r) => paymentItem(ctx, me, r)));
    isPartial = !page.isDone;
    cursor = page.isDone ? null : page.continueCursor;
  } else if (args.queue === "not_recorded") {
    if (args.itemId) {
      const id = await tenantId(ctx, me, "meetings", args.itemId),
        row = await loadInTenant(ctx, me, "meetings", id);
      if (
        row.status !== "scheduled" ||
        row.scheduledAt + row.durationMinutes * 60000 > now ||
        !closer(row.assignedCloserId)
      )
        notFound();
      items = [await meetingItem(ctx, me, row)];
    } else {
      const page = await pageNotRecorded(ctx, me.tenantId, {
        now,
        closerId: args.closerId,
        cursor: args.cursor,
        limit,
      });
      items = await Promise.all(page.rows.map((r) => meetingItem(ctx, me, r)));
      isPartial = page.isPartial;
      cursor = page.cursor;
    }
  } else if (args.queue === "missed_meetings") {
    const page = args.itemId
      ? {
          page: [
            await loadInTenant(
              ctx,
              me,
              "opportunities",
              await tenantId(ctx, me, "opportunities", args.itemId),
            ),
          ],
          isDone: true,
          continueCursor: "",
        }
      : await ctx.db
          .query("opportunities")
          .withIndex(
            "by_tenantId_and_stage_and_outcome_and_latestActivityAt",
            (q) =>
              q
                .eq("tenantId", me.tenantId)
                .eq("stage", "closed")
                .eq("outcome", "lost"),
          )
          .paginate(options);
    items = await Promise.all(
      page.page
        .filter((r) => isMissedMeetingLoss(r) && closer(r.assignedCloserId))
        .map((r) => missedItem(ctx, me, r)),
    );
    isPartial = !page.isDone;
    cursor = page.isDone ? null : page.continueCursor;
  } else if (args.queue === "second_opinions") {
    if (!canSeeOpinions(me)) {
      if (args.itemId) notFound();
    } else {
      const query = args.closerId
        ? ctx.db
            .query("secondOpinions")
            .withIndex(
              "by_tenantId_and_closerUserId_and_reviewState_and_createdAt",
              (q) =>
                q
                  .eq("tenantId", me.tenantId)
                  .eq("closerUserId", args.closerId!)
                  .eq("reviewState", "open"),
            )
        : ctx.db
            .query("secondOpinions")
            .withIndex("by_tenantId_and_reviewState_and_createdAt", (q) =>
              q.eq("tenantId", me.tenantId).eq("reviewState", "open"),
            );
      const page = args.itemId
        ? {
            page: [
              await loadInTenant(
                ctx,
                me,
                "secondOpinions",
                await tenantId(ctx, me, "secondOpinions", args.itemId),
              ),
            ],
            isDone: true,
            continueCursor: "",
          }
        : await query.paginate(options);
      items = await Promise.all(
        page.page
          .filter(
            (r) =>
              r.status === "answered" &&
              r.reviewState === "open" &&
              closer(r.closerUserId),
          )
          .map((r) => opinionItem(ctx, me, r)),
      );
      isPartial = !page.isDone;
      cursor = page.isDone ? null : page.continueCursor;
    }
  } else if (args.queue === "booking_reviews") {
    if (args.closerId)
      throw rejectRequest("queue.no_closer_filter", "Booking reviews have no closer filter.");
    const page = args.itemId
      ? {
          page: [
            await loadInTenant(
              ctx,
              me,
              "bookingReviews",
              await tenantId(ctx, me, "bookingReviews", args.itemId),
            ),
          ],
          isDone: true,
          continueCursor: "",
        }
      : await ctx.db
          .query("bookingReviews")
          .withIndex("by_tenantId_and_status_and_createdAt", (q) =>
            q.eq("tenantId", me.tenantId).eq("status", "open"),
          )
          .paginate(options);
    items = page.page
      .filter((r) => r.status === "open")
      .map((r) => bookingItem(me, r));
    isPartial = !page.isDone;
    cursor = page.isDone ? null : page.continueCursor;
  } else if (args.queue === "unmatched_recordings") {
    const page = args.itemId
      ? {
          page: [
            await loadInTenant(
              ctx,
              me,
              "callRecordings",
              await tenantId(ctx, me, "callRecordings", args.itemId),
            ),
          ],
          isDone: true,
          continueCursor: "",
        }
      : await ctx.db
          .query("callRecordings")
          .withIndex("by_tenantId_and_matchStatus_and_createdAt", (q) =>
            q.eq("tenantId", me.tenantId).eq("matchStatus", "unmatched"),
          )
          .paginate(options);
    items = page.page
      .filter(
        (r) => r.matchStatus === "unmatched" && closer(r.recordedByUserId),
      )
      .map((r) => recordingItem(me, r));
    isPartial = !page.isDone;
    cursor = page.isDone ? null : page.continueCursor;
  } else if (args.queue === "team_review") {
    if (args.closerId) throw rejectRequest("queue.no_closer_filter", "Team review has no closer filter.");
    const review = await buildTeamReview(ctx, me.tenantId);
    const offset = args.cursor ? Number(args.cursor) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) notFound();
    const selected = args.itemId
      ? review.items.filter((r) => r.key === args.itemId)
      : review.items.slice(offset, offset + limit);
    items = selected.map((r) =>
      item(
        me,
        "team_review",
        r.key,
        "Team member review",
        null,
        [r.kind],
        ["magnus_queue", "magnus_lookup"],
        appLink("/workspace/team/review"),
        "admin",
      ),
    );
    isPartial = !args.itemId && offset + limit < review.items.length;
    cursor = isPartial ? String(offset + limit) : null;
  } else {
    if (args.closerId) throw rejectRequest("queue.no_closer_filter", "Failed work has no closer filter.");
    if (args.itemId) {
      for (const table of [
        "meetingProjections",
        "opportunityProjectionJobs",
        "webhookDeliveries",
      ] as const) {
        const id = ctx.db.normalizeId(table, args.itemId);
        if (!id) continue;
        const row = await ctx.db.get(table, id);
        if (
          row?.tenantId === me.tenantId &&
          (row.status === "failed" || row.status === "blocked")
        )
          items = [failedItem(me, row)];
      }
    } else {
      let c: { source: number; cursor: string | null } | null = { source: 0, cursor: null };
      if (args.cursor) {
        try {
          c = JSON.parse(args.cursor) as typeof c;
        } catch {
          c = null;
        }
      }
      if (
        !c ||
        typeof c !== "object" ||
        !Number.isInteger(c.source) ||
        c.source < 0 ||
        c.source > 3 ||
        !(typeof c.cursor === "string" || c.cursor === null)
      )
        notFound();
      const page = await failedSources(ctx, me)[c.source].paginate({
        ...options,
        cursor: c.cursor,
      });
      items = page.page.map((r) => failedItem(me, r));
      isPartial = !page.isDone || c.source < 3;
      cursor = isPartial
        ? JSON.stringify({
            source: page.isDone ? c.source + 1 : c.source,
            cursor: page.isDone ? null : page.continueCursor,
          })
        : null;
    }
  }
  if (args.itemId && !items.length) notFound();
  return {
    queue: args.queue,
    items,
    cursor,
    isPartial,
    reason: partialReason(isPartial),
    timeZone: me.timeZone,
  };
}

/** Counts are bounded lower bounds when capped; oldest uses the indexed ascending order. */
export async function buildQueueSummary(
  ctx: QueryCtx,
  me: Admin,
  queue: Queue,
) {
  let count = 0,
    capped = false,
    oldest: number | null = null;
  const finish = () => ({
    queue,
    count,
    isPartial: capped,
    oldestAgeSeconds:
      oldest === null
        ? null
        : Math.max(0, Math.floor((Date.now() - oldest) / 1000)),
    oldestAt: oldest === null ? null : formatLocal(oldest, me.timeZone),
  });
  if (queue === "not_recorded") {
    const s = await readNotRecorded(ctx, me.tenantId, Date.now());
    count = s.rows.length;
    capped = s.capped;
    oldest = s.rows.length
      ? Math.min(
          ...s.rows.map((r) => r.scheduledAt + r.durationMinutes * 60000),
        )
      : null;
  } else if (queue === "payments_to_review") {
    const s = await readLiveQueryRows(
      ctx.db
        .query("paymentRecords")
        .withIndex("by_tenantId_and_status_and_recordedAt", (q) =>
          q.eq("tenantId", me.tenantId).eq("status", "recorded"),
        ),
      100,
    );
    count = s.rows.length;
    capped = s.capped;
    oldest = s.rows[0]?.recordedAt ?? null;
  } else if (queue === "booking_reviews") {
    const s = await readLiveQueryRows(
      ctx.db
        .query("bookingReviews")
        .withIndex("by_tenantId_and_status_and_createdAt", (q) =>
          q.eq("tenantId", me.tenantId).eq("status", "open"),
        ),
      100,
    );
    count = s.rows.length;
    capped = s.capped;
    oldest = s.rows[0]?.createdAt ?? null;
  } else if (queue === "second_opinions") {
    if (canSeeOpinions(me)) {
      const s = await readLiveQueryRows(
        ctx.db
          .query("secondOpinions")
          .withIndex("by_tenantId_and_reviewState_and_createdAt", (q) =>
            q.eq("tenantId", me.tenantId).eq("reviewState", "open"),
          ),
        100,
      );
      const rows = s.rows.filter((r) => r.status === "answered");
      count = rows.length;
      capped = s.capped;
      oldest = rows[0]?.createdAt ?? null;
    }
  } else if (queue === "missed_meetings") {
    const s = await readLiveQueryRows(
      ctx.db
        .query("opportunities")
        .withIndex(
          "by_tenantId_and_stage_and_outcome_and_latestActivityAt",
          (q) =>
            q
              .eq("tenantId", me.tenantId)
              .eq("stage", "closed")
              .eq("outcome", "lost"),
        ),
      300,
    );
    const rows = s.rows.filter(isMissedMeetingLoss);
    count = rows.length;
    capped = s.capped;
    oldest = rows.length
      ? Math.min(...rows.map((r) => r.lostAt ?? r.updatedAt))
      : null;
  } else if (queue === "failed_work") {
    for (const source of failedSources(ctx, me)) {
      const s = await readLiveQueryRows<FailedRow>(source, 100);
      count += s.rows.length;
      capped ||= s.capped;
      for (const r of s.rows) {
        const at = "requestedAt" in r ? r.requestedAt : r.receivedAt;
        oldest = oldest === null ? at : Math.min(oldest, at);
      }
    }
  }
  return finish();
}
export const queueSummaryValidator = v.object({
  queue: queueValidator,
  count: v.number(),
  isPartial: v.boolean(),
  oldestAgeSeconds: v.union(v.number(), v.null()),
  oldestAt: v.union(v.string(), v.null()),
});
export const run = internalQuery({
  args: { caller: mcpCallerValidator, ...queueArgs },
  returns: v.object({
    queue: queueValidator,
    items: v.array(queueItemValidator),
    cursor: v.union(v.string(), v.null()),
    isPartial: v.boolean(),
    reason: v.union(v.string(), v.null()),
    timeZone: v.string(),
  }),
  handler: async (ctx, { caller, ...args }) => {
    const me = await requireMcpAdmin(ctx, caller);
    return await buildQueue(ctx, me, args);
  },
});
