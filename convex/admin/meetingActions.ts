import { v, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, type MutationCtx, type QueryCtx } from "../_generated/server";
import type { TenantUserResult } from "../requireTenantUser";
import { rejectRequest } from "../lib/observability/errors";
import { requireTenantUser } from "../requireTenantUser";
import {
  awaitsCallResult,
  canMarkLost,
  canSendRescheduleLink,
  describeDealState,
  loadDealTasks,
} from "../opportunities/dealGuards";
import {
  assertCoreRole,
  provenanceMetadata,
  toCheckResult,
  WEB,
  type CheckResult,
  type CoreActor,
  type Provenance,
} from "../lib/outcomeCores";
import { completeMeetingForOutcome } from "../lib/meetingOutcomeCompletion";
import { assertCanRecordMeetingOutcome } from "../lib/outcomeEligibility";
import { emitDomainEvent } from "../lib/domainEvents";
import { expireUnfinishedFollowUp } from "../lib/activeFollowUp";
import { landFollowUp, resolveFollowUpStart } from "../lib/followUpStart";
import { missedMeetingLoss, transitionOpportunity } from "../lib/opportunityActivity";

const noShowReasonValidator = v.union(
  v.literal("no_response"),
  v.literal("late_cancel"),
  v.literal("technical_issues"),
  v.literal("other"),
);

function normalizeOptionalString(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

const ADMIN_ROLES = ["tenant_master", "tenant_admin"] as const;

/**
 * The meeting named with a deal must be on it. Shared by the checks that
 * take an optional meeting.
 */
async function loadDealAndMeeting(
  ctx: QueryCtx | MutationCtx,
  tenantId: Id<"tenants">,
  args: { opportunityId: Id<"opportunities">; meetingId?: Id<"meetings"> },
) {
  const opportunity = await ctx.db.get("opportunities", args.opportunityId);
  if (!opportunity || opportunity.tenantId !== tenantId) {
    throw new Error("Opportunity not found");
  }
  const meeting = args.meetingId ? await ctx.db.get("meetings", args.meetingId) : null;
  if (
    args.meetingId &&
    (!meeting ||
      meeting.tenantId !== tenantId ||
      meeting.opportunityId !== args.opportunityId)
  ) {
    throw new Error("Meeting does not belong to this opportunity");
  }
  return { opportunity, meeting };
}

// ---------------------------------------------------------------------------
// adminMarkAsLost — Mark opportunity as lost on behalf of closer
// ---------------------------------------------------------------------------

export type AdminMarkLostArgs = {
  opportunityId: Id<"opportunities">;
  meetingId?: Id<"meetings">;
  reason?: string;
};

/** Every check `adminMarkAsLost` makes, in its order, with no write. */
async function checkAdminMarkLost(
  ctx: QueryCtx | MutationCtx,
  actor: CoreActor,
  args: AdminMarkLostArgs,
) {
  assertCoreRole(actor, ADMIN_ROLES);
  const { tenantId, userId, role } = actor;
  const { opportunity, meeting } = await loadDealAndMeeting(ctx, tenantId, args);

  const now = Date.now();
  if (meeting) {
    assertCanRecordMeetingOutcome({
      meeting,
      opportunity,
      userId,
      role,
      now,
    });
  }

  if (!canMarkLost(opportunity, await loadDealTasks(ctx, opportunity._id))) {
    throw new Error(
      `Cannot mark as lost: the deal is "${describeDealState(opportunity)}"`,
    );
  }
  return { opportunity, meeting, now };
}

/** Whether `adminMarkLostCore` would close this deal lost, without writing. */
export async function checkAdminMarkLostAllowed(
  ctx: QueryCtx | MutationCtx,
  actor: CoreActor,
  args: AdminMarkLostArgs,
): Promise<
  CheckResult<{
    opportunityId: Id<"opportunities">;
    meetingId?: Id<"meetings">;
    leadId: Id<"leads">;
    dealState: string;
  }>
> {
  return await toCheckResult(async () => {
    const { opportunity, meeting } = await checkAdminMarkLost(ctx, actor, args);
    return {
      opportunityId: opportunity._id,
      ...(meeting ? { meetingId: meeting._id } : {}),
      leadId: opportunity.leadId,
      dealState: describeDealState(opportunity),
    };
  });
}

/**
 * Closes a deal lost on a closer's behalf: the core of `adminMarkAsLost`.
 * `provenance` tags the deal's `opportunity.stage_changed` event.
 */
export async function adminMarkLostCore(
  ctx: MutationCtx,
  actor: CoreActor,
  args: AdminMarkLostArgs,
  provenance: Provenance,
): Promise<void> {
  const { userId } = actor;
  const { opportunity, meeting, now } = await checkAdminMarkLost(ctx, actor, args);
  const reason = args.reason?.trim() || undefined;

  // Qualified, Booked, Call held or Follow-up -> Closed lost, by a person.
  await transitionOpportunity(ctx, args.opportunityId, {
    to: { stage: "closed", outcome: "lost" },
    fields: {
      updatedAt: now,
      lostAt: now,
      lostByUserId: userId,
      lostReason: reason,
    },
    source: "admin",
    actorUserId: userId,
    reason,
    metadata: provenanceMetadata(provenance),
  });
  if (meeting) {
    await completeMeetingForOutcome(ctx, {
      meetingId: meeting._id,
      opportunityId: opportunity._id,
      toMeetingStatus: "held",
      recordedAt: now,
    });
  }
}

export const adminMarkAsLost = mutation({
  args: {
    opportunityId: v.id("opportunities"),
    meetingId: v.optional(v.id("meetings")),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const actor = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);
    await adminMarkLostCore(ctx, actor, args, WEB);
  },
});

