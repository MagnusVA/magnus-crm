import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { validateTransition } from "../lib/statusTransitions";
import { completeMeetingForOutcome } from "../lib/meetingOutcomeCompletion";
import {
  assertCanRecordLegacyMeetingOutcome,
  assertCanRecordMeetingOutcome,
} from "../lib/outcomeEligibility";
import { emitDomainEvent } from "../lib/domainEvents";
import { patchOpportunityLifecycle } from "../lib/opportunityActivity";
import {
  updateTenantStats,
  isActiveOpportunityStatus,
} from "../lib/tenantStatsHelper";

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
      const handledAsLegacy = assertCanRecordLegacyMeetingOutcome({
        meeting,
        opportunity,
        userId,
        role,
      });
      if (!handledAsLegacy) {
        assertCanRecordMeetingOutcome({
          meeting,
          opportunity,
          userId,
          role,
          now,
        });
      }
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
      const handledAsLegacy = assertCanRecordLegacyMeetingOutcome({
        meeting,
        opportunity,
        userId,
        role,
      });
      if (!handledAsLegacy) {
        assertCanRecordMeetingOutcome({
          meeting,
          opportunity,
          userId,
          role,
          now,
        });
      }
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
    contactMethod: v.union(v.literal("call"), v.literal("text")),
    reminderScheduledAt: v.number(),
    reminderNote: v.optional(v.string()),
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
        `Cannot create reminder from status "${opportunity.status}"`,
      );
    }

    const now = Date.now();
    if (args.reminderScheduledAt <= now) {
      throw new Error("Reminder must be scheduled in the future");
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
      followUpId,
    });

    return { followUpId };
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

// Temporary defensive stub for stale admin clients during the Phase 2/3 deploy
// window. Manual timing resolution has been removed.
export const adminResolveMeeting = mutation({
  args: {
    meetingId: v.id("meetings"),
    startedAt: v.number(),
    stoppedAt: v.number(),
  },
  handler: async () => {
    throw new Error(
      "Manual meeting timing resolution has been removed. Record the meeting outcome directly.",
    );
  },
});
