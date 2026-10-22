import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { mutation } from "../_generated/server";
import { recordCloserReassignment } from "../lib/attribution/dealAttributions";
import { emitDomainEvent } from "../lib/domainEvents";
import { syncPersonEnrollments } from "../lib/enrollments";
import { toAmountMinor, validateCurrency } from "../lib/formatMoney";
import { recordPayment } from "../lib/leadLifecycle";
import { transitionOpportunity } from "../lib/opportunityActivity";
import {
  assertPaymentRow,
  resolveProgramForWrite,
  type CommissionableOrigin,
} from "../lib/paymentHelpers";
import { paymentTypeValidator, resolvePaymentType } from "../lib/paymentTypes";
import { setSoldProgramCaches } from "../lib/soldProgramCache";
import { applyPaymentStatsDelta } from "../lib/tenantStatsHelper";
import {
  canMarkLost,
  canTakePayment,
  describeDealState,
  isFollowUpWithoutRescheduleLink,
  loadDealTasks,
} from "../opportunities/dealGuards";
import { requireTenantUser } from "../requireTenantUser";
import {
  insertPaymentAggregate,
} from "../reporting/writeHooks";

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

async function assertOwnedPendingReminder(
  ctx: MutationCtx,
  followUpId: Id<"followUps">,
): Promise<{
  followUp: Doc<"followUps">;
  opportunity: Doc<"opportunities">;
  tenantId: Id<"tenants">;
  userId: Id<"users">;
}> {
  const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);

  const followUp = await ctx.db.get("followUps", followUpId);
  if (!followUp) {
    throw new Error("Reminder not found");
  }
  if (followUp.tenantId !== tenantId) {
    throw new Error("Access denied");
  }
  if (followUp.closerId !== userId) {
    throw new Error("Not your reminder");
  }
  if (followUp.type !== "manual_reminder") {
    throw new Error("Only manual reminders can be resolved on this page");
  }
  if (followUp.reason === "stale_opportunity_nudge") {
    throw new Error(
      "Stale opportunity nudges must be resolved from the opportunity detail page.",
    );
  }
  if (followUp.status !== "pending") {
    throw new Error("Reminder is not pending");
  }

  const opportunity = await ctx.db.get("opportunities", followUp.opportunityId);
  if (!opportunity || opportunity.tenantId !== tenantId) {
    throw new Error("Opportunity not found");
  }
  return { followUp, opportunity, tenantId, userId };
}

async function requirePendingReminderForPayment(
  ctx: MutationCtx,
  followUpId: Id<"followUps">,
): Promise<{
  followUp: Doc<"followUps">;
  opportunity: Doc<"opportunities">;
  tenantId: Id<"tenants">;
  userId: Id<"users">;
  role: "closer" | "tenant_master" | "tenant_admin";
}> {
  type ReminderPaymentRole = "closer" | "tenant_master" | "tenant_admin";
  const { userId, tenantId, role: authorizedRole } = await requireTenantUser(ctx, [
    "closer",
    "tenant_master",
    "tenant_admin",
  ]);
  const role = authorizedRole as ReminderPaymentRole;

  const followUp = await ctx.db.get("followUps", followUpId);
  if (!followUp) {
    throw new Error("Reminder not found");
  }
  if (followUp.tenantId !== tenantId) {
    throw new Error("Access denied");
  }
  if (role === "closer" && followUp.closerId !== userId) {
    throw new Error("Not your reminder");
  }
  if (followUp.type !== "manual_reminder") {
    throw new Error("Only manual reminders can be resolved on this page");
  }
  if (followUp.reason === "stale_opportunity_nudge") {
    throw new Error(
      "Stale opportunity nudges must be resolved from the opportunity detail page.",
    );
  }
  if (followUp.status !== "pending") {
    throw new Error("Reminder is not pending");
  }

  const opportunity = await ctx.db.get("opportunities", followUp.opportunityId);
  if (!opportunity || opportunity.tenantId !== tenantId) {
    throw new Error("Opportunity not found");
  }
  return { followUp, opportunity, tenantId, userId, role };
}