// ---------------------------------------------------------------------------
// adminCreateFollowUp — Create scheduling link follow-up using closer's Calendly
// ---------------------------------------------------------------------------

/**
 * The admin twin of `createSchedulingLinkFollowUp`: a link on the assigned
 * closer's calendar, and the deal moves to Follow-up at once, with the
 * meeting marked held when the admin records it from the meeting's outcome.
 */
export const adminCreateFollowUp = mutation({
  args: {
    opportunityId: v.id("opportunities"),
    meetingId: v.optional(v.id("meetings")),
  },
  returns: v.object({ schedulingLinkUrl: v.string(), followUpId: v.id("followUps") }),
  handler: async (ctx, args) => {
    const { tenantId, userId, role } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const result = await adminCreateFollowUpCore(ctx, { tenantId, userId, role }, args, WEB);
    return { followUpId: result.followUpId, schedulingLinkUrl: result.schedulingLinkUrl! };
  },
});

/**
 * Shared admin path. A review may request a call-back while preserving
 * attendance. `provenance` tags the `followUp.created` event for an agent.
 */
export async function adminCreateFollowUpCore(
  ctx: MutationCtx,
  actor: Pick<TenantUserResult, "tenantId" | "userId" | "role">,
  args: {
    opportunityId: Id<"opportunities">;
    meetingId?: Id<"meetings">;
    callBack?: { scheduledAt: number };
  },
  provenance: Provenance = WEB,
): Promise<{ followUpId: Id<"followUps">; schedulingLinkUrl: string | null }> {
  const { tenantId, userId, role } = actor;
  const opportunity = await ctx.db.get("opportunities", args.opportunityId);
  if (!opportunity || opportunity.tenantId !== tenantId) {
    throw new Error("Opportunity not found");
  }

  const meeting = args.meetingId
    ? await ctx.db.get("meetings", args.meetingId)
    : null;
  if (
    args.meetingId &&
    (!meeting ||
      meeting.tenantId !== tenantId ||
      meeting.opportunityId !== args.opportunityId)
  ) {
    throw new Error("Meeting does not belong to this opportunity");
  }

  // A second Generate finds the deal at Follow-up with this link open and
  // is refused.
  const start = await resolveFollowUpStart(
    ctx,
    opportunity,
    meeting,
    "Cannot create follow-up",
  );

  if (args.callBack) {
    if (
      !meeting ||
      meeting.status !== "no_show" ||
      opportunity.outcome !== "lost" ||
      opportunity.lostReason !== "no_show"
    )
      throw rejectRequest(
        "second_opinion.reopen_invalid",
        "Only a closed no-show deal can be reopened here.",
      );
    const now = Date.now();
    if (
      !Number.isFinite(args.callBack.scheduledAt) ||
      args.callBack.scheduledAt <= now
    )
      throw rejectRequest(
        "second_opinion.callback_invalid",
        "Choose a future call-back time.",
      );
    const followUpId = await ctx.db.insert("followUps", {
      tenantId,
      opportunityId: opportunity._id,
      leadId: opportunity.leadId,
      closerId: meeting.assignedCloserId,
      type: "manual_reminder",
      reason: "no_show_follow_up",
      status: "pending",
      contactMethod: "call",
      reminderScheduledAt: args.callBack.scheduledAt,
      sourceMeetingId: meeting._id,
      createdAt: now,
      createdByUserId: userId,
      createdSource: "admin",
    });
    await landFollowUp(ctx, opportunity._id, start, {
      source: "admin",
      actorUserId: userId,
      occurredAt: now,
    });
    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "followUp",
      entityId: followUpId,
      eventType: "followUp.created",
      source: "admin",
      actorUserId: userId,
      metadata: {
        type: "manual_reminder",
        contactMethod: "call",
        reason: "no_show_follow_up",
        ...provenanceMetadata(provenance),
      },
      occurredAt: now,
    });
    // Review reopens the deal only. Attendance remains no-show.
    return { followUpId, schedulingLinkUrl: null };
  }

  // Resolve the assigned closer's Calendly URI
  const closerId = opportunity.assignedCloserId;
  if (!closerId) {
    throw new Error("No closer assigned to this opportunity");
  }
  const closer = await ctx.db.get("users", closerId);
  if (!closer || !closer.personalEventTypeUri) {
    throw new Error(
      "Assigned closer has no personal event type URI configured",
    );
  }

  const now = Date.now();
  if (meeting) {
    assertCanRecordMeetingOutcome({
      meeting,
      opportunity,
      userId,
      role,
      now,
    });
  }

  const followUpId = await ctx.db.insert("followUps", {
    tenantId,
    opportunityId: args.opportunityId,
    leadId: opportunity.leadId,
    closerId,
    type: "scheduling_link",
    reason: "admin_initiated",
    status: "pending",
    ...(meeting ? { sourceMeetingId: meeting._id } : {}),
    createdAt: now,
    createdByUserId: userId,
    createdSource: "admin",
  });

  // Build scheduling link URL with UTM params
  const baseUrl = closer.personalEventTypeUri;
  const url = new URL(baseUrl);
  url.searchParams.set("utm_source", "ptdom");
  url.searchParams.set("utm_medium", "follow_up");
  url.searchParams.set("utm_campaign", args.opportunityId);
  url.searchParams.set("utm_content", followUpId);
  url.searchParams.set("utm_term", closerId);
  const schedulingLinkUrl = url.toString();

  await ctx.db.patch("followUps", followUpId, { schedulingLinkUrl });

  await emitDomainEvent(ctx, {
    tenantId,
    entityType: "followUp",
    entityId: followUpId,
    eventType: "followUp.created",
    source: "admin",
    actorUserId: userId,
    metadata: {
      type: "scheduling_link",
      reason: "admin_initiated",
      ...provenanceMetadata(provenance),
    },
    occurredAt: now,
  });

  await landFollowUp(ctx, args.opportunityId, start, {
    source: "admin",
    actorUserId: userId,
    occurredAt: now,
  });
  if (meeting) {
    await completeMeetingForOutcome(ctx, {
      meetingId: meeting._id,
      opportunityId: opportunity._id,
      toMeetingStatus: "held",
      recordedAt: now,
    });
  }

  return { schedulingLinkUrl, followUpId };
}


