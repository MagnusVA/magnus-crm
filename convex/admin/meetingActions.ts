import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { mutation } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import {
  canMarkLost,
  canSendRescheduleLink,
  canStartFollowUp,
  describeDealState,
  isFollowUpWithoutRescheduleLink,
  loadDealTasks,
} from "../opportunities/dealGuards";
import { completeMeetingForOutcome } from "../lib/meetingOutcomeCompletion";
import { assertCanRecordMeetingOutcome } from "../lib/outcomeEligibility";
import { emitDomainEvent } from "../lib/domainEvents";
import {
  assertFollowUpStillPending,
  expireUnfinishedFollowUp,
} from "../lib/activeFollowUp";
import { log } from "../lib/observability/log";
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

// ---------------------------------------------------------------------------
// adminMarkAsLost — Mark opportunity as lost on behalf of closer
// ---------------------------------------------------------------------------

export const adminMarkAsLost = mutation({
  args: {
    opportunityId: v.id("opportunities"),
    meetingId: v.optional(v.id("meetings")),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { tenantId, userId, role } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

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
    });
    if (meeting) {
      await completeMeetingForOutcome(ctx, {
        meetingId: meeting._id,
        opportunityId: opportunity._id,
        toMeetingStatus: "held",
        recordedAt: now,
      });
    }
  },
});

// ---------------------------------------------------------------------------
// adminCreateFollowUp — Create scheduling link follow-up using closer's Calendly
// ---------------------------------------------------------------------------

export const adminCreateFollowUp = mutation({
  args: {
    opportunityId: v.id("opportunities"),
  },
  handler: async (ctx, args) => {
    const { tenantId, userId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const opportunity = await ctx.db.get("opportunities", args.opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found");
    }

    if (!canStartFollowUp(opportunity)) {
      throw new Error(
        `Cannot create follow-up: the deal is "${describeDealState(opportunity)}"`,
      );
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
    const followUpId = await ctx.db.insert("followUps", {
      tenantId,
      opportunityId: args.opportunityId,
      leadId: opportunity.leadId,
      closerId,
      type: "scheduling_link",
      reason: "admin_initiated",
      status: "pending",
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

    // Note: status transition is deferred — confirmed via adminConfirmFollowUp
    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "followUp",
      entityId: followUpId,
      eventType: "followUp.created",
      source: "admin",
      actorUserId: userId,
      metadata: { type: "scheduling_link", reason: "admin_initiated" },
    });

    return { schedulingLinkUrl, followUpId };
  },
});

// ---------------------------------------------------------------------------
// adminConfirmFollowUp — Confirm follow-up status transition
// ---------------------------------------------------------------------------

export const adminConfirmFollowUp = mutation({
  args: {
    opportunityId: v.id("opportunities"),
    meetingId: v.optional(v.id("meetings")),
    // The follow-up this confirm was opened for. When given, the confirm is
    // refused once that follow-up is no longer pending.
    followUpId: v.optional(v.id("followUps")),
  },
  handler: async (ctx, args) => {
    const { tenantId, userId, role } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

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

    // Idempotent: already transitioned. A deal waiting on its reschedule link
    // isn't, and the follow-up is refused.
    if (isFollowUpWithoutRescheduleLink(opportunity, await loadDealTasks(ctx, opportunity._id))) {
      log.info("follow_up.confirm_skipped", {
        tenantId,
        actor: "admin",
        opportunityId: args.opportunityId,
        reason: "already_follow_up_scheduled",
      });
      return;
    }

    if (args.followUpId) {
      await assertFollowUpStillPending(ctx, {
        followUpId: args.followUpId,
        tenantId,
        opportunityId: args.opportunityId,
      });
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

    if (!canStartFollowUp(opportunity)) {
      throw new Error(
        `Cannot move the deal to Follow-up from "${describeDealState(opportunity)}"`,
      );
    }

    // Booked or Call held -> Follow-up, or a missed meeting's Closed lost ->
    // Follow-up, which only the exception allows.
    await transitionOpportunity(ctx, args.opportunityId, {
      to: { stage: "follow_up" },
      fields: { updatedAt: now },
      exception: "missed_meeting_next_step",
      source: "admin",
      actorUserId: userId,
    });
    if (meeting) {
      await completeMeetingForOutcome(ctx, {
        meetingId: meeting._id,
        opportunityId: opportunity._id,
        toMeetingStatus: "held",
        recordedAt: now,
      });
    }
  },
});

// ---------------------------------------------------------------------------
// adminCancelPendingFollowUp — Cancel a follow-up that never moved the deal
// ---------------------------------------------------------------------------

/**
 * Cancel a pending scheduling link or manual reminder on any deal in the
 * tenant that still waits for its call's result. The meeting page hides the
 * outcome buttons while a follow-up is pending; expiring it brings them back.
 */
export const adminCancelPendingFollowUp = mutation({
  args: {
    followUpId: v.id("followUps"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { tenantId, userId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const followUp = await ctx.db.get("followUps", args.followUpId);
    if (!followUp || followUp.tenantId !== tenantId) {
      throw new Error("Follow-up not found");
    }
    const opportunity = await ctx.db.get("opportunities", followUp.opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found");
    }

    await expireUnfinishedFollowUp(ctx, {
      followUp,
      opportunity,
      source: "admin",
      actorUserId: userId,
    });
    return null;
  },
});

// ---------------------------------------------------------------------------
// adminCreateManualReminder — Create manual reminder follow-up
// ---------------------------------------------------------------------------

export const adminCreateManualReminder = mutation({
  args: {
    opportunityId: v.id("opportunities"),
    meetingId: v.optional(v.id("meetings")),
    contactMethod: v.union(v.literal("call"), v.literal("text")),
    reminderScheduledAt: v.number(),
    reminderNote: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { tenantId, userId, role } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

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

    if (!canStartFollowUp(opportunity)) {
      throw new Error(
        `Cannot create reminder: the deal is "${describeDealState(opportunity)}"`,
      );
    }

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
      createdAt: now,
      createdByUserId: userId,
      createdSource: "admin",
    });

    // Booked or Call held -> Follow-up, or a missed meeting's Closed lost ->
    // Follow-up, which only the exception allows.
    await transitionOpportunity(ctx, args.opportunityId, {
      to: { stage: "follow_up" },
      fields: { updatedAt: now },
      exception: "missed_meeting_next_step",
      source: "admin",
      actorUserId: userId,
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
      },
    });

    return { followUpId };
  },
});

// ---------------------------------------------------------------------------
// adminMarkNoShow — Mark scheduled meeting no-show on behalf of a closer
// ---------------------------------------------------------------------------

export const adminMarkNoShow = mutation({
  args: {
    meetingId: v.id("meetings"),
    reason: noShowReasonValidator,
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { tenantId, userId, role } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

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
      metadata: { noteProvided: Boolean(normalizedNote) },
      occurredAt: now,
    });
  },
});

// ---------------------------------------------------------------------------
// adminCreateRescheduleLink — Generate reschedule link for no-show meetings
// ---------------------------------------------------------------------------

export const adminCreateRescheduleLink = mutation({
  args: {
    opportunityId: v.id("opportunities"),
    meetingId: v.id("meetings"),
  },
  handler: async (ctx, args) => {
    const { tenantId, userId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

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

    const now = Date.now();

    // Build scheduling link URL with no-show-specific UTM params
    const url = new URL(closer.personalEventTypeUri);
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
      metadata: { type: "scheduling_link", reason: "no_show_follow_up" },
    });

    return { schedulingLinkUrl, followUpId };
  },
});
