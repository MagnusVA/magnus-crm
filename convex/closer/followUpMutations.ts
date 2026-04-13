import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation, mutation } from "../_generated/server";
import { validateTransition } from "../lib/statusTransitions";
import { requireTenantUser } from "../requireTenantUser";
import { emitDomainEvent } from "../lib/domainEvents";
import { replaceOpportunityAggregate } from "../reporting/writeHooks";
import {
  isActiveOpportunityStatus,
  updateTenantStats,
} from "../lib/tenantStatsHelper";

/**
 * Create a follow-up record.
 * Called by the createFollowUp action after generating the scheduling link.
 */
export const createFollowUpRecord = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    opportunityId: v.id("opportunities"),
    leadId: v.id("leads"),
    closerId: v.id("users"),
    schedulingLinkUrl: v.string(),
    reason: v.union(
      v.literal("closer_initiated"),
      v.literal("cancellation_follow_up"),
      v.literal("no_show_follow_up"),
    ),
  },
  handler: async (ctx, args) => {
    console.log("[Closer:FollowUp] createFollowUpRecord called", { opportunityId: args.opportunityId, reason: args.reason });
    const now = Date.now();
    const id = await ctx.db.insert("followUps", {
      tenantId: args.tenantId,
      opportunityId: args.opportunityId,
      leadId: args.leadId,
      closerId: args.closerId,
      type: "scheduling_link",
      schedulingLinkUrl: args.schedulingLinkUrl,
      reason: args.reason,
      status: "pending",
      createdAt: now,
    });
    await emitDomainEvent(ctx, {
      tenantId: args.tenantId,
      entityType: "followUp",
      entityId: id,
      eventType: "followUp.created",
      source: "system",
      actorUserId: args.closerId,
      toStatus: "pending",
      metadata: {
        type: "scheduling_link",
        opportunityId: args.opportunityId,
      },
      occurredAt: now,
    });
    console.log("[Closer:FollowUp] createFollowUpRecord inserted", { followUpId: id });
    return id;
  },
});

/**
 * Transition an opportunity to follow_up_scheduled.
 * Validates the transition is allowed from the current status.
 */
export const transitionToFollowUp = internalMutation({
  args: { opportunityId: v.id("opportunities") },
  handler: async (ctx, { opportunityId }) => {
    console.log("[Closer:FollowUp] transitionToFollowUp called", { opportunityId });
    const opportunity = await ctx.db.get(opportunityId);
    if (!opportunity) throw new Error("Opportunity not found");

    console.log("[Closer:FollowUp] transitionToFollowUp current status", { currentStatus: opportunity.status });
    const isValid = validateTransition(opportunity.status, "follow_up_scheduled");
    console.log("[Closer:FollowUp] transitionToFollowUp transition valid", { from: opportunity.status, to: "follow_up_scheduled", valid: isValid });
    if (!isValid) {
      throw new Error(
        `Cannot schedule follow-up from status "${opportunity.status}". ` +
          `Only "in_progress", "canceled", and "no_show" opportunities support follow-ups.`
      );
    }

    const now = Date.now();
    await ctx.db.patch(opportunityId, {
      status: "follow_up_scheduled",
      updatedAt: now,
    });
    await replaceOpportunityAggregate(ctx, opportunity, opportunityId);
    await updateTenantStats(ctx, opportunity.tenantId, {
      activeOpportunities: isActiveOpportunityStatus(opportunity.status) ? 0 : 1,
    });
    await emitDomainEvent(ctx, {
      tenantId: opportunity.tenantId,
      entityType: "opportunity",
      entityId: opportunityId,
      eventType: "opportunity.status_changed",
      source: "system",
      fromStatus: opportunity.status,
      toStatus: "follow_up_scheduled",
      occurredAt: now,
    });
    console.log("[Closer:FollowUp] transitionToFollowUp patch applied", { opportunityId, newStatus: "follow_up_scheduled" });
  },
});

/**
 * Mark a follow-up as booked (called when pipeline detects the follow-up booking).
 * This could be wired into the invitee.created handler in Phase 3.
 */