// ---------------------------------------------------------------------------
// adminCancelPendingFollowUp — Cancel a follow-up that never moved the deal
// ---------------------------------------------------------------------------

export type AdminCancelPendingFollowUpArgs = { followUpId: Id<"followUps"> };

/**
 * Every check `adminCancelPendingFollowUp` makes, in its order, with no
 * write: its own, then the ones `expireUnfinishedFollowUp` makes before it
 * writes.
 */
async function checkAdminCancelPendingFollowUp(
  ctx: QueryCtx | MutationCtx,
  actor: CoreActor,
  args: AdminCancelPendingFollowUpArgs,
) {
  assertCoreRole(actor, ADMIN_ROLES);
  const { tenantId } = actor;
  const followUp = await ctx.db.get("followUps", args.followUpId);
  if (!followUp || followUp.tenantId !== tenantId) {
    throw new Error("Follow-up not found");
  }
  const opportunity = await ctx.db.get("opportunities", followUp.opportunityId);
  if (!opportunity || opportunity.tenantId !== tenantId) {
    throw new Error("Opportunity not found");
  }
  if (followUp.status !== "pending") {
    throw new Error("Follow-up is not pending");
  }
  if (!awaitsCallResult(opportunity)) {
    throw new Error(
      `Only a follow-up on a deal still waiting for its call's result can be canceled; the deal is "${describeDealState(opportunity)}"`,
    );
  }
  return { followUp, opportunity };
}

