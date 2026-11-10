import { v } from "convex/values";
import type { PaginationResult } from "convex/server";
import type { Doc, Id, TableNames } from "../../../_generated/dataModel";
import { stream } from "convex-helpers/server/stream";
import schema from "../../../schema";
import { getTenantBusinessDay } from "../../../lib/tenantBusinessDay";
import {
  addBusinessDays,
  businessDateForInstant,
  businessDayStart,
} from "../../../../lib/businessDay";
import { meetingAttendanceDisplay } from "../../../../lib/status-config";
import { internalQuery, type QueryCtx } from "../../../_generated/server";
import {
  createLiveReadState,
  readLiveQueryRows,
  type LiveReadState,
} from "../../../lib/liveQueryBounds";
import { isMissedMeetingLoss } from "../../../opportunities/dealState";
import { buildTeamReview } from "../../../team/reviewCore";
import {
  mcpCallerValidator,
  requireMcpAdmin,
  loadInTenant,
  normalizeMcpId,
} from "../../guard";
import { rejectRequest } from "../../../lib/observability/errors";
import { formatLocal } from "../../time";
import { appLink } from "../prepare";
import {
  type Admin,
  text,
  textValidator,
  ageValidator,
  tenantId,
  notFound,
  canSeeOpinions,
  paymentActions,
  dealActions,
  meetingActions,
  paths,
  partialReason,
} from "./common";
import { countNotRecorded, pageNotRecorded } from "./notRecorded";

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
  // A string, so a malformed or wrong-table ID gets a readable error.
  closerId: v.optional(v.string()),
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
/** failedSources as streams, which a page may paginate in turn. */
function failedStreams(ctx: QueryCtx, me: Admin) {
  const db = stream(ctx.db, schema);
  return [
    db
      .query("meetingProjections")
      .withIndex("by_tenantId_and_status_and_requestedAt", (q) =>
        q.eq("tenantId", me.tenantId).eq("status", "failed"),
      ),
    db
      .query("opportunityProjectionJobs")
      .withIndex("by_tenantId_and_status_and_requestedAt", (q) =>
        q.eq("tenantId", me.tenantId).eq("status", "failed"),
      ),
    db
      .query("webhookDeliveries")
      .withIndex("by_tenantId_and_status_and_receivedAt", (q) =>
        q.eq("tenantId", me.tenantId).eq("status", "failed"),
      ),
    db
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
/**
 * A queue cursor names its queue, closer filter and the minute it was first
 * read (`asOf`), so every page reads the same index range and a cursor can't
 * be replayed against other filters. Positions are the native cursors.
 */
type QueueCursor = {
  v: 1;
  queue: Queue;
  closerId: string | null;
  asOf: number;
  position: unknown;
};
function invalidCursor(): never {
  throw rejectRequest(
    "mcp.invalid_cursor",
    "Use the cursor this tool returned, with the same queue and closerId, or start again without one.",
  );
}
function readCursor(
  raw: string | undefined,
  queue: Queue,
  closerId: Id<"users"> | undefined,
): QueueCursor | null {
  if (raw === undefined || raw === "") return null;
  let cursor: QueueCursor;
  try {
    cursor = JSON.parse(raw) as QueueCursor;
  } catch {
    invalidCursor();
  }
  if (
    !cursor ||
    typeof cursor !== "object" ||
    cursor.v !== 1 ||
    cursor.queue !== queue ||
    cursor.closerId !== (closerId ?? null) ||
    !Number.isSafeInteger(cursor.asOf)
  )
    invalidCursor();
  return cursor;
}
function nativePosition(cursor: QueueCursor | null): string | null {
  if (!cursor) return null;
  if (typeof cursor.position !== "string") invalidCursor();
  return cursor.position;
}
/** A native cursor that no longer fits its query is the caller's to restart. */
async function paged<T>(position: string | null, read: () => Promise<T>) {
  try {
    return await read();
  } catch (error) {
    if (position !== null) invalidCursor();
    throw error;
  }
}
/**
 * The person has a deal created after this one: the No-shows and
 * cancellations page's "booked again" rule (operations/missedMeetings.ts).
 */
async function bookedAgain(
  ctx: QueryCtx,
  deal: Doc<"opportunities">,
  budget?: { state: LiveReadState; bytes: number },
) {
  const query = ctx.db
    .query("opportunities")
    .withIndex("by_tenantId_and_leadId", (q) =>
      q.eq("tenantId", deal.tenantId).eq("leadId", deal.leadId),
    )
    .order("desc");
  const deals = budget
    ? (await readLiveQueryRows(query, 10, budget.state, budget.bytes)).rows
    : await query.take(10);
  return deals.some((d) => d._id !== deal._id && d.createdAt > deal.createdAt);
}
/** Missed-meeting losses the queue shows: the web list's default window. */
export const MISSED_MEETINGS_DAYS = 30;
const MISSED_SUMMARY_ROWS = 1_000,
  MISSED_SUMMARY_BYTES = 4 * 1024 * 1024,
  // The person's other deals, read once per missed loss, share their own budget.
  MISSED_HISTORY_BYTES = 4 * 1024 * 1024;
async function missedWindow(ctx: QueryCtx, me: Admin, asOf: number) {
  const day = await getTenantBusinessDay(ctx, me.tenantId);
  const today = businessDateForInstant(asOf, day);
  return businessDayStart(
    addBusinessDays(today, -(MISSED_MEETINGS_DAYS - 1)),
    day,
  );
}
function missedCandidates(ctx: QueryCtx, me: Admin, start: number) {
  return stream(ctx.db, schema)
    .query("opportunities")
    .withIndex("by_tenantId_and_stage_and_outcome_and_latestActivityAt", (q) =>
      q
        .eq("tenantId", me.tenantId)
        .eq("stage", "closed")
        .eq("outcome", "lost")
        .gte("latestActivityAt", start),
    );
}
async function isOpenMissedMeeting(
  ctx: QueryCtx,
  deal: Doc<"opportunities">,
  start: number,
  asOf: number,
  budget?: { state: LiveReadState; bytes: number },
) {
  return (
    isMissedMeetingLoss(deal) !== null &&
    deal.lostAt !== undefined &&
    deal.lostAt >= start &&
    deal.lostAt <= asOf &&
    !(await bookedAgain(ctx, deal, budget))
  );
}
type TeamReviewItem = Awaited<
  ReturnType<typeof buildTeamReview>
>["items"][number];
async function teamReviewItem(ctx: QueryCtx, me: Admin, row: TeamReviewItem) {
  const name = async (id: Id<"teamMembers">) => {
    const member = await ctx.db.get("teamMembers", id);
    return member?.tenantId === me.tenantId
      ? member.displayName
      : "Removed member";
  };
  const title =
    row.kind === "same_human"
      ? `Same person? ${(await Promise.all(row.members.map(name))).join(" and ")}`
      : row.kind === "slack_unlinked"
        ? `Slack user not linked to a login: ${await name(row.teamMemberId)}`
        : `${await name(row.teamMemberId)}: lead gen and DM closer teams differ`;
  return item(
    me,
    "team_review",
    row.key,
    title,
    null,
    [row.kind],
    ["magnus_queue"],
    appLink("/workspace/team/review"),
    "admin",
  );
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
  // Ten full items fit the gateway's answer, which carries each twice.
  const limit = args.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10)
    throw rejectRequest("mcp.invalid_limit", "Use a limit from 1 to 10.");
  if (args.closerId) await loadInTenant(ctx, me, "users", args.closerId);
  const itemId = args.itemId === "" ? undefined : args.itemId;
  const previous = itemId
    ? null
    : readCursor(args.cursor, args.queue, args.closerId);
  // The minute the first page was read. Later pages keep it.
  const asOf = previous?.asOf ?? Math.floor(Date.now() / 60_000) * 60_000;
  let items: QueueItem[] = [],
    done = true,
    position: unknown = null;
  const options = (cursor: string | null) => ({
    cursor,
    numItems: limit,
    maximumRowsRead: limit,
    maximumBytesRead: 512 * 1024,
  });
  // Filtered streams fill a page from up to this many index rows.
  const filtered = (cursor: string | null) => ({
    cursor,
    numItems: limit,
    maximumRowsRead: 300,
  });
  const closer = (id: Id<"users"> | undefined) =>
    !args.closerId || id === args.closerId;
  const one = async <T extends TableNames>(table: T) =>
    await loadInTenant(ctx, me, table, await tenantId(ctx, me, table, itemId!));
  if (args.queue === "payments_to_review") {
    if (itemId) {
      const row = await one("paymentRecords");
      if (row.status !== "recorded" || !closer(row.attributedCloserId))
        notFound();
      items = [await paymentItem(ctx, me, row)];
    } else {
      const at = nativePosition(previous);
      const page = await paged(at, () =>
        args.closerId
          ? stream(ctx.db, schema)
              .query("paymentRecords")
              .withIndex(
                "by_tenantId_and_attributedCloserId_and_recordedAt",
                (q) =>
                  q
                    .eq("tenantId", me.tenantId)
                    .eq("attributedCloserId", args.closerId),
              )
              .filterWith(async (r) => r.status === "recorded")
              .paginate(filtered(at))
          : ctx.db
              .query("paymentRecords")
              .withIndex("by_tenantId_and_status_and_recordedAt", (q) =>
                q.eq("tenantId", me.tenantId).eq("status", "recorded"),
              )
              .paginate(options(at)),
      );
      items = await Promise.all(
        page.page
          .filter((r) => r.status === "recorded")
          .map((r) => paymentItem(ctx, me, r)),
      );
      done = page.isDone;
      position = page.continueCursor;
    }
  } else if (args.queue === "not_recorded") {
    if (itemId) {
      const row = await one("meetings");
      if (
        meetingAttendanceDisplay(row, Date.now()) !== "not_recorded" ||
        !closer(row.assignedCloserId)
      )
        notFound();
      items = [await meetingItem(ctx, me, row)];
    } else {
      const at = nativePosition(previous);
      const page = await paged(at, () =>
        pageNotRecorded(ctx, me.tenantId, {
          cutoff: asOf,
          closerId: args.closerId,
          cursor: at,
          limit,
        }),
      );
      items = await Promise.all(page.rows.map((r) => meetingItem(ctx, me, r)));
      done = page.isDone;
      position = page.continueCursor;
    }
  } else if (args.queue === "missed_meetings") {
    const start = await missedWindow(ctx, me, asOf);
    if (itemId) {
      const row = await one("opportunities");
      if (
        !(await isOpenMissedMeeting(ctx, row, start, Date.now())) ||
        !closer(row.assignedCloserId)
      )
        notFound();
      items = [await missedItem(ctx, me, row)];
    } else {
      const at = nativePosition(previous);
      const page = await paged(at, () =>
        missedCandidates(ctx, me, start)
          .filterWith(
            async (r) =>
              closer(r.assignedCloserId) &&
              (await isOpenMissedMeeting(ctx, r, start, asOf)),
          )
          // Each row also reads the person's deals: a smaller scan per page.
          .paginate({ ...filtered(at), maximumRowsRead: 100 }),
      );
      items = await Promise.all(page.page.map((r) => missedItem(ctx, me, r)));
      done = page.isDone;
      position = page.continueCursor;
    }
  } else if (args.queue === "second_opinions") {
    if (!canSeeOpinions(me)) {
      if (itemId) notFound();
    } else if (itemId) {
      const row = await one("secondOpinions");
      if (
        row.status !== "answered" ||
        row.reviewState !== "open" ||
        !closer(row.closerUserId)
      )
        notFound();
      items = [await opinionItem(ctx, me, row)];
    } else {
      const at = nativePosition(previous);
      const base = stream(ctx.db, schema).query("secondOpinions");
      const query = args.closerId
        ? base.withIndex(
            "by_tenantId_and_closerUserId_and_reviewState_and_createdAt",
            (q) =>
              q
                .eq("tenantId", me.tenantId)
                .eq("closerUserId", args.closerId!)
                .eq("reviewState", "open"),
          )
        : base.withIndex("by_tenantId_and_reviewState_and_createdAt", (q) =>
            q.eq("tenantId", me.tenantId).eq("reviewState", "open"),
          );
      const page = await paged(at, () =>
        query
          .filterWith(async (r) => r.status === "answered")
          .paginate(filtered(at)),
      );
      items = await Promise.all(page.page.map((r) => opinionItem(ctx, me, r)));
      done = page.isDone;
      position = page.continueCursor;
    }
  } else if (args.queue === "booking_reviews") {
    if (args.closerId)
      throw rejectRequest("queue.no_closer_filter", "Booking reviews have no closer filter.");
    if (itemId) {
      const row = await one("bookingReviews");
      if (row.status !== "open") notFound();
      items = [bookingItem(me, row)];
    } else {
      const at = nativePosition(previous);
      const page = await paged(at, () =>
        ctx.db
          .query("bookingReviews")
          .withIndex("by_tenantId_and_status_and_createdAt", (q) =>
            q.eq("tenantId", me.tenantId).eq("status", "open"),
          )
          .paginate(options(at)),
      );
      items = page.page
        .filter((r) => r.status === "open")
        .map((r) => bookingItem(me, r));
      done = page.isDone;
      position = page.continueCursor;
    }
  } else if (args.queue === "unmatched_recordings") {
    if (itemId) {
      const row = await one("callRecordings");
      if (row.matchStatus !== "unmatched" || !closer(row.recordedByUserId))
        notFound();
      items = [recordingItem(me, row)];
    } else {
      const at = nativePosition(previous);
      const page = await paged(at, () =>
        args.closerId
          ? ctx.db
              .query("callRecordings")
              .withIndex("by_tenantId_and_recordedByUserId_and_matchStatus", (q) =>
                q
                  .eq("tenantId", me.tenantId)
                  .eq("recordedByUserId", args.closerId)
                  .eq("matchStatus", "unmatched"),
              )
              .paginate(options(at))
          : ctx.db
              .query("callRecordings")
              .withIndex("by_tenantId_and_matchStatus_and_createdAt", (q) =>
                q.eq("tenantId", me.tenantId).eq("matchStatus", "unmatched"),
              )
              .paginate(options(at)),
      );
      items = page.page
        .filter((r) => r.matchStatus === "unmatched")
        .map((r) => recordingItem(me, r));
      done = page.isDone;
      position = page.continueCursor;
    }
  } else if (args.queue === "team_review") {
    if (args.closerId) throw rejectRequest("queue.no_closer_filter", "Team review has no closer filter.");
    const review = await buildTeamReview(ctx, me.tenantId);
    if (itemId) {
      const row = review.items.find((r) => r.key === itemId);
      if (!row) notFound();
      items = [await teamReviewItem(ctx, me, row)];
    } else {
      const offset = previous?.position ?? 0;
      if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0)
        invalidCursor();
      items = await Promise.all(
        review.items
          .slice(offset, offset + limit)
          .map((r) => teamReviewItem(ctx, me, r)),
      );
      done = offset + limit >= review.items.length;
      position = offset + limit;
    }
  } else {
    if (args.closerId) throw rejectRequest("queue.no_closer_filter", "Failed work has no closer filter.");
    if (itemId) {
      for (const table of [
        "meetingProjections",
        "opportunityProjectionJobs",
        "webhookDeliveries",
      ] as const) {
        const id = ctx.db.normalizeId(table, itemId);
        if (!id) continue;
        const row = await ctx.db.get(table, id);
        if (
          row?.tenantId === me.tenantId &&
          (row.status === "failed" || row.status === "blocked")
        )
          items = [failedItem(me, row)];
      }
    } else {
      // Four sources in turn; a page keeps reading the next source until it
      // is full, so an empty source never costs the agent a call.
      let at = (previous?.position ?? { source: 0, cursor: null }) as {
        source: number;
        cursor: string | null;
      };
      if (
        !at ||
        typeof at !== "object" ||
        !Number.isInteger(at.source) ||
        at.source < 0 ||
        at.source > 3 ||
        !(typeof at.cursor === "string" || at.cursor === null)
      )
        invalidCursor();
      // Streams, not native pagination: a function may call .paginate() once.
      const sources = failedStreams(ctx, me);
      for (;;) {
        const source = at.source,
          cursor = at.cursor;
        const page = await paged(cursor, (): Promise<PaginationResult<FailedRow>> =>
          sources[source].paginate({
            cursor,
            numItems: limit - items.length,
            maximumRowsRead: limit - items.length,
          }),
        );
        items.push(...page.page.map((r) => failedItem(me, r)));
        at = page.isDone
          ? { source: source + 1, cursor: null }
          : { source, cursor: page.continueCursor };
        if (at.source > 3 || items.length >= limit) break;
      }
      done = at.source > 3;
      position = at;
    }
  }
  if (itemId && !items.length) notFound();
  const cursor = done
    ? null
    : JSON.stringify({
        v: 1,
        queue: args.queue,
        closerId: args.closerId ?? null,
        asOf,
        position,
      } satisfies QueueCursor);
  return {
    queue: args.queue,
    items,
    cursor,
    isPartial: cursor !== null,
    reason: partialReason(cursor !== null, true),
    timeZone: me.timeZone,
  };
}

