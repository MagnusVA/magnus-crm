import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { updateOpportunityMeetingRefs } from "../lib/opportunityMeetingRefs";
import { validateTransition } from "../lib/statusTransitions";
import { requireTenantUser } from "../requireTenantUser";

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

/**
 * Mark an in-progress meeting as no-show.
 *
 * Primary no-show creation path used by the closer while they are waiting for
 * the lead. Records the wait duration, structured reason, optional note, and
 * source, then transitions both the meeting and opportunity to "no_show".
 */
export const markNoShow = mutation({
  args: {
    meetingId: v.id("meetings"),
    reason: noShowReasonValidator,
    note: v.optional(v.string()),
  },
  handler: async (ctx, { meetingId, reason, note }) => {
    console.log("[Closer:NoShow] markNoShow called", { meetingId, reason });
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);

    const meeting = await ctx.db.get(meetingId);
    if (!meeting || meeting.tenantId !== tenantId) {
      throw new Error("Meeting not found");
    }
    if (meeting.status !== "in_progress") {
      throw new Error(
        `Can only mark no-show on in-progress meetings (current: "${meeting.status}")`,
      );
    }

    const opportunity = await ctx.db.get(meeting.opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found");
    }
    if (opportunity.assignedCloserId !== userId) {
      throw new Error("Not your meeting");
    }
    if (!validateTransition(opportunity.status, "no_show")) {
      throw new Error(
        `Cannot transition opportunity from "${opportunity.status}" to "no_show"`,
      );
    }

    const now = Date.now();
    const normalizedNote = normalizeOptionalString(note);
    const waitDurationMs =
      meeting.startedAt !== undefined
        ? Math.max(0, now - meeting.startedAt)
        : undefined;

    await ctx.db.patch(meetingId, {
      status: "no_show",
      noShowMarkedAt: now,
      noShowWaitDurationMs: waitDurationMs,
      noShowReason: reason,
      noShowNote: normalizedNote,
      noShowSource: "closer",
    });

    await ctx.db.patch(opportunity._id, {
      status: "no_show",
      updatedAt: now,
    });

    await updateOpportunityMeetingRefs(ctx, opportunity._id);

    console.log("[Closer:NoShow] markNoShow completed", {
      meetingId,
      opportunityId: opportunity._id,
      closerId: userId,
      reason,
      waitDurationMs,
    });
  },
});

/**
 * Generate a reschedule link for a no-show opportunity.
 *
 * Creates a pending scheduling-link follow-up with no-show-specific UTMs and
 * transitions the opportunity to "reschedule_link_sent" so the pipeline can
 * deterministically relink the lead's next booking.
 */
export const createNoShowRescheduleLink = mutation({
  args: {
    opportunityId: v.id("opportunities"),
    meetingId: v.id("meetings"),
  },
  handler: async (ctx, { opportunityId, meetingId }) => {
    console.log("[Closer:NoShow] createNoShowRescheduleLink called", {
      opportunityId,
      meetingId,
    });
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);

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
    if (opportunity.status !== "no_show") {
      throw new Error(
        `Reschedule is only available for no-show opportunities (current: "${opportunity.status}")`,
      );
    }
    if (!validateTransition(opportunity.status, "reschedule_link_sent")) {
      throw new Error(
        `Cannot transition opportunity from "${opportunity.status}" to "reschedule_link_sent"`,
      );
    }

    const meeting = await ctx.db.get(meetingId);
    if (
      !meeting ||
      meeting.tenantId !== tenantId ||
      meeting.opportunityId !== opportunityId
    ) {
      throw new Error("Meeting not found or does not belong to this opportunity");
    }
    if (meeting.status !== "no_show") {
      throw new Error(
        `Reschedule link can only be created from a no-show meeting (current: "${meeting.status}")`,
      );
    }

    let schedulingLinkUrl: string;
    try {
      const bookingUrl = new URL(user.personalEventTypeUri);
      bookingUrl.searchParams.set("utm_source", "ptdom");
      bookingUrl.searchParams.set("utm_medium", "noshow_resched");
      bookingUrl.searchParams.set("utm_campaign", opportunityId);
      bookingUrl.searchParams.set("utm_content", meetingId);
      bookingUrl.searchParams.set("utm_term", userId);
      schedulingLinkUrl = bookingUrl.toString();
    } catch {
      throw new Error("Personal calendar URL is invalid");
    }

    const now = Date.now();
    const followUpId = await ctx.db.insert("followUps", {
      tenantId,
      opportunityId,
      leadId: opportunity.leadId,
      closerId: userId,
      type: "scheduling_link",
      schedulingLinkUrl,
      reason: "no_show_follow_up",
      status: "pending",
      createdAt: now,
    });

    await ctx.db.patch(opportunityId, {
      status: "reschedule_link_sent",
      updatedAt: now,
    });

    console.log("[Closer:NoShow] createNoShowRescheduleLink completed", {
      followUpId,
      opportunityId,
      originalMeetingId: meetingId,
    });

    return { schedulingLinkUrl, followUpId };
  },
});