/** Whether `adminCancelPendingFollowUpCore` would expire it, without writing. */
export async function checkAdminCancelPendingFollowUpAllowed(
  ctx: QueryCtx | MutationCtx,
  actor: CoreActor,
  args: AdminCancelPendingFollowUpArgs,
): Promise<
  CheckResult<{
    followUpId: Id<"followUps">;
    opportunityId: Id<"opportunities">;
    type: Doc<"followUps">["type"];
  }>
> {
  return await toCheckResult(async () => {
    const { followUp, opportunity } = await checkAdminCancelPendingFollowUp(ctx, actor, args);
    return { followUpId: followUp._id, opportunityId: opportunity._id, type: followUp.type };
  });
}

/**
 * Expires a pending follow-up on a deal still waiting for its call's result:
 * the core of `adminCancelPendingFollowUp`. The `followUp.expired` event comes
 * from `expireUnfinishedFollowUp`, which takes no metadata, so an agent's
 * cancel is recorded with its provenance in a log line instead.
 */
export async function adminCancelPendingFollowUpCore(
  ctx: MutationCtx,
  actor: CoreActor,
  args: AdminCancelPendingFollowUpArgs,
  provenance: Provenance,
): Promise<null> {
  const { followUp, opportunity } = await checkAdminCancelPendingFollowUp(ctx, actor, args);
  await expireUnfinishedFollowUp(ctx, {
    followUp,
    opportunity,
    source: "admin",
    actorUserId: actor.userId,
    metadata: provenanceMetadata(provenance),
  });
  return null;
}

/**
 * Cancel a pending scheduling link or manual reminder on any deal in the
 * tenant that still waits for its call's result: the meeting page's fallback
 * for a link left behind before links moved the deal at once. The page hides
 * the outcome buttons while a follow-up is pending; expiring it brings them
 * back.
 */
export const adminCancelPendingFollowUp = mutation({
  args: {
    followUpId: v.id("followUps"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);
    return await adminCancelPendingFollowUpCore(ctx, actor, args, WEB);
  },
});

// ---------------------------------------------------------------------------
// adminCreateManualReminder — Create manual reminder follow-up
// ---------------------------------------------------------------------------

export type AdminManualReminderArgs = {
  opportunityId: Id<"opportunities">;
  meetingId?: Id<"meetings">;
  contactMethod: "call" | "text";
  reminderScheduledAt: number;
  reminderNote?: string;
};

/** Every check `adminCreateManualReminder` makes, in its order, with no write. */
async function checkAdminManualReminder(
  ctx: QueryCtx | MutationCtx,
  actor: CoreActor,
  args: AdminManualReminderArgs,
) {
  assertCoreRole(actor, ADMIN_ROLES);
  const { tenantId, userId, role } = actor;
  const { opportunity, meeting } = await loadDealAndMeeting(ctx, tenantId, args);

  const start = await resolveFollowUpStart(ctx, opportunity, meeting, "Cannot create reminder");

  const now = Date.now();
  if (args.reminderScheduledAt <= now) {
    throw new Error("Reminder must be scheduled in the future");
  }
  if (meeting) {
    assertCanRecordMeetingOutcome({
      meeting,
      opportunity,
      userId,
      role,
      now,
    });
  }

  const closerId = opportunity.assignedCloserId;
  if (!closerId) {
    throw new Error("No closer assigned to this opportunity");
  }
  return { opportunity, meeting, start, now, closerId };
}

