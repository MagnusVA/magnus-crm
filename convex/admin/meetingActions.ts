import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { validateTransition } from "../lib/statusTransitions";
import { emitDomainEvent } from "../lib/domainEvents";
import {
  updateTenantStats,
  isActiveOpportunityStatus,
} from "../lib/tenantStatsHelper";
import {
  replaceOpportunityAggregate,
  replaceMeetingAggregate,
} from "../reporting/writeHooks";
import { updateOpportunityMeetingRefs } from "../lib/opportunityMeetingRefs";

// ---------------------------------------------------------------------------
// adminMarkAsLost — Mark opportunity as lost on behalf of closer
// ---------------------------------------------------------------------------

export const adminMarkAsLost = mutation({
  args: {
    opportunityId: v.id("opportunities"),
    reason: v.optional(v.string()),
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

    if (!validateTransition(opportunity.status, "lost")) {
      throw new Error(
        `Cannot mark as lost from status "${opportunity.status}"`,
      );
    }

    const now = Date.now();
    const reason = args.reason?.trim() || undefined;
    const wasActive = isActiveOpportunityStatus(opportunity.status);

    await ctx.db.patch(args.opportunityId, {
      status: "lost",
      updatedAt: now,
      lostAt: now,
      lostByUserId: userId,
      lostReason: reason,
    });

    await replaceOpportunityAggregate(ctx, opportunity, args.opportunityId);
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
      reason: "closer_initiated",
      status: "pending",
      createdAt: now,
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

    // Idempotent: already transitioned
    if (opportunity.status === "follow_up_scheduled") {
      return;
    }

    if (!validateTransition(opportunity.status, "follow_up_scheduled")) {
      throw new Error(
        `Cannot transition to follow_up_scheduled from "${opportunity.status}"`,
      );
    }

    const now = Date.now();
    const wasActive = isActiveOpportunityStatus(opportunity.status);

    await ctx.db.patch(args.opportunityId, {
      status: "follow_up_scheduled",
      updatedAt: now,
    });

    await replaceOpportunityAggregate(ctx, opportunity, args.opportunityId);
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
      reason: "closer_initiated",
      status: "pending",
      contactMethod: args.contactMethod,
      reminderScheduledAt: args.reminderScheduledAt,
      reminderNote: args.reminderNote,
      createdAt: now,
    });

    const wasActive = isActiveOpportunityStatus(opportunity.status);

    await ctx.db.patch(args.opportunityId, {
      status: "follow_up_scheduled",
      updatedAt: now,
    });

    await replaceOpportunityAggregate(ctx, opportunity, args.opportunityId);
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
      metadata: { type: "manual_reminder", contactMethod: args.contactMethod },
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
    });

    const wasActive = isActiveOpportunityStatus(opportunity.status);

    await ctx.db.patch(args.opportunityId, {
      status: "reschedule_link_sent",
      updatedAt: now,
    });

    await replaceOpportunityAggregate(ctx, opportunity, args.opportunityId);
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

// ---------------------------------------------------------------------------
// adminResolveMeeting — Retroactively resolve a scheduled meeting's timing
// ---------------------------------------------------------------------------
// Quick-patch for the case where a closer didn't start their meeting (e.g.,
// late start, forgot to press the button). The admin sets the actual start/end
// times, which transitions meeting → completed and opportunity → in_progress,
// unlocking outcome actions (Log Payment, Mark Lost, Follow-up).
//
// This bridges the gap until the full Late Start Review System ships.
// ---------------------------------------------------------------------------

export const adminResolveMeeting = mutation({
  args: {
    meetingId: v.id("meetings"),
    startedAt: v.number(), // Unix ms — when the closer actually joined
    stoppedAt: v.number(), // Unix ms — when the meeting actually ended
  },
  handler: async (ctx, args) => {
    const { tenantId, userId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    // Load and validate meeting
    const meeting = await ctx.db.get(args.meetingId);
    if (!meeting || meeting.tenantId !== tenantId) {
      throw new Error("Meeting not found");
    }
    if (meeting.status !== "scheduled") {
      throw new Error(
        `Cannot resolve a meeting with status "${meeting.status}". Only scheduled meetings can be resolved.`,
      );
    }

    // Load and validate opportunity
    const opportunity = await ctx.db.get(meeting.opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found");
    }
    if (!validateTransition(opportunity.status, "in_progress")) {
      throw new Error(
        `Cannot resolve meeting: opportunity status "${opportunity.status}" cannot transition to in_progress.`,
      );
    }

    // Validate timestamps
    if (args.startedAt >= args.stoppedAt) {
      throw new Error("Start time must be before end time");
    }
    if (args.stoppedAt > Date.now() + 60_000) {
      throw new Error("End time cannot be in the future");
    }

    const now = Date.now();
    const scheduledEndMs =
      meeting.scheduledAt + meeting.durationMinutes * 60_000;
    const overranDurationMs = Math.max(0, args.stoppedAt - scheduledEndMs);

    // Transition opportunity: scheduled → in_progress
    const oldOpportunity = opportunity;
    await ctx.db.patch(opportunity._id, {
      status: "in_progress",
      updatedAt: now,
    });
    await replaceOpportunityAggregate(ctx, oldOpportunity, opportunity._id);

    // Transition meeting: scheduled → completed (retroactive — it already happened)
    const oldMeeting = meeting;
    await ctx.db.patch(args.meetingId, {
      status: "completed",
      startedAt: args.startedAt,
      stoppedAt: args.stoppedAt,
      completedAt: args.stoppedAt,
      overranDurationMs,
    });
    await replaceMeetingAggregate(ctx, oldMeeting, args.meetingId);
    await updateOpportunityMeetingRefs(ctx, opportunity._id);

    // Domain events — full audit trail
    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "meeting",
      entityId: args.meetingId,
      eventType: "meeting.admin_resolved",
      source: "admin",
      actorUserId: userId,
      fromStatus: "scheduled",
      toStatus: "completed",
      occurredAt: now,
      metadata: {
        retroactiveStartedAt: args.startedAt,
        retroactiveStoppedAt: args.stoppedAt,
        overranDurationMs,
        resolvedAt: now,
      },
    });
    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "opportunity",
      entityId: opportunity._id,
      eventType: "opportunity.status_changed",
      source: "admin",
      actorUserId: userId,
      fromStatus: opportunity.status,
      toStatus: "in_progress",
      occurredAt: now,
    });

    console.log("[Admin] adminResolveMeeting completed", {
      meetingId: args.meetingId,
      opportunityId: opportunity._id,
      startedAt: args.startedAt,
      stoppedAt: args.stoppedAt,
    });
  },
});