export const logReminderPayment = mutation({
  args: {
    followUpId: v.id("followUps"),
    amount: v.number(),
    currency: v.string(),
    programId: v.id("tenantPrograms"),
    paymentType: paymentTypeValidator,
    proofFileId: v.optional(v.id("_storage")),
  },
  handler: async (ctx, args) => {
    const { followUp, opportunity, tenantId, userId, role } =
      await requirePendingReminderForPayment(
      ctx,
      args.followUpId,
    );

    if (!canTakePayment(opportunity, await loadDealTasks(ctx, opportunity._id))) {
      throw new Error(
        `Cannot log payment: the deal is "${describeDealState(opportunity)}"`,
      );
    }
    if (args.amount <= 0) {
      throw new Error("Payment amount must be positive");
    }

    const currency = validateCurrency(args.currency);
    const program = await resolveProgramForWrite(ctx, tenantId, args.programId);
    const paymentType = resolvePaymentType(args.paymentType);
    const now = Date.now();
    const amountMinor = toAmountMinor(args.amount);
    const meetingId = opportunity.latestMeetingId ?? undefined;
    const attributedCloserId =
      role === "closer" ? userId : followUp.closerId;
    const origin: CommissionableOrigin =
      role === "closer" ? "closer_reminder" : "admin_reminder";

    assertPaymentRow({
      tenantId,
      commissionable: true,
      attributedCloserId,
      recordedByUserId: userId,
      origin,
      opportunityId: opportunity._id,
      programId: program._id,
      paymentType,
    });

    const paymentId = await ctx.db.insert("paymentRecords", {
      tenantId,
      opportunityId: opportunity._id,
      meetingId,
      attributedCloserId,
      recordedByUserId: userId,
      commissionable: true,
      amountMinor,
      currency,
      programId: program._id,
      programName: program.name,
      paymentType,
      proofFileId: args.proofFileId ?? undefined,
      status: "recorded",
      statusChangedAt: now,
      recordedAt: now,
      origin,
    });
    await recordPayment(ctx, paymentId);
    await insertPaymentAggregate(ctx, paymentId);
    await setSoldProgramCaches(ctx, {
      tenantId,
      opportunityId: opportunity._id,
      meetingId,
      programId: program._id,
      programName: program.name,
    });

    const reassignsCloser =
      role !== "closer" && opportunity.assignedCloserId !== followUp.closerId;
    await transitionOpportunity(ctx, opportunity._id, {
      to: { stage: "closed", outcome: "won" },
      fields: {
        ...(reassignsCloser ? { assignedCloserId: followUp.closerId } : {}),
        paymentReceivedAt: now,
        updatedAt: now,
      },
      source: role === "closer" ? "closer" : "admin",
      actorUserId: userId,
      metadata: { paymentId, followUpId: args.followUpId },
      occurredAt: now,
    });
    if (reassignsCloser) {
      // The deal moves to the reminder's closer: a reassignment of the deal,
      // not of a meeting (docs/plans/phase-3-attribution.md §4.6).
      await recordCloserReassignment(ctx, {
        tenantId,
        opportunityId: opportunity._id,
        toUserId: followUp.closerId,
        fromUserId: opportunity.assignedCloserId,
        at: now,
      });
    }
    await applyPaymentStatsDelta(ctx, tenantId, {
      commissionable: true,
      paymentType,
      amountMinorDelta: amountMinor,
    });

    await ctx.db.patch("followUps", args.followUpId, {
      status: "completed",
      completedAt: now,
      completionOutcome: "payment_received",
    });

    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "payment",
      entityId: paymentId,
      eventType: "payment.recorded",
      source: role === "closer" ? "closer" : "admin",
      actorUserId: userId,
      toStatus: "recorded",
      metadata: {
        opportunityId: opportunity._id,
        meetingId,
        followUpId: args.followUpId,
        amountMinor,
        currency,
        programId: program._id,
        programName: program.name,
        paymentType,
        commissionable: true,
        attributedCloserId,
        recordedByUserId: userId,
        origin,
      },
      occurredAt: now,
    });
    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "followUp",
      entityId: args.followUpId,
      eventType: "followUp.completed",
      source: role === "closer" ? "closer" : "admin",
      actorUserId: userId,
      fromStatus: "pending",
      toStatus: "completed",
      metadata: {
        outcome: "payment_received",
        origin,
      },
      occurredAt: now,
    });

    // The person's enrollments follow their payments, and their first one
    // makes them a customer (docs/plans/phase-4-customers.md §4.1, §4.2).
    await syncPersonEnrollments(ctx, {
      tenantId,
      leadId: opportunity.leadId,
      now,
      source: role === "closer" ? "closer" : "admin",
      actorUserId: userId,
    });

    return paymentId;
  },
});