/**
 * A queue's whole backlog. `count` is exact or null; when a bounded read
 * can't see the end, `count` is null and `atLeast` is what it saw, so no
 * capped scan reads as a total. Oldest uses each index's ascending order.
 */
export async function buildQueueSummary(
  ctx: QueryCtx,
  me: Admin,
  queue: Queue,
) {
  const now = Date.now();
  let count: number | null = 0,
    atLeast = 0,
    oldest: number | null = null;
  const seen = (rows: number, capped: boolean) => {
    atLeast = rows;
    count = capped ? null : rows;
  };
  if (queue === "not_recorded") {
    const s = await countNotRecorded(ctx, me.tenantId, now);
    count = s.count;
    atLeast = s.count ?? s.atLeast;
    oldest = s.oldest;
  } else if (queue === "payments_to_review") {
    const s = await readLiveQueryRows(
      ctx.db
        .query("paymentRecords")
        .withIndex("by_tenantId_and_status_and_recordedAt", (q) =>
          q.eq("tenantId", me.tenantId).eq("status", "recorded"),
        ),
      100,
    );
    seen(s.rows.length, s.capped);
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
    seen(s.rows.length, s.capped);
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
      seen(rows.length, s.capped);
      oldest = rows[0]?.createdAt ?? null;
    }
  } else if (queue === "missed_meetings") {
    const start = await missedWindow(ctx, me, now);
    const s = await readLiveQueryRows(
      ctx.db
        .query("opportunities")
        .withIndex(
          "by_tenantId_and_stage_and_outcome_and_latestActivityAt",
          (q) =>
            q
              .eq("tenantId", me.tenantId)
              .eq("stage", "closed")
              .eq("outcome", "lost")
              .gte("latestActivityAt", start),
        ),
      // Its own budget: the 30-day window bounds the deals (474 on
      // production) and so the booked-again lookups, one per deal. Deal
      // documents are large, so the shared 512 KB budget stopped near 400.
      MISSED_SUMMARY_ROWS,
      undefined,
      MISSED_SUMMARY_BYTES,
    );
    // One at a time, so the shared history budget stops the read cleanly.
    const history = { state: createLiveReadState(), bytes: MISSED_HISTORY_BYTES };
    const rows = [];
    for (const r of s.rows) {
      const open = await isOpenMissedMeeting(ctx, r, start, now, history);
      // A capped read may have missed the newer deal, so this one is unknown.
      if (history.state.capped) break;
      if (open) rows.push(r);
    }
    seen(rows.length, s.capped || history.state.capped);
    oldest = rows.length ? Math.min(...rows.map((r) => r.lostAt!)) : null;
  } else if (queue === "unmatched_recordings") {
    const s = await readLiveQueryRows(
      ctx.db
        .query("callRecordings")
        .withIndex("by_tenantId_and_matchStatus_and_createdAt", (q) =>
          q.eq("tenantId", me.tenantId).eq("matchStatus", "unmatched"),
        ),
      100,
    );
    seen(s.rows.length, s.capped);
    oldest = s.rows[0]?.createdAt ?? null;
  } else if (queue === "team_review") {
    seen((await buildTeamReview(ctx, me.tenantId)).count, false);
  } else if (queue === "failed_work") {
    let rows = 0,
      capped = false;
    for (const source of failedSources(ctx, me)) {
      const s = await readLiveQueryRows<FailedRow>(source, 100);
      rows += s.rows.length;
      capped ||= s.capped;
      for (const r of s.rows) {
        const at = "requestedAt" in r ? r.requestedAt : r.receivedAt;
        oldest = oldest === null ? at : Math.min(oldest, at);
      }
    }
    seen(rows, capped);
  }
  return {
    queue,
    count,
    atLeast,
    isPartial: count === null,
    oldestAgeSeconds:
      oldest === null ? null : Math.max(0, Math.floor((now - oldest) / 1000)),
    oldestAt: oldest === null ? null : formatLocal(oldest, me.timeZone),
  };
}
export const queueSummaryValidator = v.object({
  queue: queueValidator,
  count: v.union(v.number(), v.null()),
  atLeast: v.number(),
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
  handler: async (ctx, { caller, closerId, ...args }) => {
    const me = await requireMcpAdmin(ctx, caller);
    return await buildQueue(ctx, me, {
      ...args,
      ...(closerId === undefined
        ? {}
        : { closerId: normalizeMcpId(ctx, "users", closerId, "closerId") }),
    });
  },
});
