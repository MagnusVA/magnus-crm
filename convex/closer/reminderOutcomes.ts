import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { mutation } from "../_generated/server";
import { executeConversion } from "../customers/conversion";
import { emitDomainEvent } from "../lib/domainEvents";
import { toAmountMinor, validateCurrency } from "../lib/formatMoney";
import { assertOverranReviewStillPending } from "../lib/overranReviewGuards";
import { syncCustomerPaymentSummary } from "../lib/paymentHelpers";
import { validateTransition } from "../lib/statusTransitions";
import {
  isActiveOpportunityStatus,
  updateTenantStats,
} from "../lib/tenantStatsHelper";
import { requireTenantUser } from "../requireTenantUser";
import {
  insertPaymentAggregate,
  replaceOpportunityAggregate,
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

  const followUp = await ctx.db.get(followUpId);
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
  if (followUp.status !== "pending") {
    throw new Error("Reminder is not pending");
  }

  const opportunity = await ctx.db.get(followUp.opportunityId);
  if (!opportunity || opportunity.tenantId !== tenantId) {
    throw new Error("Opportunity not found");
  }
  if (opportunity.status === "meeting_overran") {
    await assertOverranReviewStillPending(ctx, opportunity._id);
  }

  return { followUp, opportunity, tenantId, userId };
}

