import { RESERVED_LOSS_REASONS } from "../opportunities/stages";
import { assertTypedLossReason } from "../opportunities/reservedLossReason";
import { v } from "convex/values";
import { noteHumanResult } from "../automation/humanResult";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { mutation } from "../_generated/server";
import { assertCanRecordMeetingOutcome } from "../lib/outcomeEligibility";
import { completeMeetingForOutcome } from "../lib/meetingOutcomeCompletion";
import { computeLatestActivityAt, transitionOpportunity } from "../lib/opportunityActivity";
import { requireTenantUser } from "../requireTenantUser";
import { canMarkLost, describeDealState, loadDealOpenTasks, loadDealTasks } from "../opportunities/dealGuards";
import { log } from "../lib/observability/log";
import {
  assertCoreRole,
  callAttendancePatch,
  guardActorForOutcome,
  liveOutcomeSuggestion,
  type AutomationCoreOptions,
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

export async function loadMeetingContext(
  ctx: MutationCtx,
  meetingId: Id<"meetings">,
  tenantId: Id<"tenants">,
) {
  const meeting = await ctx.db.get("meetings", meetingId);
  if (!meeting || meeting.tenantId !== tenantId) {
    throw new Error("Meeting not found");
  }

  const opportunity = await ctx.db.get("opportunities", meeting.opportunityId);
  if (!opportunity || opportunity.tenantId !== tenantId) {
    throw new Error("Opportunity not found");
  }

  return { meeting, opportunity };
}

/**
 * OUTCOME MUTATION CONTRACT
 *
 * Meeting-driven outcome mutations update the opportunity and close the
 * meeting through completeMeetingForOutcome. Side-deal paths without a meeting
 * id remain opportunity-only.
 */

/**
 * Mark an opportunity as lost.
 *
 * Transitions the opportunity to "lost" status with an optional reason.
 * This is a terminal state — no further transitions allowed.
 *
 * Only closers can mark their own opportunities as lost.
 */
export const markAsLost = mutation({
  args: {
    opportunityId: v.id("opportunities"),
    meetingId: v.optional(v.id("meetings")),
    reason: v.optional(v.string()),
    fromSuggestion: v.optional(fromSuggestionValidator),
  },
  handler: async (ctx, args) => {
    const actor = await requireTenantUser(ctx, ["closer"]);
    await recordMeetingLoss(ctx, actor, args, WEB);
  },
});

export type MeetingLossArgs = {
  opportunityId: Id<"opportunities">;
  /** The call whose result this is; it is recorded held. */
  meetingId?: Id<"meetings">;
  reason?: string;
  fromSuggestion?: FromSuggestion;
};

/** Every check `markAsLost` makes, in its order, with no write. */
async function checkMeetingLoss(
  ctx: QueryCtx | MutationCtx,
  actor: CoreActor,
  args: MeetingLossArgs,
  automation?: AutomationCoreOptions,
) {
  assertCoreRole(actor, ["closer"]);
  const { userId, tenantId, role } = actor;
  const { opportunityId, meetingId } = args;

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

  // Validate the transition
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
  if (!canMarkLost(opportunity, await loadDealTasks(ctx, opportunityId))) {
    throw new Error(`Cannot mark as lost: the deal is "${describeDealState(opportunity)}"`);
  }
  if (!automation?.refusal) assertTypedLossReason(args.reason);
  return { userId, opportunity, meeting, now };
}

/**
 * Whether `recordMeetingLoss` would close this deal, without writing, with
 * the refusal it would throw returned as `{ ok: false, code, message }`
 * (decision 17). The reason rules an agent adds (§6.3) are the tool's.
 */
export async function checkMeetingLossAllowed(
  ctx: QueryCtx | MutationCtx,
  actor: CoreActor,
  args: MeetingLossArgs,
): Promise<
  CheckResult<{
    opportunityId: Id<"opportunities">;
    meetingId: Id<"meetings"> | null;
    leadId: Id<"leads">;
  }>
> {
  return await toCheckResult(async () => {
    const { opportunity, meeting } = await checkMeetingLoss(ctx, actor, args);
    return {
      opportunityId: opportunity._id,
      meetingId: meeting?._id ?? null,
      leadId: opportunity.leadId,
    };
  });
}

/**
 * Closes the closer's deal lost, and records the given meeting held. The core
 * of `markAsLost` (docs/plans/closer-assistant.md §6.3). `provenance` tags
 * the loss event (`opportunity.marked_lost`) for an agent.
 */
export async function recordMeetingLoss(
  ctx: MutationCtx,
  actor: CoreActor | null,
  args: MeetingLossArgs,
  provenance: Provenance,
  automation?: AutomationCoreOptions,
): Promise<void> {
  const { opportunityId } = args;
  const guardedActor = await guardActorForOutcome(ctx, actor, args, automation, "closer");
  const { userId, opportunity, meeting, now } = await checkMeetingLoss(ctx, guardedActor, args, automation);
  const reason = automation?.refusal ? RESERVED_LOSS_REASONS.call_refusal : args.reason;

  if (automation && (await loadDealOpenTasks(ctx, opportunity._id)).hasOpenTask) {
    throw new Error("The deal already has a pending task");
  }
  const markHeld = async () => {
    if (!meeting) return;
    await completeMeetingForOutcome(ctx, {
      meetingId: meeting._id,
      opportunityId: opportunity._id,
      toMeetingStatus: "held",
      recordedAt: now,
      extraMeetingPatch: callAttendancePatch(automation),
    });
  };
  if (automation?.system) await markHeld();

  const suggestion = automation && meeting
    ? actor && await liveOutcomeSuggestion(ctx, meeting, now).catch(() => null)
    : args.fromSuggestion && meeting
    ? await resolveSuggestionRef(ctx, {
        tenantId: guardedActor.tenantId,
        meetingId: meeting._id,
        ref: args.fromSuggestion,
      }).catch(() => null)
    : null;

  const normalizedReason = reason?.trim() || undefined;
  await transitionOpportunity(ctx, opportunityId, {
    to: { stage: "closed", outcome: "lost" },
    fields: {
      updatedAt: now,
      lostAt: now,
      lostByUserId: automation?.system ? undefined : userId,
      ...(automation?.system && {
        latestActivityAt: opportunity.latestActivityAt ?? computeLatestActivityAt(opportunity),
      }),
      ...(normalizedReason ? { lostReason: normalizedReason } : {}),
    },
    source: automation?.system ? "system" : "closer",
    actorUserId: automation?.system ? undefined : userId,
    reason: normalizedReason,
    metadata: {
      ...provenanceMetadata(provenance),
      ...(automation && { decisionId: automation.decisionId }),
    },
    occurredAt: now,
  });
  if (meeting) {
    if (!automation?.system) await markHeld();
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
  if (actor && !automation) await noteHumanResult(ctx, opportunityId, actor);
}

export const saveFathomLink = mutation({
  args: {
    meetingId: v.id("meetings"),
    fathomLink: v.string(),
  },
  handler: async (ctx, { meetingId, fathomLink: rawLink }) => {
    const { userId, tenantId, role } = await requireTenantUser(ctx, [
      "closer",
      "tenant_master",
      "tenant_admin",
    ]);

    const { meeting, opportunity } = await loadMeetingContext(
      ctx,
      meetingId,
      tenantId,
    );

    if (role === "closer" && opportunity.assignedCloserId !== userId) {
      throw new Error("Not your meeting");
    }

    const fathomLink = rawLink.trim();
    if (!fathomLink) {
      throw new Error("Fathom link is required");
    }

    const now = Date.now();
    await ctx.db.patch("meetings", meetingId, {
      fathomLink,
      fathomLinkSavedAt: now,
    });

    log.info("meeting.fathom_link_saved", {
      tenantId,
      actor: role === "closer" ? "closer" : "admin",
      meetingId,
      opportunityId: opportunity._id,
      replacedExisting: Boolean(meeting.fathomLink),
    });
  },
});
