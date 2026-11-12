import { v, type Infer } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { mutation } from "../_generated/server";
import { completeMeetingForOutcome } from "../lib/meetingOutcomeCompletion";
import { assertCanRecordMeetingOutcome } from "../lib/outcomeEligibility";
import { missedMeetingLoss, transitionOpportunity } from "../lib/opportunityActivity";
import { canSendRescheduleLink, describeDealState } from "../opportunities/dealGuards";
import { requireTenantUser } from "../requireTenantUser";
import { emitDomainEvent } from "../lib/domainEvents";
import {
  assertCoreRole,
  personalCalendarMissing,
  provenanceMetadata,
  toCheckResult,
  WEB,
  type CheckResult,
  type CoreActor,
  type Provenance,
} from "../lib/outcomeCores";
import { queueSecondOpinion } from "../secondOpinion/trigger";
import { fromSuggestionValidator, type FromSuggestion } from "../callInsights/validators";
import {
  markSuggestionUsed,
  resolveSuggestionRef,
} from "../callInsights/suggest/state";

export const noShowReasonValidator = v.union(
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
 * Mark a scheduled meeting as no-show.
 *
 * Records structured no-show metadata, marks the meeting no-show and closes
 * the deal lost with the reason `no_show`, without writing actual meeting
 * timing fields.
 */
export const markNoShow = mutation({
  args: {
    meetingId: v.id("meetings"),
    reason: noShowReasonValidator,
    note: v.optional(v.string()),
    fromSuggestion: v.optional(fromSuggestionValidator),
  },
  handler: async (ctx, args) => {
    const actor = await requireTenantUser(ctx, ["closer"]);
    await recordNoShow(ctx, actor, args, WEB);
  },
});

export type NoShowReason = Infer<typeof noShowReasonValidator>;

export type NoShowArgs = {
  meetingId: Id<"meetings">;
  reason: NoShowReason;
  note?: string;
  fromSuggestion?: FromSuggestion;
};

/** Every check `markNoShow` makes, in its order, with no write. */
async function checkNoShow(
  ctx: QueryCtx | MutationCtx,
  actor: CoreActor,
  args: NoShowArgs,
) {
  assertCoreRole(actor, ["closer"]);
  const { userId, tenantId, role } = actor;

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
  return { userId, tenantId, meeting, opportunity, now };
}

/**
 * Whether `recordNoShow` would mark this meeting, without writing, with the
 * refusal it would throw returned as `{ ok: false, code, message }`
 * (decision 17).
 */
export async function checkNoShowAllowed(
  ctx: QueryCtx | MutationCtx,
  actor: CoreActor,
  args: NoShowArgs,
): Promise<
  CheckResult<{
    meetingId: Id<"meetings">;
    opportunityId: Id<"opportunities">;
    leadId: Id<"leads">;
    scheduledAt: number;
  }>
> {
  return await toCheckResult(async () => {
    const { meeting, opportunity } = await checkNoShow(ctx, actor, args);
    return {
      meetingId: meeting._id,
      opportunityId: opportunity._id,
      leadId: opportunity.leadId,
      scheduledAt: meeting.scheduledAt,
    };
  });
}

/**
 * Marks a scheduled meeting no-show and closes its deal lost with the reason
 * `no_show`. The core of `markNoShow` (docs/plans/closer-assistant.md §6.3).
 * `provenance` tags the `meeting.no_show` event for an agent.
 */
export async function recordNoShow(
  ctx: MutationCtx,
  actor: CoreActor,
  args: NoShowArgs,
  provenance: Provenance,
): Promise<void> {
  const { meetingId, reason, note } = args;
  const { userId, tenantId, meeting, opportunity, now } = await checkNoShow(
    ctx,
    actor,
    args,
  );

  const suggestion = args.fromSuggestion
    ? await resolveSuggestionRef(ctx, {
        tenantId,
        meetingId: meeting._id,
        ref: args.fromSuggestion,
      }).catch(() => null)
    : null;

  const normalizedNote = normalizeOptionalString(note);

  // Booked (or Call held) -> Closed lost: a missed meeting's loss names no person.
  await transitionOpportunity(ctx, opportunity._id, {
    to: { stage: "closed", outcome: "lost" },
    fields: { updatedAt: now, ...missedMeetingLoss("no_show", now) },
    source: "closer",
    actorUserId: userId,
    reason,
    occurredAt: now,
  });
  await completeMeetingForOutcome(ctx, {
    meetingId: meeting._id,
    opportunityId: opportunity._id,
    toMeetingStatus: "no_show",
    recordedAt: now,
    extraMeetingPatch: {
      noShowMarkedAt: now,
      noShowReason: reason,
      noShowNote: normalizedNote,
      noShowMarkedByUserId: userId,
      noShowSource: "closer",
    },
  });

  await emitDomainEvent(ctx, {
    tenantId,
    entityType: "meeting",
    entityId: meetingId,
    eventType: "meeting.no_show",
    source: "closer",
    actorUserId: userId,
    fromStatus: meeting.status,
    toStatus: "no_show",
    reason,
    metadata: {
      noteProvided: Boolean(normalizedNote),
      ...provenanceMetadata(provenance),
    },
    occurredAt: now,
  });
  if (suggestion) {
    await markSuggestionUsed(ctx, {
      state: suggestion,
      userId,
      changedFields: args.fromSuggestion?.changedFields,
    }).catch(() => undefined);
  }
  // A recorded result plus a matched recording starts Jev's check (§6.9).
  await queueSecondOpinion(ctx, { meetingId: meetingId, trigger: "result_recorded" });
}

/**
 * Generate a reschedule link for a no-show opportunity.
 *
 * Creates a pending reschedule link (a scheduling-link follow-up with
 * no-show-specific UTMs) and reopens the deal at Follow-up, so the pipeline
 * can deterministically relink the lead's next booking.
 */
export const createNoShowRescheduleLink = mutation({
  args: {
    opportunityId: v.id("opportunities"),
    meetingId: v.id("meetings"),
  },
  handler: async (ctx, { opportunityId, meetingId }) => {
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);

    const user = await ctx.db.get("users", userId);
    if (!user) {
      throw new Error("User not found");
    }
    if (!user.personalEventTypeUri) {
      throw personalCalendarMissing();
    }

    const opportunity = await ctx.db.get("opportunities", opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found");
    }
    if (opportunity.assignedCloserId !== userId) {
      throw new Error("Not your opportunity");
    }
    if (!canSendRescheduleLink(opportunity)) {
      throw new Error(
        `Reschedule is only available on a deal a no-show closed (current: "${describeDealState(opportunity)}")`,
      );
    }

    const meeting = await ctx.db.get("meetings", meetingId);
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
      sourceMeetingId: meetingId,
      createdAt: now,
      createdByUserId: userId,
      createdSource: "closer",
    });

    // Closed lost (no-show) -> Follow-up, after the link: the status reads it
    // as `reschedule_link_sent`.
    await transitionOpportunity(ctx, opportunityId, {
      to: { stage: "follow_up" },
      fields: { updatedAt: now },
      exception: "missed_meeting_next_step",
      source: "closer",
      actorUserId: userId,
      occurredAt: now,
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

    return { schedulingLinkUrl, followUpId };
  },
});
