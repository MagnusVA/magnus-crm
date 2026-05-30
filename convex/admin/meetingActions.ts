import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { mutation } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { validateTransition } from "../lib/statusTransitions";
import { completeMeetingForOutcome } from "../lib/meetingOutcomeCompletion";
import { assertCanRecordMeetingOutcome } from "../lib/outcomeEligibility";
import { emitDomainEvent } from "../lib/domainEvents";
import { patchOpportunityLifecycle } from "../lib/opportunityActivity";
import {
  updateTenantStats,
  isActiveOpportunityStatus,
} from "../lib/tenantStatsHelper";

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

    const opportunity = await ctx.db.get(args.opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found");
    }

    const meeting = args.meetingId ? await ctx.db.get(args.meetingId) : null;
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

    if (!validateTransition(opportunity.status, "lost")) {
      throw new Error(
        `Cannot mark as lost from status "${opportunity.status}"`,
      );
    }

    const reason = args.reason?.trim() || undefined;
    const wasActive = isActiveOpportunityStatus(opportunity.status);

    await patchOpportunityLifecycle(ctx, args.opportunityId, {
      status: "lost",
      updatedAt: now,
      lostAt: now,
      lostByUserId: userId,
      lostReason: reason,
    });
    if (meeting) {
      await completeMeetingForOutcome(ctx, {
        meeting,
        opportunity,
        toMeetingStatus: "completed",
        completedAt: now,
      });
    }

    await updateTenantStats(ctx, tenantId, {
      ...(wasActive ? { activeOpportunities: -1 } : {}),
      lostDeals: 1,
    });

    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "opportunity",
      entityId: args.opportunityId,
      eventType: "opportunity.marked_lost",
      source: "admin",
      actorUserId: userId,
      fromStatus: opportunity.status,
      toStatus: "lost",
      reason,
    });

    console.log("[Admin] adminMarkAsLost completed", {
      opportunityId: args.opportunityId,
    });
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

    const opportunity = await ctx.db.get(args.opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found");
    }

    if (!validateTransition(opportunity.status, "follow_up_scheduled")) {
      throw new Error(
        `Cannot create follow-up from status "${opportunity.status}"`,
      );
    }

    // Resolve the assigned closer's Calendly URI
    const closerId = opportunity.assignedCloserId;
    if (!closerId) {
      throw new Error("No closer assigned to this opportunity");
    }
    const closer = await ctx.db.get(closerId);
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

    await ctx.db.patch(followUpId, { schedulingLinkUrl });

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

    console.log("[Admin] adminCreateFollowUp completed", {
      opportunityId: args.opportunityId,
      followUpId,
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
  },
  handler: async (ctx, args) => {
    const { tenantId, userId, role } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const opportunity = await ctx.db.get(args.opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found");
    }

    const meeting = args.meetingId ? await ctx.db.get(args.meetingId) : null;
    if (
      args.meetingId &&
      (!meeting ||
        meeting.tenantId !== tenantId ||
        meeting.opportunityId !== args.opportunityId)
    ) {
      throw new Error("Meeting does not belong to this opportunity");
    }

    // Idempotent: already transitioned
    if (opportunity.status === "follow_up_scheduled") {
      return;
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

    if (!validateTransition(opportunity.status, "follow_up_scheduled")) {
      throw new Error(
        `Cannot transition to follow_up_scheduled from "${opportunity.status}"`,
      );
    }

    const wasActive = isActiveOpportunityStatus(opportunity.status);

    await patchOpportunityLifecycle(ctx, args.opportunityId, {
      status: "follow_up_scheduled",
      updatedAt: now,
    });
    if (meeting) {
      await completeMeetingForOutcome(ctx, {
        meeting,
        opportunity,
        toMeetingStatus: "completed",
        completedAt: now,
      });
    }

    await updateTenantStats(ctx, tenantId, {
      ...(!wasActive ? { activeOpportunities: 1 } : {}),
    });

    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "opportunity",
      entityId: args.opportunityId,
      eventType: "opportunity.status_changed",
      source: "admin",
      actorUserId: userId,
      fromStatus: opportunity.status,
      toStatus: "follow_up_scheduled",
    });

    console.log("[Admin] adminConfirmFollowUp completed", {
      opportunityId: args.opportunityId,
    });
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

    const opportunity = await ctx.db.get(args.opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found");
    }
    const meeting = args.meetingId ? await ctx.db.get(args.meetingId) : null;
    if (
      args.meetingId &&
      (!meeting ||
        meeting.tenantId !== tenantId ||
        meeting.opportunityId !== args.opportunityId)
    ) {
      throw new Error("Meeting does not belong to this opportunity");
    }

    if (!validateTransition(opportunity.status, "follow_up_scheduled")) {
      throw new Error(
        `Cannot create reminder from status "${opportunity.status}"`,
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

    const wasActive = isActiveOpportunityStatus(opportunity.status);

    await patchOpportunityLifecycle(ctx, args.opportunityId, {
      status: "follow_up_scheduled",
      updatedAt: now,
    });
    if (meeting) {
      await completeMeetingForOutcome(ctx, {
        meeting,
        opportunity,
        toMeetingStatus: "completed",
        completedAt: now,
      });
    }

    await updateTenantStats(ctx, tenantId, {
      ...(!wasActive ? { activeOpportunities: 1 } : {}),
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
        contactMethod: args.contactMethod,
        reason: "admin_initiated",
      },
    });

    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "opportunity",
      entityId: args.opportunityId,
      eventType: "opportunity.status_changed",
      source: "admin",
      actorUserId: userId,
      fromStatus: opportunity.status,
      toStatus: "follow_up_scheduled",
    });

    console.log("[Admin] adminCreateManualReminder completed", {
      opportunityId: args.opportunityId,
      meetingId: args.meetingId,
      followUpId,
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

    const meeting = await ctx.db.get(args.meetingId);
    if (!meeting || meeting.tenantId !== tenantId) {
      throw new Error("Meeting not found");
    }

    const opportunity = await ctx.db.get(meeting.opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found");
    }

    const now = Date.now();
    assertCanRecordMeetingOutcome({
      meeting,
      opportunity,
      userId,
      role,
      now,
    });
    if (!validateTransition(opportunity.status, "no_show")) {
      throw new Error(
        `Cannot transition opportunity from "${opportunity.status}" to "no_show"`,
      );
    }

    const normalizedNote = normalizeOptionalString(args.note);
    const wasActive = isActiveOpportunityStatus(opportunity.status);

    await patchOpportunityLifecycle(ctx, opportunity._id, {
      status: "no_show",
      noShowAt: now,
      updatedAt: now,
    });
    await completeMeetingForOutcome(ctx, {
      meeting,
      opportunity,
      toMeetingStatus: "no_show",
      completedAt: now,
      extraMeetingPatch: {
        noShowMarkedAt: now,
        noShowReason: args.reason,
        noShowNote: normalizedNote,
        noShowMarkedByUserId: userId,
        noShowSource: "admin_manual",
      } satisfies Partial<Doc<"meetings">>,
    });

    await updateTenantStats(ctx, tenantId, {
      ...(wasActive ? { activeOpportunities: -1 } : {}),
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
      metadata: { note: normalizedNote },
      occurredAt: now,
    });
    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "opportunity",
      entityId: opportunity._id,
      eventType: "opportunity.status_changed",
      source: "admin",
      actorUserId: userId,
      fromStatus: opportunity.status,
      toStatus: "no_show",
      reason: args.reason,
      occurredAt: now,
    });

    console.log("[Admin] adminMarkNoShow completed", {
      meetingId: args.meetingId,
      opportunityId: opportunity._id,
      reason: args.reason,
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

    const opportunity = await ctx.db.get(args.opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found");
    }

    if (opportunity.status !== "no_show") {
      throw new Error("Can only create reschedule links for no-show opportunities");
    }

    if (!validateTransition(opportunity.status, "reschedule_link_sent")) {
      throw new Error(
        `Cannot transition to reschedule_link_sent from "${opportunity.status}"`,
      );
    }

    const meeting = await ctx.db.get(args.meetingId);
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
    const closer = await ctx.db.get(closerId);
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

    const wasActive = isActiveOpportunityStatus(opportunity.status);

    await patchOpportunityLifecycle(ctx, args.opportunityId, {
      status: "reschedule_link_sent",
      updatedAt: now,
    });

    await updateTenantStats(ctx, tenantId, {
      ...(!wasActive ? { activeOpportunities: 1 } : {}),
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

    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "opportunity",
      entityId: args.opportunityId,
      eventType: "opportunity.status_changed",
      source: "admin",
      actorUserId: userId,
      fromStatus: "no_show",
      toStatus: "reschedule_link_sent",
    });

    console.log("[Admin] adminCreateRescheduleLink completed", {
      opportunityId: args.opportunityId,
      meetingId: args.meetingId,
      followUpId,
    });

    return { schedulingLinkUrl, followUpId };
  },
});
