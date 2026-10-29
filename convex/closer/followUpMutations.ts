import { blockBooking } from "../pipeline/blocked";
import { v } from "convex/values";
import { internalMutation, mutation } from "../_generated/server";
import { completeMeetingForOutcome } from "../lib/meetingOutcomeCompletion";
import { assertCanRecordMeetingOutcome } from "../lib/outcomeEligibility";
import { transitionOpportunity } from "../lib/opportunityActivity";
import { canStartFollowUp, describeDealState } from "../opportunities/dealGuards";
import { requireTenantUser } from "../requireTenantUser";
import { emitDomainEvent } from "../lib/domainEvents";
import { expireUnfinishedFollowUp } from "../lib/activeFollowUp";

/**
 * OUTCOME MUTATION CONTRACT
 *
 * Meeting-driven follow-up outcomes now close the scheduled meeting through
 * completeMeetingForOutcome. Reminder-only flows stay opportunity-only unless
 * a caller supplies an explicit meeting id.
 */

/**
 * Create a scheduling-link follow-up and move the deal to Follow-up, in one
 * transaction. Called by the createFollowUp action after Calendly returned
 * the single-use link; the action checked the caller, and this checks the
 * deal again, since it may have moved while Calendly answered.
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
    const opportunity = await ctx.db.get("opportunities", args.opportunityId);
    if (!opportunity || opportunity.tenantId !== args.tenantId) {
      throw new Error("Opportunity not found");
    }
    if (!canStartFollowUp(opportunity)) {
      throw new Error(
        `Cannot schedule follow-up: the deal is "${describeDealState(opportunity)}". ` +
          `Only a deal awaiting its call's result, or one a missed meeting closed, supports follow-ups.`
      );
    }

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
      createdByUserId: args.closerId,
      createdSource: "closer",
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
    // Booked or Call held -> Follow-up, or a missed meeting's Closed lost ->
    // Follow-up, which only the exception allows.
    await transitionOpportunity(ctx, args.opportunityId, {
      to: { stage: "follow_up" },
      fields: { updatedAt: now },
      exception: "missed_meeting_next_step",
      source: "system",
      actorUserId: args.closerId,
      occurredAt: now,
    });
    return id;
  },
});

/**
 * Mark a follow-up as booked (called when pipeline detects the follow-up booking).
 * This could be wired into the invitee.created handler in Phase 3.
 */
export const markFollowUpBooked = internalMutation({
  args: { opportunityId: v.id("opportunities"), calendlyEventUri: v.string(), occurredAt: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, { opportunityId, calendlyEventUri, occurredAt }) => {
    const opportunity = await ctx.db.get("opportunities", opportunityId);
    if (!opportunity) throw new Error("Opportunity not found");
    const rows = await ctx.db.query("followUps").withIndex("by_opportunityId_and_status_and_reason", q => q.eq("opportunityId", opportunityId).eq("status", "pending")).take(65);
    if (rows.length > 64) blockBooking("follow_up_history_requires_review");
    if (rows.some(r => r.tenantId !== opportunity.tenantId)) throw new Error("Follow-up tenant mismatch");
    const eligible = rows.filter(r => r.type !== "manual_reminder");
    if (eligible.length > 1) blockBooking("ambiguous_follow_up");
    const followUp = eligible[0];
    if (!followUp) return null;
    const bookedAt = occurredAt ?? Date.now();
    if (followUp.createdAt > bookedAt) blockBooking("historical_booking_requires_review");
    await ctx.db.patch("followUps", followUp._id, { status: "booked", calendlyEventUri, bookedAt });
    await emitDomainEvent(ctx, { tenantId: opportunity.tenantId, entityType: "followUp", entityId: followUp._id,
      eventType: "followUp.booked", source: "pipeline", fromStatus: "pending", toStatus: "booked", occurredAt: bookedAt });
    return null;
  },
});

/**
 * Generate a scheduling link for the person to book their next call, and
 * move the deal to Follow-up at once. From the meeting page's outcome
 * (`meetingId` given) the call is marked held too, as every other outcome
 * does. The link stays pending until a booking through it moves the deal on
 * to Booked (pipeline/inviteeCreated.ts), or the closer cancels it or marks
 * the deal lost from the task page (closer/linkTaskOutcomes.ts).
 */
