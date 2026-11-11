import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { query, mutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { requireTenantUser } from "./requireTenantUser";
import { hasPermission } from "./lib/permissions";
import { rejectRequest } from "./lib/observability/errors";
import { log } from "./lib/observability/log";
import { emitDomainEvent } from "./lib/domainEvents";
import {
  assertCoreRole,
  provenanceMetadata,
  toCheckResult,
  WEB,
  type CheckResult,
  type CoreActor,
  type Provenance,
} from "./lib/outcomeCores";
import { businessDayClosed, hasResult, queueRerun } from "./secondOpinion/trigger";
import { monthRange, monthSummary } from "./secondOpinion/month";
import { adminCreateFollowUpCore } from "./admin/meetingActions";
import { parseLocalDateTime } from "./mcp/time";

const modeValidator = v.union(
  v.literal("off"),
  v.literal("shadow"),
  v.literal("on"),
);
const summaryValidator = v.object({
  costUsd: v.number(),
  total: v.number(),
  agrees: v.number(),
  hints: v.number(),
  disagrees: v.number(),
  unsure: v.number(),
  checked: v.number(),
  answered: v.number(),
  failed: v.number(),
  capped: v.boolean(),
});
const rowValidator = v.object({
  ...schema.tables.secondOpinions.validator.fields,
  _id: v.id("secondOpinions"),
  _creationTime: v.number(),
});
const viewValidator = v.object({
  opinion: rowValidator,
  person: v.string(),
  closer: v.string(),
  program: v.optional(v.string()),
  scheduledAt: v.number(),
  reviewer: v.optional(v.string()),
  canAddNote: v.boolean(),
  canReview: v.boolean(),
  canReopen: v.boolean(),
  // An owner or admin can run Jev again on the latest check of a meeting.
  canRerun: v.boolean(),
  recordingUrl: v.optional(v.string()),
  summary: v.optional(v.string()),
  actionItems: v.array(v.string()),
  timeZone: v.string(),
  callbackTimeZone: v.string(),
});
const reviewOutcome = v.union(
  v.literal("closer_right"),
  v.literal("second_opinion_right"),
);
const SHADOW_MS = 14 * 86400_000;

/**
 * Everyone allowed sees results once the second opinion is on. During the
 * shadow run, owners and admins who work the review queue see them so they
 * can tune Jev against what they know about the calls; closers don't.
 */
function maySee(me: CoreActor, tenant: Doc<"tenants">) {
  return (
    tenant.secondOpinion?.mode === "on" ||
    (tenant.secondOpinion?.mode === "shadow" &&
      hasPermission(me.role, "second-opinion:review"))
  );
}
async function view(
  ctx: QueryCtx,
  me: CoreActor,
  opinion: Doc<"secondOpinions">,
) {
  const meeting = await ctx.db.get("meetings", opinion.meetingId);
  if (
    !meeting ||
    meeting.tenantId !== me.tenantId ||
    opinion.tenantId !== me.tenantId
  )
    return null;
  const [tenant, closer, deal, recording, reviewer, user] = await Promise.all([
    ctx.db.get("tenants", me.tenantId),
    ctx.db.get("users", meeting.assignedCloserId),
    ctx.db.get("opportunities", meeting.opportunityId),
    ctx.db.get("callRecordings", opinion.recordingId),
    opinion.review ? ctx.db.get("users", opinion.review.byUserId) : null,
    ctx.db.get("users", me.userId),
  ]);
  // Reviewers also see a check that is running, skipped or failed, so they
  // can see why and run it again. Closers see answers only.
  if (
    !tenant ||
    !maySee(me, tenant) ||
    (opinion.status !== "answered" &&
      !hasPermission(me.role, "second-opinion:review"))
  )
    return null;
  const isCloser =
    me.role === "closer" && meeting.assignedCloserId === me.userId;
  if (
    me.role === "closer" &&
    (!isCloser ||
      (!hasResult(meeting) &&
        !(
          opinion.verdict === "hint" &&
          businessDayClosed(meeting, tenant, Date.now())
        )))
  )
    return null;
  const canReview = hasPermission(me.role, "second-opinion:review");
  const matched =
    recording?.tenantId === me.tenantId &&
    recording.meetingId === meeting._id &&
    recording.matchStatus === "matched";
  return {
    opinion,
    person: meeting.leadName ?? "Sales call",
    closer: closer?.fullName ?? "Closer",
    program: meeting.bookingProgramName,
    scheduledAt: meeting.scheduledAt,
    reviewer: reviewer?.fullName ?? reviewer?.email,
    canAddNote:
      isCloser &&
      opinion.verdict === "disagrees" &&
      opinion.reviewState === "open" &&
      !opinion.closerNote,
    canReview,
    canRerun:
      canReview &&
      opinion.supersededById === undefined &&
      tenant.secondOpinion?.mode !== "off",
    canReopen:
      canReview &&
      opinion.record?.kind === "no_show" &&
      meeting.status === "no_show" &&
      deal?.outcome === "lost" &&
      deal.lostReason === "no_show",
    recordingUrl: matched ? recording.shareUrl || recording.url : undefined,
    summary: matched ? recording.summaryMarkdown : undefined,
    actionItems: matched
      ? (recording.actionItems ?? []).map((i) => i.description)
      : [],
    callbackTimeZone:
      closer?.timezone ?? tenant.businessDay?.timeZone ?? "America/Tegucigalpa",
    timeZone:
      user?.timezone ?? tenant.businessDay?.timeZone ?? "America/Tegucigalpa",
  };
}

export const setMode = mutation({
  args: { mode: modeValidator, monthlyCapUsd: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const me = await requireTenantUser(ctx, ["tenant_master"]);
    if (!hasPermission(me.role, "second-opinion:manage"))
      throw rejectRequest(
        "second_opinion.manage_denied",
        "Only an owner can change the second opinion.",
      );
    if (
      !Number.isFinite(args.monthlyCapUsd) ||
      args.monthlyCapUsd <= 0 ||
      args.monthlyCapUsd > 10000
    )
      throw rejectRequest(
        "second_opinion.invalid_cap",
        "Set a monthly cap greater than $0 and no more than $10,000.",
      );
    const tenant = await ctx.db.get("tenants", me.tenantId);
    const previous = tenant?.secondOpinion;
    const now = Date.now();
    let mode = args.mode;
    let shadowUntil = previous?.shadowUntil;
    if (mode !== "off" && (!previous || previous.mode === "off")) {
      mode = "shadow";
      shadowUntil = now + SHADOW_MS;
    } else if (
      mode === "on" &&
      previous?.mode === "shadow" &&
      (!shadowUntil || now < shadowUntil)
    )
      throw rejectRequest(
        "second_opinion.shadow_in_progress",
        "The 14-day shadow run must finish before opening results to closers and admins.",
      );
    else if (mode === "shadow" && previous?.mode === "on")
      shadowUntil = now + SHADOW_MS;
    await ctx.db.patch("tenants", me.tenantId, {
      secondOpinion: {
        mode,
        shadowUntil,
        monthlyCapUsd: args.monthlyCapUsd,
        changedAt: now,
        changedByUserId: me.userId,
      },
    });
    log.info("second_opinion.access_changed", {
      tenantId: me.tenantId,
      actorUserId: me.userId,
      mode,
      monthlyCapUsd: args.monthlyCapUsd,
    });
    return null;
  },
});
export const getSettings = query({
  args: {},
  returns: v.object({
    mode: modeValidator,
    monthlyCapUsd: v.number(),
    shadowDay: v.number(),
    readyToOpen: v.boolean(),
    month: summaryValidator,
    paused: v.boolean(),
    resetsAt: v.number(),
    canManage: v.boolean(),
    visible: v.boolean(),
  }),
  handler: async (ctx) => {
    const me = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);
    const tenant = await ctx.db.get("tenants", me.tenantId);
    const setting = tenant?.secondOpinion;
    const now = Date.now();
    const visible = Boolean(tenant && maySee(me, tenant));
    const month = visible
      ? await monthSummary(ctx, me.tenantId, now)
      : {
          costUsd: 0,
          total: 0,
          agrees: 0,
          hints: 0,
          disagrees: 0,
          unsure: 0,
          checked: 0,
          answered: 0,
          failed: 0,
          capped: false,
        };
    const monthlyCapUsd = setting?.monthlyCapUsd ?? 40;
    return {
      mode: setting?.mode ?? ("off" as const),
      monthlyCapUsd,
      shadowDay: setting?.shadowUntil
        ? Math.max(
            1,
            Math.min(
              14,
              Math.floor(
                (now - (setting.shadowUntil - SHADOW_MS)) / 86400_000,
              ) + 1,
            ),
          )
        : 0,
      readyToOpen:
        setting?.mode === "shadow" &&
        setting.shadowUntil !== undefined &&
        now >= setting.shadowUntil,
      month,
      paused: visible && month.costUsd >= monthlyCapUsd,
      resetsAt: monthRange(now).end,
      canManage: hasPermission(me.role, "second-opinion:manage"),
      visible,
    };
  },
});
export const forMeeting = query({
  args: { meetingId: v.id("meetings") },
  returns: v.union(v.null(), viewValidator),
  handler: async (ctx, args) => {
    const me = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
      "closer",
    ]);
    const row = await ctx.db
      .query("secondOpinions")
      .withIndex("by_meetingId", (q) => q.eq("meetingId", args.meetingId))
      .order("desc")
      .first();
    return row ? view(ctx, me, row) : null;
  },
});
export const addCloserNote = mutation({
  args: { secondOpinionId: v.id("secondOpinions"), note: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const me = await requireTenantUser(ctx, ["closer"]);
    const row = await ctx.db.get("secondOpinions", args.secondOpinionId);
    if (!row || !(await view(ctx, me, row))?.canAddNote)
      throw rejectRequest(
        "second_opinion.note_denied",
        "You can't add a note to this check.",
      );
    const note = args.note.trim();
    if (!note || note.length > 2000)
      throw rejectRequest(
        "second_opinion.invalid_note",
        "Write a note of 1 to 2,000 characters.",
      );
    await ctx.db.patch("secondOpinions", row._id, {
      closerNote: note,
      closerNoteAt: Date.now(),
    });
    return null;
  },
});
const tabValidator = v.union(
  v.literal("disagrees"),
  v.literal("unsure"),
  v.literal("checked"),
  v.literal("all"),
);
export const listForReview = query({
  args: { tab: tabValidator, paginationOpts: paginationOptsValidator },
  returns: v.object({
    page: v.array(viewValidator),
    isDone: v.boolean(),
    continueCursor: v.string(),
    month: summaryValidator,
    visible: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const me = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);
    const tenant = await ctx.db.get("tenants", me.tenantId);
    if (
      !hasPermission(me.role, "second-opinion:review") ||
      !tenant ||
      !maySee(me, tenant)
    )
      return {
        page: [],
        isDone: true,
        continueCursor: "",
        month: {
          costUsd: 0,
          total: 0,
          agrees: 0,
          hints: 0,
          disagrees: 0,
          unsure: 0,
          checked: 0,
          answered: 0,
          failed: 0,
          capped: false,
        },
        visible: false,
      };
    const query =
      args.tab === "disagrees" || args.tab === "checked"
        ? ctx.db
            .query("secondOpinions")
            .withIndex("by_tenantId_and_reviewState_and_createdAt", (q) =>
              q
                .eq("tenantId", me.tenantId)
                .eq("reviewState", args.tab === "checked" ? "checked" : "open"),
            )
        : args.tab === "unsure"
          ? ctx.db
              .query("secondOpinions")
              .withIndex("by_tenantId_and_verdict_and_createdAt", (q) =>
                q.eq("tenantId", me.tenantId).eq("verdict", "unsure"),
              )
          : ctx.db
              .query("secondOpinions")
              .withIndex("by_tenantId_and_createdAt", (q) =>
                q.eq("tenantId", me.tenantId),
              );
    const result = await query.order("desc").paginate({
      ...args.paginationOpts,
      numItems: Math.min(25, Math.max(1, args.paginationOpts.numItems)),
      maximumBytesRead: 300_000,
    });
    // A check a rerun replaced leaves the lists; its replacement shows instead.
    const views = await Promise.all(
      result.page
        .filter((row) => row.supersededById === undefined)
        .map((row) => view(ctx, me, row)),
    );
    return {
      isDone: result.isDone,
      continueCursor: result.continueCursor,
      page: views.filter((row) => row !== null),
      month: await monthSummary(ctx, me.tenantId, Date.now()),
      visible: true,
    };
  },
});
export const getForReview = query({
  args: { secondOpinionId: v.id("secondOpinions") },
  returns: v.union(v.null(), viewValidator),
  handler: async (ctx, args) => {
    const me = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);
    if (!hasPermission(me.role, "second-opinion:review")) return null;
    const row = await ctx.db.get("secondOpinions", args.secondOpinionId);
    return row ? view(ctx, me, row) : null;
  },
});
export type SecondOpinionCheckArgs = {
  secondOpinionId: Id<"secondOpinions">;
  outcome: "closer_right" | "second_opinion_right";
  reopen?: { date: string; time: string };
};