/** Whether `adminCreateManualReminderCore` would create it, without writing. */
export async function checkAdminManualReminderAllowed(
  ctx: QueryCtx | MutationCtx,
  actor: CoreActor,
  args: AdminManualReminderArgs,
): Promise<
  CheckResult<{
    opportunityId: Id<"opportunities">;
    meetingId?: Id<"meetings">;
    leadId: Id<"leads">;
    closerId: Id<"users">;
    movesDeal: boolean;
  }>
> {
  return await toCheckResult(async () => {
    const { opportunity, meeting, start, closerId } = await checkAdminManualReminder(ctx, actor, args);
    return {
      opportunityId: opportunity._id,
      ...(meeting ? { meetingId: meeting._id } : {}),
      leadId: opportunity.leadId,
      closerId,
      movesDeal: start === "move",
    };
  });
}

/**
 * Creates a call-back or text-back for the deal's closer: the core of
 * `adminCreateManualReminder`. `provenance` tags the `followUp.created` event.
 */
export async function adminCreateManualReminderCore(
  ctx: MutationCtx,
  actor: CoreActor,
  args: AdminManualReminderArgs,
  provenance: Provenance,
): Promise<{ followUpId: Id<"followUps"> }> {
  const { tenantId, userId } = actor;
  const { opportunity, meeting, start, now, closerId } = await checkAdminManualReminder(
    ctx,
    actor,
    args,
  );

  const followUpId = await ctx.db.insert("followUps", {
    tenantId,
    opportunityId: args.opportunityId,
    leadId: opportunity.leadId,
    closerId,
    type: "manual_reminder",
    reason: "admin_initiated",
    status: "pending",
    contactMethod: args.contactMethod,
    reminderScheduledAt: args.reminderScheduledAt,
    reminderNote: args.reminderNote,
    ...(meeting ? { sourceMeetingId: meeting._id } : {}),
    createdAt: now,
    createdByUserId: userId,
    createdSource: "admin",
  });

  await landFollowUp(ctx, args.opportunityId, start, {
    source: "admin",
    actorUserId: userId,
    occurredAt: now,
  });
  if (meeting) {
    await completeMeetingForOutcome(ctx, {
      meetingId: meeting._id,
      opportunityId: opportunity._id,
      toMeetingStatus: "held",
      recordedAt: now,
    });
  }

  await emitDomainEvent(ctx, {
    tenantId,
    entityType: "followUp",
    entityId: followUpId,
    eventType: "followUp.created",
    source: "admin",
    actorUserId: userId,
    metadata: {
      type: "manual_reminder",
      contactMethod: args.contactMethod,
      reason: "admin_initiated",
      ...provenanceMetadata(provenance),
    },
  });

  return { followUpId };
}

export const adminCreateManualReminder = mutation({
  args: {
    opportunityId: v.id("opportunities"),
    meetingId: v.optional(v.id("meetings")),
    contactMethod: v.union(v.literal("call"), v.literal("text")),
    reminderScheduledAt: v.number(),
    reminderNote: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const actor = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);
    return await adminCreateManualReminderCore(ctx, actor, args, WEB);
  },
});

// ---------------------------------------------------------------------------
// adminMarkNoShow — Mark scheduled meeting no-show on behalf of a closer
// ---------------------------------------------------------------------------

export type AdminMarkNoShowArgs = {
  meetingId: Id<"meetings">;
  reason: Infer<typeof noShowReasonValidator>;
  note?: string;
};

/** Every check `adminMarkNoShow` makes, in its order, with no write. */
async function checkAdminMarkNoShow(
  ctx: QueryCtx | MutationCtx,
  actor: CoreActor,
  args: AdminMarkNoShowArgs,
) {
  assertCoreRole(actor, ADMIN_ROLES);
  const { tenantId, userId, role } = actor;
  const meeting = await ctx.db.get("meetings", args.meetingId);
  if (!meeting || meeting.tenantId !== tenantId) {
    throw new Error("Meeting not found");
  }

  const opportunity = await ctx.db.get("opportunities", meeting.opportunityId);
  if (!opportunity || opportunity.tenantId !== tenantId) {
    throw new Error("Opportunity not found");
  }

  const now = Date.now();
  // A deal awaiting its call's result, which a no-show always closes.
  assertCanRecordMeetingOutcome({
    meeting,
    opportunity,
    userId,
    role,
    now,
  });
  return { meeting, opportunity, now };
}