export const markFollowUpBooked = internalMutation({
  args: {
    opportunityId: v.id("opportunities"),
    calendlyEventUri: v.string(),
  },
  handler: async (ctx, { opportunityId, calendlyEventUri }) => {
    console.log("[Closer:FollowUp] markFollowUpBooked called", { opportunityId });
    let followUpId: Id<"followUps"> | null = null;
    let pendingFollowUpTenantId: Id<"tenants"> | null = null;
    let previousStatus: "pending" | "booked" | "completed" | "expired" | null = null;
    for await (const followUp of ctx.db
      .query("followUps")
      .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opportunityId))) {
      if (followUp.status === "pending") {
        followUpId = followUp._id;
        pendingFollowUpTenantId = followUp.tenantId;
        previousStatus = followUp.status;
        break;
      }
    }

    if (followUpId) {
      console.log("[Closer:FollowUp] markFollowUpBooked: found pending follow-up", { followUpId });
      await ctx.db.patch(followUpId, {
        status: "booked",
        calendlyEventUri,
        bookedAt: Date.now(),
      });
    await emitDomainEvent(ctx, {
      tenantId: pendingFollowUpTenantId!,
      entityType: "followUp",
      entityId: followUpId,
      eventType: "followUp.booked",
      source: "system",
      fromStatus: previousStatus ?? undefined,
      toStatus: "booked",
      });
      console.log("[Closer:FollowUp] markFollowUpBooked patch applied", { followUpId, newStatus: "booked" });
    } else {
      console.warn("[Closer:FollowUp] markFollowUpBooked: no pending follow-up found", { opportunityId });
    }
  },
});

export const createSchedulingLinkFollowUp = mutation({
  args: {
    opportunityId: v.id("opportunities"),
  },
  handler: async (ctx, { opportunityId }) => {
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);

    const now = Date.now();
    const user = await ctx.db.get(userId);
    if (!user) {
      throw new Error("User not found");
    }
    if (!user.personalEventTypeUri) {
      throw new Error(
        "No personal calendar configured. Ask your admin to assign one in Team settings.",
      );
    }

    const opportunity = await ctx.db.get(opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found");
    }
    if (opportunity.assignedCloserId !== userId) {
      throw new Error("Not your opportunity");
    }
    if (!validateTransition(opportunity.status, "follow_up_scheduled")) {
      throw new Error(
        `Cannot schedule follow-up from status "${opportunity.status}"`,
      );
    }

    const followUpId = await ctx.db.insert("followUps", {
      tenantId,
      opportunityId,
      leadId: opportunity.leadId,
      closerId: userId,
      type: "scheduling_link",
      reason: "closer_initiated",
      status: "pending",
      createdAt: now,
    });

    let schedulingLinkUrl: string;
    try {
      const bookingUrl = new URL(user.personalEventTypeUri);
      bookingUrl.searchParams.set("utm_source", "ptdom");
      bookingUrl.searchParams.set("utm_medium", "follow_up");
      bookingUrl.searchParams.set("utm_campaign", opportunityId);
      bookingUrl.searchParams.set("utm_content", followUpId);
      bookingUrl.searchParams.set("utm_term", userId);
      schedulingLinkUrl = bookingUrl.toString();
    } catch {
      throw new Error("Personal calendar URL is invalid");
    }

    await ctx.db.patch(followUpId, {
      schedulingLinkUrl,
    });
    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "followUp",
      entityId: followUpId,
      eventType: "followUp.created",
      source: "closer",
      actorUserId: userId,
      toStatus: "pending",
      metadata: {
        type: "scheduling_link",
        opportunityId,
      },
      occurredAt: now,
    });
    // NOTE: Status transition is deferred to confirmFollowUpScheduled.
    // If we transition here, Convex reactivity pushes the new status to the
    // client immediately, which re-renders OutcomeActionBar → returns null →
    // unmounts the FollowUpDialog before the user can see/copy the link.

    console.log("[Closer:FollowUp] scheduling link follow-up created", {
      followUpId,
      opportunityId,
    });

    return { schedulingLinkUrl, followUpId };
  },
});

/**
 * Confirm a scheduling-link follow-up by transitioning the opportunity status.
 * Called from the dialog's "Done" button after the user has seen/copied the link.
 */