/**
 * Every check `check` makes, in its order, with no write: the review is open
 * to this admin, and a reopen names a no-show and a real call-back time.
 */
async function checkSecondOpinionCheck(
  ctx: QueryCtx | MutationCtx,
  me: CoreActor,
  args: SecondOpinionCheckArgs,
) {
  assertCoreRole(me, ["tenant_master", "tenant_admin"]);
  const row = await ctx.db.get("secondOpinions", args.secondOpinionId);
  const detail = row ? await view(ctx, me, row) : null;
  if (!row || !detail?.canReview || row.reviewState !== "open")
    throw rejectRequest(
      "second_opinion.review_denied",
      "This disagreement isn't open for review.",
    );
  if (!args.reopen) return { row, reopen: null };
  if (args.outcome !== "second_opinion_right" || !detail.canReopen)
    throw rejectRequest(
      "second_opinion.reopen_invalid",
      "Only a no-show can be reopened from this check.",
    );
  const meeting = await ctx.db.get("meetings", row.meetingId);
  if (!meeting)
    throw rejectRequest(
      "second_opinion.meeting_missing",
      "The meeting no longer exists.",
    );
  const closer = await ctx.db.get("users", meeting.assignedCloserId);
  const tenant = await ctx.db.get("tenants", me.tenantId);
  let scheduledAt: number;
  try {
    scheduledAt = parseLocalDateTime(
      args.reopen.date,
      args.reopen.time,
      closer?.timezone ??
        tenant?.businessDay?.timeZone ??
        "America/Tegucigalpa",
    );
  } catch {
    throw rejectRequest(
      "second_opinion.callback_invalid",
      "Choose a real date and time in the closer's time zone.",
    );
  }
  return { row, reopen: { meeting, scheduledAt } };
}