/** Whether `adminMarkNoShowCore` would mark this meeting, without writing. */
export async function checkAdminMarkNoShowAllowed(
  ctx: QueryCtx | MutationCtx,
  actor: CoreActor,
  args: AdminMarkNoShowArgs,
): Promise<
  CheckResult<{
    meetingId: Id<"meetings">;
    opportunityId: Id<"opportunities">;
    leadId: Id<"leads">;
    scheduledAt: number;
  }>
> {
  return await toCheckResult(async () => {
    const { meeting, opportunity } = await checkAdminMarkNoShow(ctx, actor, args);
    return {
      meetingId: meeting._id,
      opportunityId: opportunity._id,
      leadId: opportunity.leadId,
      scheduledAt: meeting.scheduledAt,
    };
  });
}

/**
 * Marks a scheduled meeting no-show on a closer's behalf and closes its deal
 * lost: the core of `adminMarkNoShow`. `provenance` tags the
 * `meeting.no_show` event, as the closer's `recordNoShow` does.
 */
export async function adminMarkNoShowCore(
  ctx: MutationCtx,
  actor: CoreActor,
  args: AdminMarkNoShowArgs,
  provenance: Provenance,
): Promise<void> {
  const { tenantId, userId } = actor;
  const { meeting, opportunity, now } = await checkAdminMarkNoShow(ctx, actor, args);

  const normalizedNote = normalizeOptionalString(args.note);

  // Booked (or Call held) -> Closed lost: a missed meeting's loss names no person.
  await transitionOpportunity(ctx, opportunity._id, {
    to: { stage: "closed", outcome: "lost" },
    fields: { updatedAt: now, ...missedMeetingLoss("no_show", now) },
    source: "admin",
    actorUserId: userId,
    reason: args.reason,
    occurredAt: now,
  });
  await completeMeetingForOutcome(ctx, {
    meetingId: meeting._id,
    opportunityId: opportunity._id,
    toMeetingStatus: "no_show",
    recordedAt: now,
    extraMeetingPatch: {
      noShowMarkedAt: now,
      noShowReason: args.reason,
      noShowNote: normalizedNote,
      noShowMarkedByUserId: userId,
      noShowSource: "admin_manual",
    } satisfies Partial<Doc<"meetings">>,
  });

  await emitDomainEvent(ctx, {
    tenantId,
    entityType: "meeting",
    entityId: args.meetingId,
    eventType: "meeting.no_show",
    source: "admin",
    actorUserId: userId,
    fromStatus: meeting.status,
    toStatus: "no_show",
    reason: args.reason,
    metadata: {
      noteProvided: Boolean(normalizedNote),
      ...provenanceMetadata(provenance),
    },
    occurredAt: now,
  });
}

export const adminMarkNoShow = mutation({
  args: {
    meetingId: v.id("meetings"),
    reason: noShowReasonValidator,
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const actor = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);
    await adminMarkNoShowCore(ctx, actor, args, WEB);
  },
});

// ---------------------------------------------------------------------------
// adminCreateRescheduleLink — Generate reschedule link for no-show meetings
// ---------------------------------------------------------------------------

export type AdminRescheduleLinkArgs = {
  opportunityId: Id<"opportunities">;
  meetingId: Id<"meetings">;
};