export const createSchedulingLinkFollowUp = mutation({
  args: {
    opportunityId: v.id("opportunities"),
    meetingId: v.optional(v.id("meetings")),
  },
  handler: async (ctx, { opportunityId, meetingId }) => {
    const { userId, tenantId, role } = await requireTenantUser(ctx, ["closer"]);

    const now = Date.now();
    const user = await ctx.db.get("users", userId);
    if (!user) {
      throw new Error("User not found");
    }
    if (!user.personalEventTypeUri) {
      throw new Error(
        "No personal calendar configured. Ask your admin to assign one in Team settings.",
      );
    }

    const opportunity = await ctx.db.get("opportunities", opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found");
    }
    if (opportunity.assignedCloserId !== userId) {
      throw new Error("Not your opportunity");
    }
    const meeting = meetingId ? await ctx.db.get("meetings", meetingId) : null;
    if (
      meetingId &&
      (!meeting ||
        meeting.tenantId !== tenantId ||
        meeting.opportunityId !== opportunityId)
    ) {
      throw new Error("Meeting does not belong to this opportunity");
    }
    // A second Generate (a double click, another tab) finds the deal at
    // Follow-up already and is refused here, so a deal never holds two
    // pending links from one dialog.
    if (!canStartFollowUp(opportunity)) {
      throw new Error(
        `Cannot schedule follow-up: the deal is "${describeDealState(opportunity)}"`,
      );
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

    const followUpId = await ctx.db.insert("followUps", {
      tenantId,
      opportunityId,
      leadId: opportunity.leadId,
      closerId: userId,
      type: "scheduling_link",
      reason: "closer_initiated",
      status: "pending",
      ...(meeting ? { sourceMeetingId: meeting._id } : {}),
      createdAt: now,
      createdByUserId: userId,
      createdSource: "closer",
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

    await ctx.db.patch("followUps", followUpId, {
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

    // Booked or Call held -> Follow-up, or a missed meeting's Closed lost ->
    // Follow-up, which only the exception allows. The meeting page keeps the
    // dialog mounted while the deal moves underneath it (outcome-section.tsx),
    // so the closer still sees and copies the link.
    await transitionOpportunity(ctx, opportunityId, {
      to: { stage: "follow_up" },
      fields: { updatedAt: now },
      exception: "missed_meeting_next_step",
      source: "closer",
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
  },
});

/**
 * Cancel a follow-up the closer started but never finished: a pending
 * scheduling link or manual reminder on one of their deals that never moved to
 * Follow-up. Generating a link moves the deal at once now, so this is the
 * meeting page's fallback for links left behind before that change, or any
 * other odd state; cancelling brings the outcome buttons back.
 */
export const cancelPendingFollowUp = mutation({
  args: {
    followUpId: v.id("followUps"),
  },
  returns: v.null(),
  handler: async (ctx, { followUpId }) => {
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);

    const followUp = await ctx.db.get("followUps", followUpId);
    if (!followUp || followUp.tenantId !== tenantId) {
      throw new Error("Follow-up not found");
    }
    const opportunity = await ctx.db.get("opportunities", followUp.opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found");
    }
    if (opportunity.assignedCloserId !== userId) {
      throw new Error("Not your opportunity");
    }

    await expireUnfinishedFollowUp(ctx, {
      followUp,
      opportunity,
      source: "closer",
      actorUserId: userId,
    });
    return null;
  },
});

export const createManualReminderFollowUpPublic = mutation({
  args: {
    opportunityId: v.id("opportunities"),
    meetingId: v.optional(v.id("meetings")),
    contactMethod: v.union(v.literal("call"), v.literal("text")),
    reminderScheduledAt: v.number(),
    reminderNote: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { userId, tenantId, role } = await requireTenantUser(ctx, ["closer"]);

    const opportunity = await ctx.db.get("opportunities", args.opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found");
    }
    if (opportunity.assignedCloserId !== userId) {
      throw new Error("Not your opportunity");
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
        `Cannot schedule follow-up: the deal is "${describeDealState(opportunity)}"`,
      );
    }

    const now = Date.now();
    if (args.reminderScheduledAt <= now) {
      throw new Error("Reminder time must be in the future");
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
      ...(meeting ? { sourceMeetingId: meeting._id } : {}),
      createdAt: now,
      createdByUserId: userId,
      createdSource: "closer",
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

    // Booked or Call held -> Follow-up, or a missed meeting's Closed lost ->
    // Follow-up, which only the exception allows.
    await transitionOpportunity(ctx, args.opportunityId, {
      to: { stage: "follow_up" },
      fields: { updatedAt: now },
      exception: "missed_meeting_next_step",
      source: "closer",
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

    const followUp = await ctx.db.get("followUps", followUpId);
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
    await ctx.db.patch("followUps", followUpId, {
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
  },
});