/**
 * Whether `secondOpinionCheckCore` would record this review, without
 * writing. A reopen's call-back time is checked here only for being a real
 * time; that it is in the future is checked when it is written.
 */
export async function checkSecondOpinionCheckAllowed(
  ctx: QueryCtx | MutationCtx,
  actor: CoreActor,
  args: SecondOpinionCheckArgs,
): Promise<
  CheckResult<{
    secondOpinionId: Id<"secondOpinions">;
    meetingId: Id<"meetings">;
    reopen: { opportunityId: Id<"opportunities">; scheduledAt: number } | null;
  }>
> {
  return await toCheckResult(async () => {
    const { row, reopen } = await checkSecondOpinionCheck(ctx, actor, args);
    return {
      secondOpinionId: row._id,
      meetingId: row.meetingId,
      reopen: reopen
        ? { opportunityId: reopen.meeting.opportunityId, scheduledAt: reopen.scheduledAt }
        : null,
    };
  });
}

/**
 * Records an admin's review of an open disagreement, and reopens a no-show
 * deal with a call-back when asked: the core of `check`. It emits
 * `second_opinion.checked` on the meeting, with the outcome, whether it
 * reopened, and the provenance.
 */
export async function secondOpinionCheckCore(
  ctx: MutationCtx,
  me: CoreActor,
  args: SecondOpinionCheckArgs,
  provenance: Provenance,
): Promise<null> {
  const { row, reopen } = await checkSecondOpinionCheck(ctx, me, args);
  if (reopen) {
    await adminCreateFollowUpCore(
      ctx,
      me,
      {
        opportunityId: reopen.meeting.opportunityId,
        meetingId: reopen.meeting._id,
        callBack: { scheduledAt: reopen.scheduledAt },
      },
      provenance,
    );
  }
  const at = Date.now();
  await ctx.db.patch("secondOpinions", row._id, {
    reviewState: "checked",
    review: {
      outcome: args.outcome,
      byUserId: me.userId,
      at,
      reopened: Boolean(args.reopen),
    },
  });
  await emitDomainEvent(ctx, {
    tenantId: me.tenantId,
    entityType: "meeting",
    entityId: row.meetingId,
    eventType: "second_opinion.checked",
    source: "admin",
    actorUserId: me.userId,
    metadata: {
      secondOpinionId: row._id,
      outcome: args.outcome,
      reopened: Boolean(args.reopen),
      ...provenanceMetadata(provenance),
    },
    occurredAt: at,
  });
  return null;
}