/** Every check `adminCreateRescheduleLink` makes, in its order, with no write. */
async function checkAdminRescheduleLink(
  ctx: QueryCtx | MutationCtx,
  actor: CoreActor,
  args: AdminRescheduleLinkArgs,
) {
  assertCoreRole(actor, ADMIN_ROLES);
  const { tenantId } = actor;
  const opportunity = await ctx.db.get("opportunities", args.opportunityId);
  if (!opportunity || opportunity.tenantId !== tenantId) {
    throw new Error("Opportunity not found");
  }

  if (!canSendRescheduleLink(opportunity)) {
    throw new Error("Can only create reschedule links for no-show opportunities");
  }

  const meeting = await ctx.db.get("meetings", args.meetingId);
  if (
    !meeting ||
    meeting.tenantId !== tenantId ||
    meeting.opportunityId !== args.opportunityId ||
    meeting.status !== "no_show"
  ) {
    throw new Error("Invalid meeting for reschedule");
  }

  // Resolve the assigned closer's Calendly URI
  const closerId = opportunity.assignedCloserId;
  if (!closerId) {
    throw new Error("No closer assigned to this opportunity");
  }
  const closer = await ctx.db.get("users", closerId);
  if (!closer || !closer.personalEventTypeUri) {
    throw new Error(
      "Assigned closer has no personal event type URI configured",
    );
  }
  return { opportunity, meeting, closerId, personalEventTypeUri: closer.personalEventTypeUri };
}

/** Whether `adminCreateRescheduleLinkCore` would create a link, without writing. */
export async function checkAdminRescheduleLinkAllowed(
  ctx: QueryCtx | MutationCtx,
  actor: CoreActor,
  args: AdminRescheduleLinkArgs,
): Promise<
  CheckResult<{
    opportunityId: Id<"opportunities">;
    meetingId: Id<"meetings">;
    leadId: Id<"leads">;
    closerId: Id<"users">;
  }>
> {
  return await toCheckResult(async () => {
    const { opportunity, meeting, closerId } = await checkAdminRescheduleLink(ctx, actor, args);
    return {
      opportunityId: opportunity._id,
      meetingId: meeting._id,
      leadId: opportunity.leadId,
      closerId,
    };
  });
}

/**
 * Creates a reschedule link for a no-show and reopens the deal at Follow-up:
 * the core of `adminCreateRescheduleLink`. `provenance` tags the
 * `followUp.created` event.
 */
export async function adminCreateRescheduleLinkCore(
  ctx: MutationCtx,
  actor: CoreActor,
  args: AdminRescheduleLinkArgs,
  provenance: Provenance,
): Promise<{ schedulingLinkUrl: string; followUpId: Id<"followUps"> }> {
  const { tenantId, userId } = actor;
  const { opportunity, closerId, personalEventTypeUri } = await checkAdminRescheduleLink(
    ctx,
    actor,
    args,
  );

  const now = Date.now();

  // Build scheduling link URL with no-show-specific UTM params
  const url = new URL(personalEventTypeUri);
  url.searchParams.set("utm_source", "ptdom");
  url.searchParams.set("utm_medium", "noshow_resched");
  url.searchParams.set("utm_campaign", args.opportunityId);
  url.searchParams.set("utm_content", args.meetingId);
  url.searchParams.set("utm_term", closerId);
  const schedulingLinkUrl = url.toString();

  const followUpId = await ctx.db.insert("followUps", {
    tenantId,
    opportunityId: args.opportunityId,
    leadId: opportunity.leadId,
    closerId,
    type: "scheduling_link",
    reason: "no_show_follow_up",
    status: "pending",
    schedulingLinkUrl,
    sourceMeetingId: args.meetingId,
    createdAt: now,
    createdByUserId: userId,
    createdSource: "admin",
  });

  // Closed lost (no-show) -> Follow-up, after the link: the status reads it
  // as `reschedule_link_sent`.
  await transitionOpportunity(ctx, args.opportunityId, {
    to: { stage: "follow_up" },
    fields: { updatedAt: now },
    exception: "missed_meeting_next_step",
    source: "admin",
    actorUserId: userId,
  });

  await emitDomainEvent(ctx, {
    tenantId,
    entityType: "followUp",
    entityId: followUpId,
    eventType: "followUp.created",
    source: "admin",
    actorUserId: userId,
    metadata: {
      type: "scheduling_link",
      reason: "no_show_follow_up",
      ...provenanceMetadata(provenance),
    },
  });

  return { schedulingLinkUrl, followUpId };
}

export const adminCreateRescheduleLink = mutation({
  args: {
    opportunityId: v.id("opportunities"),
    meetingId: v.id("meetings"),
  },
  handler: async (ctx, args) => {
    const actor = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);
    return await adminCreateRescheduleLinkCore(ctx, actor, args, WEB);
  },
});
