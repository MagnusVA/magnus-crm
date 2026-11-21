import { blockBooking } from "../pipeline/blocked";
import { v, type Infer } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internalMutation, mutation } from "../_generated/server";
import { noteHumanResult } from "../automation/humanResult";
import { validateCurrency } from "../lib/formatMoney";
import { insertManualReminder } from "../lib/reminderInsert";
import { completeMeetingForOutcome } from "../lib/meetingOutcomeCompletion";
import { assertCanRecordMeetingOutcome } from "../lib/outcomeEligibility";
import { computeLatestActivityAt, transitionOpportunity } from "../lib/opportunityActivity";
import { canStartFollowUp, describeDealState, loadDealOpenTasks } from "../opportunities/dealGuards";
import { requireTenantUser } from "../requireTenantUser";
import { emitDomainEvent } from "../lib/domainEvents";
import { expireUnfinishedFollowUp } from "../lib/activeFollowUp";
import {
  landFollowUp,
  resolveFollowUpStart,
  type FollowUpStart,
} from "../lib/followUpStart";
import {
  assertCoreRole,
  callAttendancePatch,
  guardActorForOutcome,
  liveOutcomeSuggestion,
  type AutomationCoreOptions,
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
    if (opportunity.assignedCloserId !== args.closerId) {
      throw new Error("Not your opportunity");
    }
    if (opportunity.leadId !== args.leadId) {
      throw new Error("Opportunity person changed while creating the link");
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
    await noteHumanResult(ctx, args.opportunityId, { tenantId: args.tenantId, userId: args.closerId });
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
    fromSuggestion: v.optional(fromSuggestionValidator),
  },
  handler: async (ctx, { opportunityId, meetingId, fromSuggestion }) => {
    const { userId, tenantId, role } = await requireTenantUser(ctx, ["closer"]);

    const now = Date.now();
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
    // Follow-up with this link open and is refused here, so a deal never
    // holds two pending links from one dialog.
    const start = await resolveFollowUpStart(ctx, opportunity, meeting, "Cannot schedule follow-up");
    if (meeting) {
      assertCanRecordMeetingOutcome({
        meeting,
        opportunity,
        userId,
        role,
        now,
      });
    }

    const suggestion = fromSuggestion && meeting
      ? await resolveSuggestionRef(ctx, {
          tenantId,
          meetingId: meeting._id,
          ref: fromSuggestion,
        }).catch(() => null)
      : null;

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

    // The meeting page keeps the dialog mounted while the deal moves
    // underneath it (outcome-section.tsx), so the closer still sees and
    // copies the link.
    await landFollowUp(ctx, opportunityId, start, {
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

    if (suggestion) {
      await markSuggestionUsed(ctx, {
        state: suggestion,
        userId,
        changedFields: fromSuggestion?.changedFields,
      }).catch(() => undefined);
    }

    await noteHumanResult(ctx, opportunityId, { tenantId, userId });
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

const paymentOwedValidator = v.object({
  expectedAmountMinor: v.optional(v.number()),
  expectedCurrency: v.optional(v.string()),
  promisedPaymentAt: v.optional(v.number()),
});

export const createManualReminderFollowUpPublic = mutation({
  args: {
    opportunityId: v.id("opportunities"),
    meetingId: v.optional(v.id("meetings")),
    contactMethod: v.union(v.literal("call"), v.literal("text")),
    reminderScheduledAt: v.number(),
    reminderNote: v.optional(v.string()),
    fromSuggestion: v.optional(fromSuggestionValidator),
    paymentOwed: v.optional(paymentOwedValidator),
  },
  returns: v.object({ followUpId: v.id("followUps") }),
  handler: async (ctx, args) => {
    const actor = await requireTenantUser(ctx, ["closer"]);
    return await createCallbackTask(ctx, actor, args, WEB);
  },
});

export type CallbackTaskArgs = {
  opportunityId: Id<"opportunities">;
  /** The call whose result this is; it is recorded held. */
  meetingId?: Id<"meetings">;
  contactMethod: "call" | "text";
  reminderScheduledAt: number;
  reminderNote?: string;
  fromSuggestion?: FromSuggestion;
  paymentOwed?: Infer<typeof paymentOwedValidator>;
};

/**
 * Every check `createManualReminderFollowUpPublic` makes, in its order, with
 * no write. Throws the refusal.
 */
async function checkCallbackTask(
  ctx: QueryCtx | MutationCtx,
  actor: CoreActor,
  args: CallbackTaskArgs,
) {
  assertCoreRole(actor, ["closer"]);
  const { userId, tenantId, role } = actor;

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
  const start = await resolveFollowUpStart(ctx, opportunity, meeting, "Cannot schedule follow-up");

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
  return { userId, tenantId, opportunity, meeting, start, now };
}

/**
 * Whether `createCallbackTask` would set this call-back, without writing,
 * with the refusal it would throw returned as `{ ok: false, code, message }`.
 */
export async function checkCallbackTaskAllowed(
  ctx: QueryCtx | MutationCtx,
  actor: CoreActor,
  args: CallbackTaskArgs,
): Promise<
  CheckResult<{
    opportunityId: Id<"opportunities">;
    meetingId: Id<"meetings"> | null;
    leadId: Id<"leads">;
    /** Whether the deal moves to Follow-up, or stays there with a new task. */
    start: FollowUpStart;
  }>
> {
  return await toCheckResult(async () => {
    const { opportunity, meeting, start } = await checkCallbackTask(ctx, actor, args);
    return {
      opportunityId: opportunity._id,
      meetingId: meeting?._id ?? null,
      leadId: opportunity.leadId,
      start,
    };
  });
}

/**
 * Sets a call or text call-back task on the closer's deal and moves the deal
 * to Follow-up. With a meeting, the call is recorded held, as every other
 * outcome does. The core of `createManualReminderFollowUpPublic`
 * (docs/plans/closer-assistant.md §6.3). `provenance` tags the
 * `followUp.created` event for an agent.
 */
export async function createCallbackTask(
  ctx: MutationCtx,
  actor: CoreActor | null,
  args: CallbackTaskArgs,
  provenance: Provenance,
  automation?: AutomationCoreOptions,
): Promise<{ followUpId: Id<"followUps"> }> {
  const guardedActor = await guardActorForOutcome(ctx, actor, args, automation, "closer");
  const { userId, tenantId, opportunity, meeting, start, now } =
    await checkCallbackTask(ctx, guardedActor, args);

  if (automation && (await loadDealOpenTasks(ctx, opportunity._id)).hasOpenTask) {
    throw new Error("The deal already has a pending task");
  }
  const paymentOwed = args.paymentOwed;
  if (paymentOwed && automation) throw new Error("A manual payment promise requires a human result");
  const { expectedAmountMinor, expectedCurrency, promisedPaymentAt } = paymentOwed ?? {};
  if ((expectedAmountMinor === undefined) !== (expectedCurrency === undefined)) {
    throw new Error("Enter the expected amount and currency together");
  }
  if (expectedAmountMinor !== undefined && (!Number.isSafeInteger(expectedAmountMinor) || expectedAmountMinor <= 0)) {
    throw new Error("Expected amount in minor units must be a positive integer");
  }
  if (promisedPaymentAt !== undefined && !Number.isFinite(new Date(promisedPaymentAt).getTime())) {
    throw new Error("Invalid promised payment date");
  }
  const currency = expectedCurrency === undefined ? undefined : validateCurrency(expectedCurrency);
  const suggestion = automation && meeting
    ? actor && await liveOutcomeSuggestion(ctx, meeting, now).catch(() => null)
    : args.fromSuggestion && meeting
    ? await resolveSuggestionRef(ctx, {
        tenantId,
        meetingId: meeting._id,
        ref: args.fromSuggestion,
      }).catch(() => null)
    : null;

  const writer = automation?.system
    ? { source: "system" as const, latestActivityAt: opportunity.latestActivityAt ?? computeLatestActivityAt(opportunity) }
    : { source: "closer" as const, actorUserId: userId };
  const followUpId = await insertManualReminder(ctx, {
    opportunity,
    closerId: userId,
    contactMethod: args.contactMethod,
    reminderScheduledAt: args.reminderScheduledAt,
    reminderNote: args.reminderNote,
    sourceMeetingId: meeting?._id,
    reason: automation ? "call_insights" : "closer_initiated",
    task: automation ? automation.task ?? { purpose: "call_back" } : undefined,
    automationDecisionId: automation?.decisionId,
    now,
    ...writer,
    metadata: paymentOwed ? { ...provenanceMetadata(provenance), purpose: "payment_owed" } : provenanceMetadata(provenance),
  });
  // The insert helper requires all promise fields on automation tasks. A
  // closer can save a payment-owed reminder with a partial or unknown promise.
  if (paymentOwed) {
    await ctx.db.patch("followUps", followUpId, {
      purpose: "payment_owed",
      expectedAmountMinor,
      expectedCurrency: currency,
      promisedPaymentAt,
    });
  }

  const landTask = () => landFollowUp(ctx, args.opportunityId, start, {
    ...writer,
    occurredAt: now,
    decisionId: automation?.decisionId,
  });
  if (!automation?.system) await landTask();
  if (meeting) {
    await completeMeetingForOutcome(ctx, {
      meetingId: meeting._id,
      opportunityId: opportunity._id,
      toMeetingStatus: "held",
      recordedAt: now,
      extraMeetingPatch: callAttendancePatch(automation),
    });
    if (suggestion) {
      await markSuggestionUsed(ctx, {
        state: suggestion,
        userId,
        changedFields: automation ? undefined : args.fromSuggestion?.changedFields,
      }).catch(() => undefined);
    }
    // A recorded result plus a matched recording starts Jev's check (§6.9).
    if (!automation?.system) {
      await queueSecondOpinion(ctx, { meetingId: meeting._id, trigger: "result_recorded" });
    }
  }

  // Marking held updates the deal's meeting refs and can recompute its activity time.
  if (automation?.system) await landTask();

  if (actor && !automation) await noteHumanResult(ctx, opportunity._id, actor);
  return { followUpId };
}

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
    await noteHumanResult(ctx, followUp.opportunityId, { tenantId, userId });
  },
});