export const logReminderPayment = mutation({
  args: {
    followUpId: v.id("followUps"),
    amount: v.number(),
    currency: v.string(),
    provider: v.string(),
    referenceCode: v.optional(v.string()),
    proofFileId: v.optional(v.id("_storage")),
  },
  handler: async (ctx, args) => {
    const { opportunity, tenantId, userId } = await assertOwnedPendingReminder(
      ctx,
      args.followUpId,
    );

    if (!validateTransition(opportunity.status, "payment_received")) {
      throw new Error(
        `Cannot log payment from status "${opportunity.status}"`,
      );
    }
    if (args.amount <= 0) {
      throw new Error("Payment amount must be positive");
    }

    const currency = validateCurrency(args.currency);
    const provider = args.provider.trim();
    if (!provider) {
      throw new Error("Provider is required");
    }

    const now = Date.now();
    const amountMinor = toAmountMinor(args.amount);
    const meetingId = opportunity.latestMeetingId ?? undefined;
    const previousOpportunityStatus = opportunity.status;

    const paymentId = await ctx.db.insert("paymentRecords", {
      tenantId,
      opportunityId: opportunity._id,
      meetingId,
      closerId: userId,
      amountMinor,
      currency,
      provider,
      referenceCode: normalizeOptionalString(args.referenceCode),
      proofFileId: args.proofFileId ?? undefined,
      status: "recorded",
      statusChangedAt: now,
      recordedAt: now,
      contextType: "opportunity",
      origin: "closer_reminder",
    });
    await insertPaymentAggregate(ctx, paymentId);

    await ctx.db.patch(opportunity._id, {
      status: "payment_received",
      paymentReceivedAt: now,
      updatedAt: now,
    });
    await replaceOpportunityAggregate(ctx, opportunity, opportunity._id);
    await updateTenantStats(ctx, tenantId, {
      activeOpportunities: isActiveOpportunityStatus(previousOpportunityStatus)
        ? -1
        : 0,
      wonDeals: 1,
      totalPaymentRecords: 1,
      totalRevenueMinor: amountMinor,
    });

    await ctx.db.patch(args.followUpId, {
      status: "completed",
      completedAt: now,
      completionOutcome: "payment_received",
    });

    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "payment",
      entityId: paymentId,
      eventType: "payment.recorded",
      source: "closer",
      actorUserId: userId,
      toStatus: "recorded",
      metadata: {
        opportunityId: opportunity._id,
        meetingId,
        followUpId: args.followUpId,
        amountMinor,
        currency,
        origin: "reminder",
      },
      occurredAt: now,
    });
    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "opportunity",
      entityId: opportunity._id,
      eventType: "opportunity.status_changed",
      source: "closer",
      actorUserId: userId,
      fromStatus: previousOpportunityStatus,
      toStatus: "payment_received",
      occurredAt: now,
    });
    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "followUp",
      entityId: args.followUpId,
      eventType: "followUp.completed",
      source: "closer",
      actorUserId: userId,
      fromStatus: "pending",
      toStatus: "completed",
      metadata: {
        outcome: "payment_received",
        origin: "reminder",
      },
      occurredAt: now,
    });

    const customerId = await executeConversion(ctx, {
      tenantId,
      leadId: opportunity.leadId,
      convertedByUserId: userId,
      winningOpportunityId: opportunity._id,
      winningMeetingId: meetingId,
    });

    if (customerId) {
      await ctx.db.patch(paymentId, { customerId });
      await syncCustomerPaymentSummary(ctx, customerId);
    } else {
      const existingCustomer = await ctx.db
        .query("customers")
        .withIndex("by_tenantId_and_leadId", (q) =>
          q.eq("tenantId", tenantId).eq("leadId", opportunity.leadId),
        )
        .first();
      if (existingCustomer) {
        await ctx.db.patch(paymentId, { customerId: existingCustomer._id });
        await syncCustomerPaymentSummary(ctx, existingCustomer._id);
      }
    }

    console.log("[Closer:Reminder] logReminderPayment done", {
      followUpId: args.followUpId,
      paymentId,
      opportunityId: opportunity._id,
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

    if (!validateTransition(opportunity.status, "lost")) {
      throw new Error(`Cannot mark lost from status "${opportunity.status}"`);
    }

    const now = Date.now();
    const trimmedReason = normalizeOptionalString(reason);
    const previousOpportunityStatus = opportunity.status;

    await ctx.db.patch(opportunity._id, {
      status: "lost",
      updatedAt: now,
      lostAt: now,
      lostByUserId: userId,
      ...(trimmedReason ? { lostReason: trimmedReason } : {}),
    });
    await replaceOpportunityAggregate(ctx, opportunity, opportunity._id);
    await updateTenantStats(ctx, tenantId, {
      activeOpportunities: isActiveOpportunityStatus(previousOpportunityStatus)
        ? -1
        : 0,
      lostDeals: 1,
    });

    await ctx.db.patch(followUpId, {
      status: "completed",
      completedAt: now,
      completionOutcome: "lost",
      ...(trimmedReason ? { completionNote: trimmedReason } : {}),
    });

    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "opportunity",
      entityId: opportunity._id,
      eventType: "opportunity.marked_lost",
      source: "closer",
      actorUserId: userId,
      fromStatus: previousOpportunityStatus,
      toStatus: "lost",
      reason: trimmedReason,
      metadata: {
        followUpId,
        origin: "reminder",
      },
      occurredAt: now,
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

    console.log("[Closer:Reminder] markReminderLost done", {
      followUpId,
      opportunityId: opportunity._id,
      hasReason: Boolean(trimmedReason),
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
      if (
        opportunity.status !== "follow_up_scheduled" &&
        opportunity.status !== "meeting_overran"
      ) {
        throw new Error(
          `Cannot schedule a new reminder from status "${opportunity.status}"`,
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
      if (!validateTransition(opportunity.status, "lost")) {
        throw new Error(`Cannot mark lost from status "${opportunity.status}"`);
      }
      const previousOpportunityStatus = opportunity.status;
      const lostReason = trimmedNote ?? "No response to outreach";

      await ctx.db.patch(opportunity._id, {
        status: "lost",
        updatedAt: now,
        lostAt: now,
        lostByUserId: userId,
        lostReason,
      });
      await replaceOpportunityAggregate(ctx, opportunity, opportunity._id);
      await updateTenantStats(ctx, tenantId, {
        activeOpportunities: isActiveOpportunityStatus(previousOpportunityStatus)
          ? -1
          : 0,
        lostDeals: 1,
      });
      await emitDomainEvent(ctx, {
        tenantId,
        entityType: "opportunity",
        entityId: opportunity._id,
        eventType: "opportunity.marked_lost",
        source: "closer",
        actorUserId: userId,
        fromStatus: previousOpportunityStatus,
        toStatus: "lost",
        reason: lostReason,
        metadata: {
          followUpId,
          origin: "reminder",
          trigger: outcomeTag,
        },
        occurredAt: now,
      });
    }

    await ctx.db.patch(followUpId, {
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

    console.log("[Closer:Reminder] markReminderNoResponse done", {
      followUpId,
      nextStep,
      newFollowUpId,
      opportunityId: opportunity._id,
    });

    return { newFollowUpId };
  },
});