export const confirmFollowUpScheduled = mutation({
  args: {
    opportunityId: v.id("opportunities"),
  },
  handler: async (ctx, { opportunityId }) => {
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);

    const opportunity = await ctx.db.get(opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found");
    }
    if (opportunity.assignedCloserId !== userId) {
      throw new Error("Not your opportunity");
    }
    // Already transitioned (e.g. user double-clicked Done) — silently succeed
    if (opportunity.status === "follow_up_scheduled") {
      return;
    }
    if (!validateTransition(opportunity.status, "follow_up_scheduled")) {
      throw new Error(
        `Cannot schedule follow-up from status "${opportunity.status}"`,
      );
    }

    const now = Date.now();
    await ctx.db.patch(opportunityId, {
      status: "follow_up_scheduled",
      updatedAt: now,
    });
    await replaceOpportunityAggregate(ctx, opportunity, opportunityId);
    await updateTenantStats(ctx, tenantId, {
      activeOpportunities: isActiveOpportunityStatus(opportunity.status) ? 0 : 1,
    });
    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "opportunity",
      entityId: opportunityId,
      eventType: "opportunity.status_changed",
      source: "closer",
      actorUserId: userId,
      fromStatus: opportunity.status,
      toStatus: "follow_up_scheduled",
      occurredAt: now,
    });

    console.log(
      "[Closer:FollowUp] opportunity confirmed as follow_up_scheduled",
      { opportunityId },
    );
  },
});

export const createManualReminderFollowUpPublic = mutation({
  args: {
    opportunityId: v.id("opportunities"),
    contactMethod: v.union(v.literal("call"), v.literal("text")),
    reminderScheduledAt: v.number(),
    reminderNote: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);

    const opportunity = await ctx.db.get(args.opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found");
    }
    if (opportunity.assignedCloserId !== userId) {
      throw new Error("Not your opportunity");
    }
    if (!validateTransition(opportunity.status, "follow_up_scheduled")) {
      throw new Error(
        `Cannot schedule follow-up from status "${opportunity.status}"`,
      );
    }

    const now = Date.now();
    if (args.reminderScheduledAt <= now) {
      throw new Error("Reminder time must be in the future");
    }

    const followUpId = await ctx.db.insert("followUps", {
      tenantId,
      opportunityId: args.opportunityId,
      leadId: opportunity.leadId,
      closerId: userId,
      type: "manual_reminder",
      contactMethod: args.contactMethod,
      reminderScheduledAt: args.reminderScheduledAt,
      reminderNote: args.reminderNote,
      reason: "closer_initiated",
      status: "pending",
      createdAt: now,
    });

    await ctx.db.patch(args.opportunityId, {
      status: "follow_up_scheduled",
      updatedAt: now,
    });
    await replaceOpportunityAggregate(ctx, opportunity, args.opportunityId);
    await updateTenantStats(ctx, tenantId, {
      activeOpportunities: isActiveOpportunityStatus(opportunity.status) ? 0 : 1,
    });
    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "followUp",
      entityId: followUpId,
      eventType: "followUp.created",
      source: "closer",
      actorUserId: userId,
      toStatus: "pending",
      metadata: {
        type: "manual_reminder",
        opportunityId: args.opportunityId,
      },
      occurredAt: now,
    });
    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "opportunity",
      entityId: args.opportunityId,
      eventType: "opportunity.status_changed",
      source: "closer",
      actorUserId: userId,
      fromStatus: opportunity.status,
      toStatus: "follow_up_scheduled",
      occurredAt: now,
    });

    console.log("[Closer:FollowUp] manual reminder follow-up created", {
      followUpId,
      opportunityId: args.opportunityId,
      contactMethod: args.contactMethod,
      reminderScheduledAt: args.reminderScheduledAt,
    });

    return { followUpId };
  },
});

export const markReminderComplete = mutation({
  args: {
    followUpId: v.id("followUps"),
    completionNote: v.optional(v.string()),
  },
  handler: async (ctx, { followUpId, completionNote }) => {
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);

    const followUp = await ctx.db.get(followUpId);
    if (!followUp) {
      throw new Error("Follow-up not found");
    }
    if (followUp.tenantId !== tenantId) {
      throw new Error("Access denied");
    }
    if (followUp.closerId !== userId) {
      throw new Error("Not your follow-up");
    }
    if (followUp.type !== "manual_reminder") {
      throw new Error("Not a manual reminder");
    }
    if (followUp.status !== "pending") {
      throw new Error("Follow-up is not pending");
    }

    const now = Date.now();
    await ctx.db.patch(followUpId, {
      status: "completed",
      completedAt: now,
      ...(completionNote ? { completionNote } : {}),
    });
    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "followUp",
      entityId: followUpId,
      eventType: "followUp.completed",
      source: "closer",
      actorUserId: userId,
      fromStatus: followUp.status,
      toStatus: "completed",
      occurredAt: now,
    });

    console.log("[Closer:FollowUp] reminder marked complete", {
      followUpId,
      hasCompletionNote: Boolean(completionNote),
    });
  },
});