export const check = mutation({
  args: {
    secondOpinionId: v.id("secondOpinions"),
    outcome: reviewOutcome,
    reopen: v.optional(v.object({ date: v.string(), time: v.string() })),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const me = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);
    return await secondOpinionCheckCore(ctx, me, args, WEB);
  },
});

/**
 * Runs Jev again on a meeting's latest check, for an owner or admin who
 * works the review queue: after a tuning change, or when a check was
 * skipped or failed. The new check replaces the old one, which keeps its
 * review but leaves the queue. It costs one more check against the cap.
 */
export const rerun = mutation({
  args: { secondOpinionId: v.id("secondOpinions") },
  returns: v.id("secondOpinions"),
  handler: async (ctx, args) => {
    const me = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);
    const tenant = await ctx.db.get("tenants", me.tenantId);
    const previous = await ctx.db.get("secondOpinions", args.secondOpinionId);
    if (
      !hasPermission(me.role, "second-opinion:review") ||
      !tenant ||
      !maySee(me, tenant) ||
      !previous ||
      previous.tenantId !== me.tenantId
    )
      throw rejectRequest(
        "second_opinion.rerun_denied",
        "This check can't be run again.",
      );
    const latest = await ctx.db
      .query("secondOpinions")
      .withIndex("by_meetingId", (q) => q.eq("meetingId", previous.meetingId))
      .order("desc")
      .first();
    if (latest?._id !== previous._id || previous.supersededById !== undefined)
      throw rejectRequest(
        "second_opinion.rerun_stale",
        "A newer check of this call exists. Open that one.",
      );
    if (previous.status === "queued")
      throw rejectRequest(
        "second_opinion.rerun_running",
        "Jev is still checking this call.",
      );
    const id = await queueRerun(ctx, { previous, requestedByUserId: me.userId });
    if (!id)
      throw rejectRequest(
        "second_opinion.rerun_unavailable",
        "There's nothing to check: the recording is gone, or the call has no result and its day isn't over.",
      );
    log.info("second_opinion.rerun", {
      tenantId: me.tenantId,
      actorUserId: me.userId,
      secondOpinionId: id,
      rerunOf: previous._id,
    });
    return id;
  },
});