export const markReminderLost = mutation({
  args: {
    followUpId: v.id("followUps"),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, { followUpId, reason }) => {
    const { opportunity, tenantId, userId } = await assertOwnedPendingReminder(
      ctx,
      followUpId,
    );

    if (!canMarkLost(opportunity, await loadDealTasks(ctx, opportunity._id))) {
      throw new Error(`Cannot mark lost: the deal is "${describeDealState(opportunity)}"`);
    }

    const now = Date.now();
    const trimmedReason = normalizeOptionalString(reason);

    await transitionOpportunity(ctx, opportunity._id, {
      to: { stage: "closed", outcome: "lost" },
      fields: {
        updatedAt: now,
        lostAt: now,
        lostByUserId: userId,
        ...(trimmedReason ? { lostReason: trimmedReason } : {}),
      },
      source: "closer",
      actorUserId: userId,
      reason: trimmedReason,
      metadata: {
        followUpId,
        origin: "reminder",
      },
      occurredAt: now,
    });

    await ctx.db.patch("followUps", followUpId, {
      status: "completed",
      completedAt: now,
      completionOutcome: "lost",
      ...(trimmedReason ? { completionNote: trimmedReason } : {}),
    });
    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "followUp",
      entityId: followUpId,
      eventType: "followUp.completed",
      source: "closer",
      actorUserId: userId,
      fromStatus: "pending",
      toStatus: "completed",
      metadata: {
        outcome: "lost",
        origin: "reminder",
      },
      occurredAt: now,
    });
  },
});

export const markReminderNoResponse = mutation({
  args: {
    followUpId: v.id("followUps"),
    nextStep: v.union(
      v.literal("schedule_new"),
      v.literal("give_up"),
      v.literal("close_only"),
    ),
    note: v.optional(v.string()),
    newReminder: v.optional(
      v.object({
        contactMethod: v.union(v.literal("call"), v.literal("text")),
        reminderScheduledAt: v.number(),
        reminderNote: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, { followUpId, nextStep, note, newReminder }) => {
    const { opportunity, tenantId, userId } = await assertOwnedPendingReminder(
      ctx,
      followUpId,
    );

    const now = Date.now();
    const trimmedNote = normalizeOptionalString(note);
    const outcomeTag =
      nextStep === "schedule_new"
        ? "no_response_rescheduled"
        : nextStep === "give_up"
          ? "no_response_given_up"
          : "no_response_close_only";

    if (nextStep === "schedule_new") {
      if (!isFollowUpWithoutRescheduleLink(opportunity, await loadDealTasks(ctx, opportunity._id))) {
        throw new Error(
          `Cannot schedule a new reminder: the deal is "${describeDealState(opportunity)}"`,
        );
      }
      if (!newReminder) {
        throw new Error("newReminder required when nextStep = schedule_new");
      }
      if (newReminder.reminderScheduledAt <= now) {
        throw new Error("Reminder time must be in the future");
      }
    }

    if (nextStep === "give_up") {
      if (!canMarkLost(opportunity, await loadDealTasks(ctx, opportunity._id))) {
        throw new Error(`Cannot mark lost: the deal is "${describeDealState(opportunity)}"`);
      }
      const lostReason = trimmedNote ?? "No response to outreach";

      await transitionOpportunity(ctx, opportunity._id, {
        to: { stage: "closed", outcome: "lost" },
        fields: {
          updatedAt: now,
          lostAt: now,
          lostByUserId: userId,
          lostReason,
        },
        source: "closer",
        actorUserId: userId,
        reason: lostReason,
        metadata: {
          followUpId,
          origin: "reminder",
          trigger: outcomeTag,
        },
        occurredAt: now,
      });
    }

    await ctx.db.patch("followUps", followUpId, {
      status: "completed",
      completedAt: now,
      completionOutcome: outcomeTag,
      ...(trimmedNote ? { completionNote: trimmedNote } : {}),
    });
    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "followUp",
      entityId: followUpId,
      eventType: "followUp.completed",
      source: "closer",
      actorUserId: userId,
      fromStatus: "pending",
      toStatus: "completed",
      metadata: {
        outcome: outcomeTag,
        origin: "reminder",
      },
      occurredAt: now,
    });

    let newFollowUpId: Id<"followUps"> | null = null;
    if (nextStep === "schedule_new") {
      const nextReminder = newReminder!;
      newFollowUpId = await ctx.db.insert("followUps", {
        tenantId,
        opportunityId: opportunity._id,
        leadId: opportunity.leadId,
        closerId: userId,
        type: "manual_reminder",
        contactMethod: nextReminder.contactMethod,
        reminderScheduledAt: nextReminder.reminderScheduledAt,
        reminderNote: normalizeOptionalString(nextReminder.reminderNote),
        reason: "closer_initiated",
        status: "pending",
        createdAt: now,
        createdByUserId: userId,
        createdSource: "closer",
      });

      await emitDomainEvent(ctx, {
        tenantId,
        entityType: "followUp",
        entityId: newFollowUpId,
        eventType: "followUp.created",
        source: "closer",
        actorUserId: userId,
        toStatus: "pending",
        metadata: {
          opportunityId: opportunity._id,
          type: "manual_reminder",
          origin: "reminder_chain",
          previousFollowUpId: followUpId,
        },
        occurredAt: now,
      });
    }

    return { newFollowUpId };
  },
});
